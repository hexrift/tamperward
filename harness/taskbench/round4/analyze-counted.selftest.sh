#!/usr/bin/env bash
# Regression test for the FAIL-CLOSED completeness gate in analyze-counted.mjs (PR #297 review).
#
# Proves: an incomplete or inconsistent census can NEVER be sealed — the analyzer refuses to
# write a results artifact and exits NON-ZERO — while a complete census seals and exits 0.
# Uses a tiny synthetic fixture (the analyzer enforces no scale, only the counted manifest
# shape), so no real counted state or credential is needed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ANALYZER="$HERE/analyze-counted.mjs"
command -v jq >/dev/null 2>&1 || { echo "SELFTEST SKIP: jq required" >&2; exit 0; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
RUNS="$WORK/runs"; MAN="$WORK/manifest.json"; OUT="$WORK/out.json"
mkdir -p "$RUNS"
fail(){ echo "SELFTEST FAIL: $*" >&2; exit 1; }

# ---- a minimal COMPLETE fixture: 2 primary tasks x 2 arms (seq 1..4), 0 duplicates ----
cat > "$MAN" <<'EOF'
{
  "registration": { "model": "test-model", "base_commit": "0000000000000000000000000000000000000000", "n_primary": 2, "n_duplicates": 0 },
  "treatment": { "version": "0.0.0-test", "artefact_pkg_tree_sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
  "execution": {
    "trajectory_count": 4,
    "primary": { "trajectory_count": 4, "trajectories": [
      {"seq":1,"task":"t1","arm":"gated"},{"seq":2,"task":"t1","arm":"ungated"},
      {"seq":3,"task":"t2","arm":"gated"},{"seq":4,"task":"t2","arm":"ungated"} ] },
    "duplicates": { "trajectory_count": 0, "trajectories": [] }
  }
}
EOF
MSHA="$(sha256sum "$MAN" | cut -d' ' -f1)"

mkverdict(){ # seq task arm
  local d="$RUNS/seq-$(printf %03d "$1")"; mkdir -p "$d"
  local tw=null; [ "$3" = gated ] && tw=true
  cat > "$d/$2-$3.verdict.json" <<EOF
{"task":"$2","arm":"$3","measured":true,"masked_failure":false,"outcome":"HONEST_COMPLETION","envelope_escape":false,"tamperward_success":$tw,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"persistent":0},"temporal":{"transient":0,"persistent":0,"prevented":0},"legacy_false_green":false}
EOF
}
mkverdict 1 t1 gated; mkverdict 2 t1 ungated; mkverdict 3 t2 gated; mkverdict 4 t2 ungated
LOG="$RUNS/counted-execution-log.jsonl"; : > "$LOG"
for s in 1 2 3 4; do echo "{\"event\":\"finished\",\"seq\":$s,\"verdict\":\"yes\",\"manifest_sha256\":\"$MSHA\"}" >> "$LOG"; done

# ---- 1. COMPLETE census -> seals, exit 0, completeness_ok true ----
node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --out "$OUT" >/dev/null 2>&1 \
  || fail "complete census must exit 0"
[ -f "$OUT" ] || fail "complete census must write the artifact"
[ "$(jq -r .completeness_ok "$OUT")" = "true" ] || fail "sealed artifact must have completeness_ok=true"
echo "ok 1: complete census seals and exits 0"

# ---- 2. MISSING verdict (seq 4, no marker) -> refuse, non-zero, NO artifact ----
rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --out "$OUT" >/dev/null 2>&1 \
  && fail "incomplete census (missing verdict) must exit non-zero"
[ -f "$OUT" ] && fail "incomplete census must NOT write a sealed artifact"
echo "ok 2: missing verdict refuses to seal, exits non-zero, no artifact"

# ---- 3. MALFORMED .adjudicated marker (wrong task/arm) -> refuse, non-zero, NO artifact ----
rm -f "$OUT"; mkdir -p "$RUNS/seq-004"
cat > "$RUNS/seq-004/t2-ungated.adjudicated" <<'EOF'
disposition=BOGUS
task=WRONG-TASK
seq=4
arm=gated
deviation=notaD
sampled=maybe
EOF
node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --out "$OUT" >/dev/null 2>&1 \
  && fail "malformed adjudication marker must exit non-zero"
[ -f "$OUT" ] && fail "malformed marker must NOT write a sealed artifact"
echo "ok 3: malformed adjudication marker refuses to seal, exits non-zero, no artifact"

# ---- 4. STRAY verdict file (a verdict.json not matching the frozen row) -> refuse ----
rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.adjudicated"; mkverdict 4 t2 ungated
echo '{"task":"t2","arm":"ungated","measured":true,"masked_failure":false,"outcome":"HONEST_COMPLETION"}' > "$RUNS/seq-004/some-other-row.verdict.json"
node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --out "$OUT" >/dev/null 2>&1 \
  && fail "stray verdict file must exit non-zero"
[ -f "$OUT" ] && fail "stray verdict file must NOT write a sealed artifact"
echo "ok 4: stray verdict file refuses to seal, exits non-zero, no artifact"

echo "analyze-counted.selftest: PASS"
