#!/usr/bin/env bash
# Regression test for the FAIL-CLOSED validation in analyze-counted.mjs (PR #297 + #298 review).
#
# Proves: an incomplete, inconsistent, OR corrupt/misidentified census can NEVER be sealed —
# the analyzer refuses to write a results artifact and exits NON-ZERO — while a complete,
# schema-valid census seals and exits 0. Uses a tiny synthetic fixture (the analyzer enforces
# no scale, only the counted manifest shape), so no real counted state or credential is needed.
#
#   #297 cases: missing verdict, malformed .adjudicated marker, stray verdict.
#   #298 cases: empty {} verdict, wrong task/arm identity, malformed verdict JSON, wrong
#               treatment/model identity — each must fail closed, NOT degrade to invalid_measurement.
#   #298 follow-up: type-correct JSON that still violates a value bound (negative/fractional count)
#               or a verdict4 cross-field invariant (masked_failure vs outcome; surviving vs
#               persistent; landed vs transient+persistent; blindness vs temporal; envelope_escape
#               requires gated AND tamperward_success) must also fail closed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ANALYZER="$HERE/analyze-counted.mjs"
command -v jq >/dev/null 2>&1 || { echo "SELFTEST SKIP: jq required" >&2; exit 0; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
RUNS="$WORK/runs"; MAN="$WORK/manifest.json"; OUT="$WORK/out.json"
mkdir -p "$RUNS"
fail(){ echo "SELFTEST FAIL: $*" >&2; exit 1; }

# fixture identity that verdicts must be bound to (#298): the manifest's model + treatment pkg tree.
FMODEL="test-model"
FPKG="0000000000000000000000000000000000000000000000000000000000000000"

# ---- a minimal COMPLETE fixture: 2 primary tasks x 2 arms (seq 1..4), 0 duplicates ----
cat > "$MAN" <<EOF
{
  "registration": { "model": "$FMODEL", "base_commit": "0000000000000000000000000000000000000000", "n_primary": 2, "n_duplicates": 0 },
  "treatment": { "version": "0.0.0-test", "artefact_pkg_tree_sha256": "$FPKG" },
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

# a schema-valid verdict for the frozen row (seq task arm), bound to the fixture model/treatment.
mkverdict(){ # seq task arm
  local d="$RUNS/seq-$(printf %03d "$1")"; mkdir -p "$d"
  local tw=null; [ "$3" = gated ] && tw=true
  cat > "$d/$2-$3.verdict.json" <<EOF
{"task":"$2","arm":"$3","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":$tw,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
}
mkfixture(){ rm -rf "$RUNS"; mkdir -p "$RUNS"
  mkverdict 1 t1 gated; mkverdict 2 t1 ungated; mkverdict 3 t2 gated; mkverdict 4 t2 ungated
  local LOG="$RUNS/counted-execution-log.jsonl"; : > "$LOG"
  for s in 1 2 3 4; do echo "{\"event\":\"finished\",\"seq\":$s,\"verdict\":\"yes\",\"manifest_sha256\":\"$MSHA\"}" >> "$LOG"; done
}
run(){ node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --state-commit deadbeef --out "$OUT" >/dev/null 2>&1; }

# ---- 1. COMPLETE, schema-valid census -> seals, exit 0, completeness_ok true ----
mkfixture
run || fail "complete schema-valid census must exit 0"
[ -f "$OUT" ] || fail "complete census must write the artifact"
[ "$(jq -r .completeness_ok "$OUT")" = "true" ] || fail "sealed artifact must have completeness_ok=true"
echo "ok 1: complete schema-valid census seals and exits 0"

# ---- 2. MISSING verdict (seq 4, no marker) -> refuse, non-zero, NO artifact ----
mkfixture; rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
run && fail "incomplete census (missing verdict) must exit non-zero"
[ -f "$OUT" ] && fail "incomplete census must NOT write a sealed artifact"
echo "ok 2: missing verdict refuses to seal, exits non-zero, no artifact"

# ---- 3. MALFORMED .adjudicated marker (wrong task/arm) -> refuse, non-zero, NO artifact ----
mkfixture; rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
cat > "$RUNS/seq-004/t2-ungated.adjudicated" <<'EOF'
disposition=BOGUS
task=WRONG-TASK
seq=4
arm=gated
deviation=notaD
sampled=maybe
EOF
run && fail "malformed adjudication marker must exit non-zero"
[ -f "$OUT" ] && fail "malformed marker must NOT write a sealed artifact"
echo "ok 3: malformed adjudication marker refuses to seal, exits non-zero, no artifact"

# ---- 4. STRAY verdict file (a verdict.json not matching the frozen row) -> refuse ----
mkfixture; rm -f "$OUT"
echo '{"task":"t2","arm":"ungated","measured":true}' > "$RUNS/seq-004/some-other-row.verdict.json"
run && fail "stray verdict file must exit non-zero"
[ -f "$OUT" ] && fail "stray verdict file must NOT write a sealed artifact"
echo "ok 4: stray verdict file refuses to seal, exits non-zero, no artifact"

# ---- 5. EMPTY {} verdict at an expected path -> refuse (NOT degraded to invalid_measurement) ----
mkfixture; rm -f "$OUT"; echo '{}' > "$RUNS/seq-004/t2-ungated.verdict.json"
run && fail "empty {} verdict must exit non-zero"
[ -f "$OUT" ] && fail "empty {} verdict must NOT write a sealed artifact"
echo "ok 5: empty {} verdict refuses to seal (not silently degraded to invalid_measurement)"

# ---- 6. WRONG task/arm identity in the payload (right filename) -> refuse ----
mkfixture; rm -f "$OUT"
cat > "$RUNS/seq-004/t2-ungated.verdict.json" <<EOF
{"task":"t1","arm":"gated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":true,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "wrong task/arm identity must exit non-zero"
[ -f "$OUT" ] && fail "wrong identity must NOT write a sealed artifact"
echo "ok 6: wrong task/arm identity refuses to seal, exits non-zero, no artifact"

# ---- 7. MALFORMED verdict JSON at an expected path -> refuse ----
mkfixture; rm -f "$OUT"; printf '{not valid json' > "$RUNS/seq-004/t2-ungated.verdict.json"
run && fail "malformed verdict JSON must exit non-zero"
[ -f "$OUT" ] && fail "malformed verdict JSON must NOT write a sealed artifact"
echo "ok 7: malformed verdict JSON refuses to seal, exits non-zero, no artifact"

# ---- 8. WRONG treatment/model identity (schema-valid but not the frozen build) -> refuse ----
mkfixture; rm -f "$OUT"
cat > "$RUNS/seq-004/t2-ungated.verdict.json" <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"some-other-model","artefact_pkg_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "wrong treatment/model identity must exit non-zero"
[ -f "$OUT" ] && fail "wrong treatment/model identity must NOT write a sealed artifact"
echo "ok 8: wrong treatment/model identity refuses to seal, exits non-zero, no artifact"

# ---- #298 follow-up: type-correct JSON that violates a value bound or a verdict4 cross-field
#      invariant must also fail closed (each case isolates one rule). ----
putv(){ cat > "$RUNS/$1"; }   # write a verdict body to a seq path under RUNS

# 9. NEGATIVE count (denies:-1) -> refuse (counts are non-negative integers, not any finite number)
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":-1,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "negative count must exit non-zero"; [ -f "$OUT" ] && fail "negative count must NOT seal"
echo "ok 9: negative count (denies:-1) refuses to seal, exits non-zero, no artifact"

# 10. FRACTIONAL count (temporal.prevented:0.5) -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0.5,"transient":0,"persistent":0}}
EOF
run && fail "fractional count must exit non-zero"; [ -f "$OUT" ] && fail "fractional count must NOT seal"
echo "ok 10: fractional count (temporal.prevented:0.5) refuses to seal, exits non-zero, no artifact"

# 11. masked_failure inconsistent with outcome (mf:true but outcome != MASKED_FAILURE) -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":true,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "masked_failure/outcome mismatch must exit non-zero"; [ -f "$OUT" ] && fail "mf/outcome mismatch must NOT seal"
echo "ok 11: masked_failure inconsistent with outcome refuses to seal, exits non-zero, no artifact"

# 12. surviving_violations.length != blindness.persistent -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[{"file":"tests/x.py","class":"test_skip"}],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "surviving_violations.length!=persistent must exit non-zero"; [ -f "$OUT" ] && fail "surv!=persistent must NOT seal"
echo "ok 12: surviving_violations.length!=blindness.persistent refuses to seal, exits non-zero, no artifact"

# 13. blindness.landed != transient + persistent -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":true,"landed":9,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "blindness.landed!=t+p must exit non-zero"; [ -f "$OUT" ] && fail "landed!=t+p must NOT seal"
echo "ok 13: blindness.landed!=transient+persistent refuses to seal, exits non-zero, no artifact"

# 14. blindness counts disagree with temporal counts -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":true,"landed":1,"transient":1,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "blindness/temporal count disagreement must exit non-zero"; [ -f "$OUT" ] && fail "blindness!=temporal must NOT seal"
echo "ok 14: blindness counts != temporal counts refuses to seal, exits non-zero, no artifact"

# 15. envelope_escape:true on a gated row with tamperward_success:false -> refuse (needs tw==true, not just gated)
mkfixture; rm -f "$OUT"
putv seq-003/t2-gated.verdict.json <<EOF
{"task":"t2","arm":"gated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":true,"tamperward_success":false,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "envelope_escape without tamperward_success must exit non-zero"; [ -f "$OUT" ] && fail "envelope_escape w/o tw must NOT seal"
echo "ok 15: envelope_escape=true w/o tamperward_success refuses to seal, exits non-zero, no artifact"

echo "analyze-counted.selftest: PASS"
