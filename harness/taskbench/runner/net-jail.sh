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
# flag is measurable again. The proxy's allowlist is the model API host only
# (allowlist-proxy.mjs); the CLI's telemetry hosts are denied and logged.
# Fail-closed: any setup error aborts (exit 9) with a message naming the step,
# after tearing down whatever the failed setup had already created.
#   setup    <tag> <proxy-port> -> prints "HOSTIP NSNAME"
#   teardown <tag>
set -u
cmd="${1:?setup|teardown|selftest}"; tag="${2:-}"; jport="${3:-}"

# Every name is a pure function of the tag, so a later teardown invocation
# recomputes exactly what setup built. The id is 48 bits of sha256(tag): two
# concurrent jails (distinct tags — callers use "<task>-<pid>") never share a
# veth name, which the old cksum-mod-8192 scheme could not promise. 3 + 12
# chars stays inside the kernel's 15-char interface-name limit.
derive() { # <tag>
  ns="tbj-$1"
  id=$(printf '%s' "$1" | sha256sum | cut -c1-12)
  hv="tbh${id}"; nv="tbn${id}"
  # deterministic /30 per tag (host .1, jail .2) in 10.201.0.0/16
  oct=$(( 16#${id:0:4} % 8192 ))
  a=$(( oct / 64 )); b=$(( (oct % 64) * 4 ))
  HOSTIP="10.201.$a.$((b+1))"; NSIP="10.201.$a.$((b+2))"
}
derive "$tag"

fail() { # <what failed>: say so, remove the partial jail, and the caller returns 9
  echo "net-jail: $1 (tag=$tag ns=$ns veth=$hv/$nv subnet=$HOSTIP/30)" >&2
  teardown
}
setup() {
  [ -n "$tag" ] || { echo "net-jail setup: a tag is required" >&2; return 9; }
  [ -n "$jport" ] || { echo "net-jail setup: a proxy port is required" >&2; return 9; }
  # Collisions with a live jail fail closed BEFORE anything is created. The
  # subnet check matters most: a second `ip addr add` of the same /30 on a
  # different veth succeeds silently and leaves two jails sharing a route.
  ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$ns" && { echo "net-jail: namespace $ns already exists (tag=$tag)" >&2; return 9; }
  ip link show "$hv" >/dev/null 2>&1 && { echo "net-jail: host veth $hv already exists (tag=$tag)" >&2; return 9; }
  ip -4 -o addr show 2>/dev/null | grep -q " $HOSTIP/" && { echo "net-jail: subnet $HOSTIP/30 already in use on this host (tag=$tag)" >&2; return 9; }
  ip netns add "$ns" || { fail "ip netns add failed"; return 9; }
  ip link add "$hv" type veth peer name "$nv" || { fail "veth pair creation failed"; return 9; }
  ip link set "$nv" netns "$ns" || { fail "moving the jail veth into the namespace failed"; return 9; }
  ip addr add "$HOSTIP/30" dev "$hv" && ip link set "$hv" up || { fail "host veth address/up failed"; return 9; }
  ip netns exec "$ns" ip addr add "$NSIP/30" dev "$nv" || { fail "jail veth address failed"; return 9; }
  ip netns exec "$ns" ip link set "$nv" up || { fail "jail veth up failed"; return 9; }
  ip netns exec "$ns" ip link set lo up || { fail "jail loopback up failed"; return 9; }
  # NO default route, NO resolver: arbitrary Internet IPs have no route. But the
  # /30 makes the host veth IP reachable on ANY port, so a host service bound to
  # it would be a bypass. nft confines the jail to exactly HOSTIP:jport (the
  # allowlist proxy) — every successful agent egress must traverse the proxy.
  ip netns exec "$ns" nft -f - <<NFT || { fail "nft ruleset failed"; return 9; }
table inet jail {
  chain output { type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    ip daddr $HOSTIP tcp dport $jport accept
  }
  chain input { type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
  }
}
NFT
  echo "$HOSTIP $ns"
}
teardown() { ip netns del "$ns" 2>/dev/null; ip link del "$hv" 2>/dev/null; true; }

case "$cmd" in
  setup) setup ;;
  teardown) teardown ;;
  selftest)
    tag="selftest$$"; derive "$tag"
    trap 'teardown' EXIT
    read -r HIP NS < <(bash "$0" setup "$tag" 18080) || { echo "SELFTEST FAIL: setup"; exit 1; }
    python3 -m http.server 18080 --bind "$HIP" >/dev/null 2>&1 & lp=$!
    python3 -m http.server 18081 --bind "$HIP" >/dev/null 2>&1 & lp2=$!; sleep 1
    r1=$(ip netns exec "$NS" curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$HIP:18080/" 2>&1)
    r0=$(ip netns exec "$NS" curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://$HIP:18081/" 2>&1; echo "rc=$?")
    r2=$(ip netns exec "$NS" curl -sS -m 5 -o /dev/null "https://1.1.1.1/" 2>&1; echo "rc=$?")
    r3=$(ip netns exec "$NS" env -u HTTPS_PROXY -u https_proxy curl -sS -m 5 -o /dev/null "https://pypi.org/simple/" 2>&1; echo "rc=$?")
    kill $lp $lp2 2>/dev/null
    [ "$r1" = "200" ] || { echo "SELFTEST FAIL: proxy port unreachable from jail ($r1)"; exit 1; }
    echo "$r0" | grep -q 'rc=0' && { echo "SELFTEST FAIL: OTHER host port reachable — veth not port-confined"; exit 1; }
    echo "$r2" | grep -q 'rc=0' && { echo "SELFTEST FAIL: numeric direct egress SUCCEEDED"; exit 1; }
    echo "$r3" | grep -q 'rc=0' && { echo "SELFTEST FAIL: hostname direct egress SUCCEEDED"; exit 1; }
    echo "net-jail selftest OK: proxy port reachable ($r1); other host port blocked; numeric + DNS egress blocked"
    ;;
  *) echo "usage: net-jail.sh setup|teardown|selftest <tag> [proxy-port]"; exit 2 ;;
esac
