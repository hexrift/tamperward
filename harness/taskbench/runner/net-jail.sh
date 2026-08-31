#!/usr/bin/env bash
# Taskbench egress ENFORCEMENT (PREDICTION3 Amendment 3). The allowlist proxy
# is an observation point, not a boundary: a process can bypass HTTP[S]_PROXY
# and reach infrastructure-permitted hosts directly (egress-probe.txt). This
# wraps the agent invocation in a network namespace whose ONLY reachable
# address is the host end of a veth pair — where the allowlist proxy binds.
# No default route and no resolver inside the jail, so:
#   - agent -> proxy (veth host IP:port)  : works (only path)
#   - agent -> any other IP (direct)      : no route -> fails
#   - agent -> any hostname (direct)      : no resolver -> fails
# Therefore every egress either traverses the (logged) proxy or fails at the
# kernel: NETWORK_EXPOSURE is 0 by construction and the registered exposure
# flag is measurable again. Fail-closed: any setup error aborts (exit 9).
#   setup    <tag> -> prints "HOSTIP NSNAME"
#   teardown <tag>
set -u
cmd="${1:?setup|teardown|selftest}"; tag="${2:-}"
ns="tbj-${tag}"
# deterministic /30 per tag (host .1, jail .2) in 10.201.0.0/16
oct=$(( $(printf '%s' "$tag" | cksum | cut -d' ' -f1) % 8192 ))
a=$(( oct / 64 )); b=$(( (oct % 64) * 4 ))
HOSTIP="10.201.$a.$((b+1))"; NSIP="10.201.$a.$((b+2))"
hv="tbh${oct}"; nv="tbn${oct}"   # veth names (<=15 chars)

setup() {
  ip netns add "$ns" || return 9
  ip link add "$hv" type veth peer name "$nv" || return 9
  ip link set "$nv" netns "$ns" || return 9
  ip addr add "$HOSTIP/30" dev "$hv" && ip link set "$hv" up || return 9
  ip netns exec "$ns" ip addr add "$NSIP/30" dev "$nv" || return 9
  ip netns exec "$ns" ip link set "$nv" up || return 9
  ip netns exec "$ns" ip link set lo up || return 9
  # NO default route, NO /etc/resolv.conf entry in the jail -> only the /30 veth is reachable
  echo "$HOSTIP $ns"
}
teardown() { ip netns del "$ns" 2>/dev/null; ip link del "$hv" 2>/dev/null; true; }

case "$cmd" in
  setup) setup ;;
  teardown) teardown ;;
  selftest)
    tag="selftest$$"; ns="tbj-${tag}"
    oct=$(( $(printf '%s' "$tag" | cksum | cut -d' ' -f1) % 8192 ))
    a=$(( oct/64 )); b=$(( (oct%64)*4 )); HOSTIP="10.201.$a.$((b+1))"; hv="tbh${oct}"; nv="tbn${oct}"
    trap 'ip netns del "$ns" 2>/dev/null; ip link del "$hv" 2>/dev/null' EXIT
    read -r HIP NS < <(bash "$0" setup "$tag") || { echo "SELFTEST FAIL: setup"; exit 1; }
    python3 -m http.server 18080 --bind "$HIP" >/dev/null 2>&1 & lp=$!; sleep 1
    r1=$(ip netns exec "$NS" curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$HIP:18080/" 2>&1)
    r2=$(ip netns exec "$NS" curl -sS -m 5 -o /dev/null "https://1.1.1.1/" 2>&1; echo "rc=$?")
    r3=$(ip netns exec "$NS" env -u HTTPS_PROXY -u https_proxy curl -sS -m 5 -o /dev/null "https://pypi.org/simple/" 2>&1; echo "rc=$?")
    kill $lp 2>/dev/null
    [ "$r1" = "200" ] || { echo "SELFTEST FAIL: proxy IP unreachable from jail ($r1)"; exit 1; }
    echo "$r2" | grep -q 'rc=0' && { echo "SELFTEST FAIL: numeric direct egress SUCCEEDED"; exit 1; }
    echo "$r3" | grep -q 'rc=0' && { echo "SELFTEST FAIL: hostname direct egress SUCCEEDED"; exit 1; }
    echo "net-jail selftest OK: veth-proxy reachable ($r1), numeric egress blocked, DNS egress blocked"
    ;;
  *) echo "usage: net-jail.sh setup|teardown|selftest <tag>"; exit 2 ;;
esac
