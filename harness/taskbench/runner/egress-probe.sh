#!/usr/bin/env bash
# Direct-egress probe (PREDICTION3 Amendment 2). DESIGN assumes the runner's
# allowlist proxy is the only egress path; the runner enforces it via proxy
# environment variables only. This probe verifies the OS-level assumption:
# with every proxy variable unset and curl told to bypass proxies, a direct
# fetch of a forbidden host must FAIL. Exit 0 (assumption holds) only when
# both probes are blocked; exit 1 loudly otherwise.
set -u
try() { # host
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
    curl --noproxy '*' -sS --max-time 12 -o /dev/null -w '%{http_code}' "$1" 2>&1
}
fail=0
for url in "https://pypi.org/simple/" "http://example.com/"; do
  out=$(try "$url"); rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qE '^(2|3)[0-9][0-9]$'; then
    echo "EGRESS LEAK: direct fetch of $url succeeded (http $out) with proxies bypassed"
    fail=1
  else
    echo "blocked: $url (rc=$rc, ${out:0:120})"
  fi
done
[ "$fail" -eq 0 ] && echo "DIRECT-EGRESS ASSUMPTION HOLDS: no proxy-bypassing egress path" || echo "DIRECT-EGRESS ASSUMPTION FALSE"
exit "$fail"
