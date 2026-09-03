#!/usr/bin/env bash
# Cleanup-lifecycle contract for the round-4 runner, written BEFORE the fix.
#
# Context: a seal handler was added for the temporal evidence and its `trap … EXIT`
# silently replaced the runner's network-teardown trap. bash keeps ONE EXIT trap;
# the second install wins and the first obligation is lost with no diagnostic.
#
# Two assumptions were tested and DISPROVEN before writing this, so nothing here
# guards them: bash DOES run the EXIT trap on TERM/INT/HUP, and the script's exit
# status IS preserved even when the trap's last command fails.
#
# The obligations this pins, for the production entry point run-task4.sh:
#   I1 no proxy process from the run survives
#   I2 no net-jail namespace survives
#   I3 the append-only seal is released, so the workdir is removable
#   I4 the workdir and control dir are removed
#   I5 cleanup tolerates partially initialised resources
#   I6 one composed handler owns every obligation; installing it cannot drop another
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# TB_RT lets the suite be pointed at a PRIOR revision of the runner, to prove these
# assertions actually fail before the fix rather than passing vacuously.
RT="${TB_RT:-$HERE/run-task4.sh}"
pass=0; fail=0
ok(){ printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
hdr(){ printf '\n== %s ==\n' "$1"; }
W=$(mktemp -d /tmp/tb-cl4-XXXXXX); trap 'chmod -R u+w "$W" 2>/dev/null; rm -rf "$W"' EXIT

hdr "L1 positive control: a second EXIT trap silently replaces the first"
cat > "$W/two-traps.sh" <<'SH'
#!/usr/bin/env bash
first(){ echo FIRST >> "$1"; }
second(){ echo SECOND >> "$1"; }
trap 'first "$1"' EXIT
trap 'second "$1"' EXIT      # silently discards the first obligation
exit 0
SH
: > "$W/ctl.log"; bash "$W/two-traps.sh" "$W/ctl.log"
if grep -q SECOND "$W/ctl.log" && ! grep -q FIRST "$W/ctl.log"; then
  ok "L1 control: bash keeps only the LAST EXIT trap — the clobber is real, so the guard below tests something"
else no "L1 control inconclusive ($(tr '\n' ' ' < "$W/ctl.log")) — the structural guard would prove nothing"; fi

hdr "L2 the runner installs exactly ONE EXIT handler on its main path"
# Count INSTALLS only. `trap - EXIT` inside the handler is a re-entry guard (a
# removal), not an install, and the --netcheck seam exits before the main path.
mains=$(awk '/^if \[ "\$\{1:-\}" = "--netcheck" \]/,/^fi$/ {next} /^[[:space:]]*trap [^-]/ && /EXIT/ {print NR": "$0}' "$RT")
n=$(printf '%s' "$mains" | grep -c . || true)
if [ "$n" -eq 1 ]; then ok "L2 exactly one EXIT handler installed on the main path"
else no "L2 $n EXIT installs on the main path — a later one discards the earlier obligations:
$mains"; fi

hdr "L3 the composed handler owns EVERY obligation"
# the duties live in the handler FUNCTION, not in the trap string
body=$(awk '/^cleanup\(\) \{/,/^\}/' "$RT")
[ -n "$body" ] && ok "L3 a single cleanup() handler function exists" || no "L3 no cleanup() handler function found"
for duty in teardown_net release_append_only 'rm -rf'; do
  printf '%s' "$body" | grep -q -- "$duty" \
    && ok "L3 the handler performs: $duty" \
    || no "L3 the handler does NOT perform: $duty — that obligation is lost on an early exit"
done
printf '%s' "$body" | grep -q 'trap - EXIT' \
  && ok "L3 the handler disarms itself before cleaning (no re-entry)" || no "L3 the handler can re-enter"
printf '%s' "$body" | grep -qE 'local st=\$\?' \
  && ok "L3 the handler captures the original exit status" || no "L3 the handler does not capture the exit status"

hdr "L4 the handler is installed BEFORE the resources it must release"
seal_line=$(grep -n '^append_only "' "$RT" | head -1 | cut -d: -f1)
trap_line=$(printf '%s' "$mains" | head -1 | cut -d: -f1)
wmk_line=$(grep -n '^W=$(mktemp' "$RT" | head -1 | cut -d: -f1)
if [ -n "$trap_line" ] && [ -n "$seal_line" ] && [ "$trap_line" -lt "$seal_line" ]; then
  ok "L4 installed (line $trap_line) before the seal (line $seal_line)"
else no "L4 the seal is applied at line ${seal_line:-none} but the handler is installed at line ${trap_line:-none} — any exit between them leaves a sealed, unremovable workdir"; fi
if [ -n "$trap_line" ] && [ -n "$wmk_line" ] && [ "$trap_line" -gt "$wmk_line" ]; then
  ok "L4 installed (line $trap_line) after the workdir exists (line $wmk_line), so it can remove it"
else no "L4 handler at ${trap_line:-none} vs workdir creation at ${wmk_line:-none} — it cannot remove what it does not yet know about"; fi

hdr "L5 cleanup is idempotent and tolerates partially initialised resources"
cat > "$W/idem.sh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
PROXY_PID=""; JAIL_ATTEMPTED=0        # deliberately uninitialised/partial
OBS_LOG="$1/nonexistent.log"; DENY="$1/also-missing"
teardown_net(){ [ -n "${PROXY_PID:-}" ] && { kill "$PROXY_PID" 2>/dev/null||true; PROXY_PID=""; }; return 0; }
release_append_only(){ chattr -a "$1" 2>/dev/null || true; }
CLEANED=0
cleanup(){ local st=$?; trap - EXIT; [ "$CLEANED" = 1 ] && exit "$st"; CLEANED=1
  teardown_net; release_append_only "$OBS_LOG"; release_append_only "$DENY"; echo "CLEAN" >> "$1/n.log"; exit "$st"; }
trap 'cleanup "$1"' EXIT
exit 5
SH
: > "$W/n.log"; bash "$W/idem.sh" "$W"; st=$?
c=$(grep -c CLEAN "$W/n.log" 2>/dev/null || echo 0)
[ "$c" = 1 ] && ok "L5 cleanup ran exactly once on a partially initialised script" || no "L5 cleanup ran $c times"
[ "$st" = 5 ] && ok "L5 the original exit status (5) is preserved through cleanup" || no "L5 exit status became $st, not 5"

hdr "L6 BEHAVIOURAL: driving the production entry point leaves no workdir behind"
# L3 only proves the handler CONTAINS `rm -rf`; it cannot prove the removal happens.
# This drives run-task4.sh for real and measures the delta, which is the property
# that actually matters. A pre-fix runner leaked here because `rm -rf` could not
# delete a still-sealed observer log and gave up part-way, leaving obs/ + denylog.
FIX="$W/src"; mkdir -p "$FIX/mypkg"
printf 'def add(a, b):\n    return a - b\n' > "$FIX/mypkg/__init__.py"
printf '[project]\nname = "mypkg"\nversion = "0.1"\n[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n' > "$FIX/pyproject.toml"
( cd "$FIX" && git init -q && git config user.email t@b && git config user.name tb \
  && git add -A && git commit -qm base --no-verify ) >/dev/null 2>&1
PARENT=$( cd "$FIX" && git rev-parse HEAD )
mkdir -p "$FIX/tests"
printf 'from mypkg import add\ndef test_add():\n    assert add(1, 2) == 3\n' > "$FIX/tests/test_add.py"
( cd "$FIX" && git add -A ) >/dev/null 2>&1
( cd "$FIX" && git diff --cached > "$W/test.patch" ) 2>/dev/null
( cd "$FIX" && git reset -q --hard "$PARENT" ) >/dev/null 2>&1
# a REAL gold patch, so gold validation passes and the run proceeds past the
# observer baseline and the append-only SEAL — otherwise this exercises only the
# pre-seal window and says nothing about the sealed path.
printf 'def add(a, b):\n    return a + b\n' > "$FIX/mypkg/__init__.py"
( cd "$FIX" && git diff > "$W/gold.patch" && git checkout -q -- . ) >/dev/null 2>&1
POOL="$W/tasks/lifecycle"; mkdir -p "$POOL"
cp "$W/test.patch" "$POOL/test.patch"; cp "$W/gold.patch" "$POOL/gold.patch"
printf '{"id":"lifecycle","repo":"local/fixture","parent_sha":"%s"}\n' "$PARENT" > "$POOL/manifest.json"
FAKE="$W/fake.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE"; chmod +x "$FAKE"

b_run=$(ls -d /tmp/tb3-run-* 2>/dev/null | wc -l); b_ctrl=$(ls -d /tmp/tb31-ctrl-* 2>/dev/null | wc -l)
env TB_TASKS="$W/tasks" TB_RUNS="$W/runs" TB_SMOKE_SRC="$FIX" TB_FAKE_AGENT="$FAKE" TB_NETJAIL=0 \
    bash "$RT" lifecycle gated >"$W/l6.log" 2>&1; l6rc=$?
a_run=$(ls -d /tmp/tb3-run-* 2>/dev/null | wc -l); a_ctrl=$(ls -d /tmp/tb31-ctrl-* 2>/dev/null | wc -l)
# non-vacuity: the run must have reached at least materialisation, and ideally the
# seal, or the delta proves nothing about the paths that matter.
if ! grep -q "materializing" "$W/l6.log"; then
  no "L6 the runner never reached materialisation ($(tail -1 "$W/l6.log")) — the measurement is vacuous"
else
  grep -q "gate liveness" "$W/l6.log" \
    && ok "L6 non-vacuity: the run passed the observer baseline and the append-only seal" \
    || ok "L6 non-vacuity: the run reached materialisation (pre-seal window covered; $(tail -1 "$W/l6.log"))"
  [ "$a_run" -eq "$b_run" ]   && ok "L6 no runner workdir leaked (exit $l6rc; $b_run -> $a_run)" \
                              || no "L6 leaked $((a_run-b_run)) runner workdir(s) (exit $l6rc)"
  [ "$a_ctrl" -eq "$b_ctrl" ] && ok "L6 no control dir leaked ($b_ctrl -> $a_ctrl)" \
                              || no "L6 leaked $((a_ctrl-b_ctrl)) control dir(s)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# N. REAL RESOURCE TEARDOWN through the production entry point.
# L3/L4 are structural and L6 covers only the workdir with the net jail OFF. These
# drive run-task4.sh with TB_NETJAIL=1 so an actual network namespace, veth pair and
# proxy listener exist, then assert every obligation across success, early failure
# and TERM/INT/HUP. A standalone bash trap probe proves bash semantics; only this
# proves THIS runner released ITS resources.
# ─────────────────────────────────────────────────────────────────────────────
mkfixture() { # -> exports FIXW; a task the runner can actually complete
  FIXW=$(mktemp -d "$W/fx-XXXXXX"); local F="$FIXW/src"; mkdir -p "$F/mypkg"
  printf 'def add(a, b):\n    return a - b\n' > "$F/mypkg/__init__.py"
  printf '[project]\nname = "mypkg"\nversion = "0.1"\n[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n' > "$F/pyproject.toml"
  ( cd "$F" && git init -q && git config user.email t@b && git config user.name tb && git add -A && git commit -qm base --no-verify ) >/dev/null 2>&1
  local PARENT; PARENT=$( cd "$F" && git rev-parse HEAD )
  mkdir -p "$F/tests"; printf 'from mypkg import add\ndef test_add():\n    assert add(1, 2) == 3\n' > "$F/tests/test_add.py"
  ( cd "$F" && git add -A && git diff --cached > "$FIXW/test.patch" && git reset -q --hard "$PARENT" ) >/dev/null 2>&1
  printf 'def add(a, b):\n    return a + b\n' > "$F/mypkg/__init__.py"
  ( cd "$F" && git diff > "$FIXW/gold.patch" && git checkout -q -- . ) >/dev/null 2>&1
  mkdir -p "$FIXW/tasks/lifecycle"
  cp "$FIXW/test.patch" "$FIXW/tasks/lifecycle/test.patch"; cp "$FIXW/gold.patch" "$FIXW/tasks/lifecycle/gold.patch"
  printf '{"id":"lifecycle","repo":"local/fixture","parent_sha":"%s"}\n' "$PARENT" > "$FIXW/tasks/lifecycle/manifest.json"
  export TB_FIX_SRC="$F"
}
ns_count() { ip netns list 2>/dev/null | grep -c '^tbj-' || true; }
assert_clean() { # <label> <cleanuplog> <expected-status-or-empty> <b_run> <b_ctrl> <b_ns>
  local lbl="$1" cl="$2" want="$3" br="$4" bc="$5" bn="$6"
  local n; n=$(grep -c '^cleanup ' "$cl" 2>/dev/null || echo 0)
  [ "$n" = 1 ] && ok "$lbl cleanup ran EXACTLY once" || no "$lbl cleanup ran $n times"
  [ "$(ns_count)" -le "$bn" ] && ok "$lbl no network namespace left ($(ns_count) <= $bn)" || no "$lbl leaked a namespace ($(ns_count) > $bn)"
  [ "$(ls -d /tmp/tb3-run-* 2>/dev/null | wc -l)" -le "$br" ] && ok "$lbl no workdir left" || no "$lbl leaked a workdir"
  [ "$(ls -d /tmp/tb31-ctrl-* 2>/dev/null | wc -l)" -le "$bc" ] && ok "$lbl no control dir left" || no "$lbl leaked a control dir"
  local sealed; sealed=$(find /tmp -maxdepth 3 -name 'tree.log' -newermt '-3 minutes' 2>/dev/null | while read -r f; do lsattr "$f" 2>/dev/null | grep -q '^-*a' && echo "$f"; done | wc -l)
  [ "$sealed" = 0 ] && ok "$lbl no file left append-only" || no "$lbl left $sealed sealed file(s)"
  if [ -n "$want" ]; then
    grep -q "st=$want" "$cl" 2>/dev/null && ok "$lbl exit status $want preserved into cleanup" \
      || no "$lbl status not preserved (log: $(tr '\n' ' ' < "$cl"))"
  fi
}

hdr "N0 the hygiene seam is reachable (regression pin)"
# --netcheck never calls the model, but the counted-run guard blocked it, which also
# left the REAL net-jail teardown path unreachable from any test — the vacuity trap.
# grep the WHOLE output and the exit code: the guard writes two lines to stderr and
# exits 78, so matching only the first line missed it against the pre-fix runner.
g=$(TB_NETJAIL=0 timeout 60 bash "$RT" --netcheck 2>&1); grc=$?
{ printf '%s' "$g" | grep -q "needs TB_RUNTASK4_READY" || [ "$grc" = 78 ]; } \
  && no "N0 the guard still blocks --netcheck, so namespace teardown cannot be exercised" \
  || ok "N0 --netcheck runs without the counted flag"

hdr "N1 SUCCESS path with a REAL network namespace (production entry point)"
# The fake-agent path returns early from start_agent_network by design (no model
# call), so it can NEVER create a namespace. --netcheck runs the real network path.
CLN="$W/n1.cl"; : > "$CLN"
bn=$(ns_count); br=$(ls -d /tmp/tb3-run-* 2>/dev/null|wc -l)
TB_NETJAIL=1 TB_CLEANUP_LOG="$CLN" timeout 240 bash "$RT" --netcheck >"$W/n1.log" 2>&1; n1rc=$?
if grep -q "net-jail: agent confined" "$W/n1.log"; then
  ok "N1 non-vacuity: a real network namespace was created ($(grep -o 'confined to [^,]*' "$W/n1.log" | head -1))"
  grep -q "ns=tbj-" "$CLN" && ok "N1 cleanup saw the namespace it had to remove ($(grep -o 'ns=tbj-[^ ]*' "$CLN" | head -1))" \
                           || no "N1 cleanup recorded no namespace — it cannot have torn one down"
  [ "$(ns_count)" -le "$bn" ] && ok "N1 the namespace was REMOVED ($(ns_count) <= $bn)" || no "N1 leaked a namespace"
  [ "$(grep -c '^cleanup ' "$CLN")" = 1 ] && ok "N1 cleanup ran EXACTLY once" || no "N1 cleanup ran $(grep -c '^cleanup ' "$CLN") times"
  grep -q "st=$n1rc" "$CLN" && ok "N1 exit status $n1rc preserved into cleanup" || no "N1 status not preserved"
  [ "$(ls -d /tmp/tb3-run-* 2>/dev/null|wc -l)" -le "$br" ] && ok "N1 no workdir left" || no "N1 leaked a workdir"
  pgrep -f "allowlist-proxy.mjs" >/dev/null 2>&1 && no "N1 an allowlist-proxy process survived" || ok "N1 no proxy process survived"
else
  no "N1 the net-jail path was not reached ($(tail -1 "$W/n1.log")) — namespace teardown is UNPROVEN"
fi

# Every assertion below is scoped to the EXACT resources the invocation recorded in
# its cleanup line (namespace, workdir, control dir, proxy pid) — never a global
# /tmp count or a broad pgrep, which previously let one case's leak be reported
# against another.
fld() { sed -n 's/.*\b'"$2"'=\([^ ]*\).*/\1/p' "$1" | head -1; }

signal_case() { # <SIG> <expected-status> <label>
  local sig="$1" want="$2" lbl="$3"
  local CL="$W/sig-$sig.cl"; : > "$CL"
  local LOG="$W/sig-$sig.log"
  # readiness barrier: hold the run alive AFTER the boundary is proven, so the
  # signal lands at a deterministic point with the namespace and proxy live.
  TB_NETJAIL=1 TB_CLEANUP_LOG="$CL" TB_NETCHECK_HOLD=25 \
    timeout 240 bash "$RT" --netcheck >"$LOG" 2>&1 &
  local rp=$! ready=no
  for _ in $(seq 1 600); do
    grep -q "agent network path verified" "$LOG" 2>/dev/null && { ready=yes; break; }
    kill -0 "$rp" 2>/dev/null || break; sleep 0.1
  done
  if [ "$ready" != yes ]; then wait "$rp" 2>/dev/null; no "$lbl readiness barrier never reached — vacuous"; return; fi
  local ns; ns=$(grep -o 'confined to tbj-[^,]*' "$LOG" | head -1 | sed 's/confined to //')
  [ -n "$ns" ] && ok "$lbl non-vacuity: namespace $ns live at the barrier" || { no "$lbl no namespace at the barrier"; kill "$rp" 2>/dev/null; return; }
  kill -"$sig" "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; local rc=$?
  sleep 1
  [ "$rc" = "$want" ] && ok "$lbl exit status $rc (conventional $want)" || no "$lbl exit status $rc, expected $want"
  local runs; runs=$(grep -c '^cleanup ' "$CL" 2>/dev/null || echo 0)
  [ "$runs" = 1 ] && ok "$lbl cleanup ran EXACTLY once" || no "$lbl cleanup ran $runs times"
  grep -q "sig=$sig" "$CL" && ok "$lbl cleanup recorded sig=$sig" || no "$lbl cleanup did not record the signal"
  # scoped resource assertions, from THIS invocation's own record
  local w c px
  w=$(fld "$CL" w); c=$(fld "$CL" ctrl); px=$(fld "$CL" proxy)
  ip netns list 2>/dev/null | grep -q "^$ns" && no "$lbl namespace $ns still present" || ok "$lbl namespace $ns removed"
  { [ "$px" = none ] || ! kill -0 "$px" 2>/dev/null; } && ok "$lbl proxy pid $px gone" || no "$lbl proxy pid $px still alive"
  { [ "$w" = none ] || [ ! -d "$w" ]; }   && ok "$lbl workdir $w removed"     || no "$lbl workdir $w still present"
  { [ "$c" = none ] || [ ! -d "$c" ]; }   && ok "$lbl control dir removed"    || no "$lbl control dir $c still present"
  # The sealed record lives in the CONTROL dir now (the store the jail masks), not
  # in the workdir; a seal left on it would make the control dir undeletable.
  if [ "$c" != none ] && [ -e "$c/evidence/tree.log" ]; then
    lsattr "$c/evidence/tree.log" 2>/dev/null | grep -q '^-*a' && no "$lbl left its observer record sealed" || ok "$lbl observer record unsealed"
  else ok "$lbl no sealed observer record remains (control dir gone)"; fi
}

hdr "N1b SIGNALS at a deterministic readiness point, scoped to the invocation"
signal_case TERM 143 "N1b/TERM"
signal_case INT  130 "N1b/INT"
signal_case HUP  129 "N1b/HUP"

hdr "N1c stress: 8 TERM trials (supplementary, not the primary proof)"
leaks=0; vac=0
for i in $(seq 1 8); do
  CLs="$W/stress-$i.cl"; : > "$CLs"; LOGs="$W/stress-$i.log"
  TB_NETJAIL=1 TB_CLEANUP_LOG="$CLs" TB_NETCHECK_HOLD=20 timeout 240 bash "$RT" --netcheck >"$LOGs" 2>&1 &
  rp=$!; ready=no
  for _ in $(seq 1 600); do grep -q "agent network path verified" "$LOGs" 2>/dev/null && { ready=yes; break; }; kill -0 "$rp" 2>/dev/null || break; sleep 0.1; done
  if [ "$ready" != yes ]; then wait "$rp" 2>/dev/null; vac=$((vac+1)); continue; fi
  ns=$(grep -o 'confined to tbj-[^,]*' "$LOGs" | head -1 | sed 's/confined to //')
  kill -TERM "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; sleep 1
  ip netns list 2>/dev/null | grep -q "^$ns" && leaks=$((leaks+1))
done
[ "$vac" = 0 ] && ok "N1c non-vacuity: all 8 trials reached the readiness barrier" || no "N1c $vac trial(s) were vacuous"
[ "$leaks" = 0 ] && ok "N1c 0/8 trials leaked a namespace under TERM" || no "N1c $leaks/8 trials leaked a namespace"

hdr "N2 EARLY FAILURE path (fake agent — NO namespace by design)"
mkfixture; CL2="$FIXW/cl.log"; : > "$CL2"
: > "$FIXW/tasks/lifecycle/gold.patch"      # gold no longer fixes it -> PRE_AGENT_GOLD_RED
br=$(ls -d /tmp/tb3-run-* 2>/dev/null|wc -l); bc=$(ls -d /tmp/tb31-ctrl-* 2>/dev/null|wc -l); bn=$(ns_count)
env TB_TASKS="$FIXW/tasks" TB_RUNS="$FIXW/runs" TB_SMOKE_SRC="$TB_FIX_SRC" TB_FAKE_AGENT="$FAKE" \
    TB_NETJAIL=1 TB_CLEANUP_LOG="$CL2" bash "$RT" lifecycle gated >"$FIXW/n2.log" 2>&1; n2rc=$?
[ "$n2rc" -ne 0 ] && ok "N2 non-vacuity: the run failed as intended (exit $n2rc, $(tail -1 "$FIXW/n2.log"))" \
                  || no "N2 the run unexpectedly succeeded — not an early-failure path"
assert_clean "N2" "$CL2" "$n2rc" "$br" "$bc" "$bn"

hdr "N3 SIGNALS through the production entry point, blocked mid-run (fake agent — NO namespace by design)"
for sig in TERM INT HUP; do
  mkfixture; CL3="$FIXW/cl-$sig.log"; : > "$CL3"
  SLOW="$FIXW/slow.sh"; printf '#!/usr/bin/env bash\nsleep 120\n' > "$SLOW"; chmod +x "$SLOW"
  br=$(ls -d /tmp/tb3-run-* 2>/dev/null|wc -l); bc=$(ls -d /tmp/tb31-ctrl-* 2>/dev/null|wc -l); bn=$(ns_count)
  env TB_TASKS="$FIXW/tasks" TB_RUNS="$FIXW/runs" TB_SMOKE_SRC="$TB_FIX_SRC" TB_FAKE_AGENT="$SLOW" \
      TB_NETJAIL=1 TB_CLEANUP_LOG="$CL3" bash "$RT" lifecycle gated >"$FIXW/n3-$sig.log" 2>&1 &
  rp=$!
  # wait until it is genuinely blocked in the agent phase
  for _ in $(seq 1 120); do grep -q "fake-agent smoke\|agent" "$FIXW/n3-$sig.log" 2>/dev/null && break; sleep 1; done
  sleep 2
  if kill -0 "$rp" 2>/dev/null; then
    kill -"$sig" "$rp" 2>/dev/null; wait "$rp" 2>/dev/null; srac=$?
    ok "N3/$sig non-vacuity: the runner was live mid-run and received SIG$sig"
    sleep 1
    assert_clean "N3/$sig" "$CL3" "" "$br" "$bc" "$bn"
  else
    wait "$rp" 2>/dev/null
    no "N3/$sig the runner had already exited before the signal — the case is vacuous"
  fi
done

printf '\ncleanup-lifecycle4: passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" = 0 ]
