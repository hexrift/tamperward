#!/usr/bin/env bash
# Round-4 agent isolation jail (freeze-checklist item: mount/PID/capability
# separation, applied SYMMETRICALLY to both arms). Layers a mount + PID namespace
# and a capability drop on top of the network namespace, then execs the agent so
# that from inside the jail:
#   - the CANDIDATE TREE is writable (the agent's workspace);
#   - the CONTROL PLANE is invisible — oracle, result ledger, adjudicator/runner,
#     and the parent runtime are masked (TB_JAIL_MASK);
#   - HOST PROCESSES are invisible (PID namespace);
#   - the Docker socket and ALL UNRELATED credential/cloud/SSH/token material are
#     masked (DEVIATIONS "Credential isolation" point 8);
#   - the pinned Tamperward artefact is exposed READ-ONLY (TB_JAIL_RO), so a tool
#     cannot replace the frozen package;
#   - all capabilities are dropped for the agent exec.
# The ACTIVE Claude credential is deliberately NOT masked — the agent is the
# authenticated CLI and needs it; that exposure is symmetric across both arms and
# disclosed (see DEVIATIONS). The jail is identical in both arms; only the hooks
# deployed into the workspace differ, so isolation adds no asymmetry.
#
# Usage: agent-jail4.sh <netns|-> -- <cmd...>
#   <netns>   network namespace to enter (from net-jail.sh), or "-" for none
# Env:
#   TB_JAIL_MASK  colon-separated control-plane paths to mask (dirs->empty ro tmpfs,
#                 files->/dev/null). Masked in addition to the fixed unrelated-
#                 credential list below.
#   TB_JAIL_RO    colon-separated paths to expose read-only (the pinned artefact).
#   TB_JAIL_PROBE if set, run the internal boundary self-probe instead of a cmd
#                 and print one line per checked surface (used by the selftest).
set -uo pipefail
NETNS="${1:?netns or -}"; shift
[ "${1:-}" = "--" ] && shift || { echo "agent-jail4: expected -- before the command" >&2; exit 2; }

# Fixed masks: unrelated credentials, cloud config, SSH, docker, other tokens.
# NOT the active Claude credential (~/.claude*, disclosed exposure).
UNRELATED=(
  "$HOME/.aws" "$HOME/.config/gcloud" "$HOME/.config/gh" "$HOME/.kube"
  "$HOME/.ssh" "$HOME/.docker" "$HOME/.npmrc" "$HOME/.git-credentials"
  "$HOME/.netrc" "$HOME/.config/gh/hosts.yml"
  /var/run/docker.sock /run/docker.sock /run/secrets
)

NETRUN=(); [ "$NETNS" != "-" ] && NETRUN=(ip netns exec "$NETNS")

# The masking runs inside the new mount namespace (needs CAP_SYS_ADMIN); caps are
# dropped only for the final agent exec, after all mounts are in place.
MASK_LIST="${TB_JAIL_MASK:-}"; RO_LIST="${TB_JAIL_RO:-}"
export MASK_LIST RO_LIST
printf '%s\0' "${UNRELATED[@]}" > /tmp/tb-jail-unrelated.$$ 2>/dev/null || true

exec "${NETRUN[@]}" unshare --pid --mount --fork --mount-proc bash -euc '
  # private mounts so nothing propagates back to the host
  mount --make-rprivate / 2>/dev/null || true
  mask() { # <path>
    [ -e "$1" ] || return 0
    if [ -d "$1" ]; then mount -t tmpfs -o ro,mode=000,nosuid,nodev,noexec tmpfs "$1" 2>/dev/null || true
    else mount --bind /dev/null "$1" 2>/dev/null || true; fi
  }
  # unrelated credentials / cloud / ssh / docker / tokens
  while IFS= read -r -d "" p; do mask "$p"; done < "/tmp/tb-jail-unrelated.'"$$"'" 2>/dev/null
  rm -f "/tmp/tb-jail-unrelated.'"$$"'" 2>/dev/null || true
  # control-plane paths (oracle, ledger, adjudicator/runner, parent runtime)
  IFS=: ; for p in $MASK_LIST; do [ -n "$p" ] && mask "$p"; done ; unset IFS
  # pinned artefact read-only (bind onto itself, remount ro)
  IFS=: ; for p in $RO_LIST; do
    [ -n "$p" ] && [ -e "$p" ] && { mount --bind "$p" "$p" 2>/dev/null && mount -o remount,ro,bind "$p" 2>/dev/null; }
  done ; unset IFS

  if [ -n "${TB_JAIL_PROBE:-}" ]; then
    # boundary self-probe: report reachability of each sensitive surface
    echo "host-procs $(ps -e --no-headers 2>/dev/null | wc -l)"
    echo -n "docker-sock "; { [ -S /var/run/docker.sock ] && head -c1 </var/run/docker.sock >/dev/null 2>&1 && echo REACHABLE || echo masked; }
    echo -n "ssh "; { [ -r "$HOME/.ssh" ] && ls "$HOME/.ssh" >/dev/null 2>&1 && [ -n "$(ls -A "$HOME/.ssh" 2>/dev/null)" ] && echo REACHABLE || echo masked; }
    echo -n "aws "; { [ -n "$(ls -A "$HOME/.aws" 2>/dev/null)" ] && echo REACHABLE || echo masked; }
    # Reachability differs by kind: a masked DIRECTORY is an empty ro tmpfs, a
    # masked FILE is a bind of /dev/null. `ls -A` on a regular file prints its own
    # name, so using it for both reported every correctly masked FILE as
    # REACHABLE; content visibility is the right test for a file.
    IFS=: ; for p in $MASK_LIST; do [ -n "$p" ] || continue
      echo -n "ctrl:$p "
      if [ -d "$p" ]; then [ -n "$(ls -A "$p" 2>/dev/null)" ] && echo REACHABLE || echo masked
      elif [ -e "$p" ]; then [ -s "$p" ] && echo REACHABLE || echo masked
      else echo masked; fi
    done ; unset IFS
    # /proc/*/root escape: the REAL test is whether a masked control-plane path is
    # reachable through ANY process root (a different mount view leaking the
    # unmasked path). All jail processes share the jail mount ns, and host procs
    # are hidden by the PID ns, so a masked path must stay masked via /proc too.
    first_ctrl=""; IFS=: ; for p in $MASK_LIST; do [ -n "$p" ] && { first_ctrl="$p"; break; }; done ; unset IFS
    echo -n "proc-root-escape "
    esc=no
    if [ -n "$first_ctrl" ]; then
      for pr in /proc/*/root; do
        cand="$pr$first_ctrl"
        if [ -d "$cand" ]; then [ -n "$(ls -A "$cand" 2>/dev/null)" ] && { esc=yes; break; }
        elif [ -e "$cand" ]; then [ -s "$cand" ] && { esc=yes; break; }; fi
      done
    fi
    echo "$esc"   # yes = a masked path leaked through /proc; no = contained
    # caps AS THE AGENT GETS THEM (after the setpriv drop the real exec applies)
    echo -n "agent-caps "; setpriv --bounding-set=-all --inh-caps=-all grep CapEff /proc/self/status 2>/dev/null | awk "{print \$2}"
    exit 0
  fi

  # drop ALL capabilities for the agent exec (after masking, which needed them)
  exec setpriv --bounding-set=-all --inh-caps=-all -- "$@"
' bash "$@"
