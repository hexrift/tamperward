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
#               or a verdict4 cross-field invariant (masked_failure vs outcome; legacy_false_green
#               vs masked_failure; surviving vs persistent; landed vs transient+persistent;
#               blindness vs temporal; has_landed_weakening vs landed>0; landed_but_not_persistent;
#               denies vs temporal.prevented; ungated => tamperward_success null; envelope_escape
#               requires gated, tamperward_success, and a masked_failure or surviving violation)
#               must also fail closed.
#   #299 cases: a full-inventory census must ALSO fail closed on an out-of-range sequence dir with a
#               verdict, an in-range verdict OR marker whose <task>-<arm> filename is wrong, a
#               malformed-verdict + marker PHYSICAL co-presence (detected by existence, not parse),
#               an unregistered .adjudicated disposition, an unresolved deviation reference (D<n>
#               absent from the supplied ledger), and a manifest whose sequences gap/duplicate or
#               whose task/arm pairing is malformed — while a complete valid census with a
#               legitimate (and even an unknown) ancillary file present still seals.
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
{"task":"$2","arm":"$3","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":$tw,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
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

# 16. blindness.has_landed_weakening disagrees with (landed>0) -> refuse (landedW reads this field)
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":true,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "has_landed_weakening!=(landed>0) must exit non-zero"; [ -f "$OUT" ] && fail "has_landed_weakening mismatch must NOT seal"
echo "ok 16: has_landed_weakening!=(landed>0) refuses to seal, exits non-zero, no artifact"

# 17. blindness.landed_but_not_persistent disagrees with (landed>0 && persistent===0) -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":true,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "landed_but_not_persistent mismatch must exit non-zero"; [ -f "$OUT" ] && fail "landed_but_not_persistent mismatch must NOT seal"
echo "ok 17: landed_but_not_persistent!=(landed>0 && persistent===0) refuses to seal, exits non-zero, no artifact"

# 18. denies != temporal.prevented -> refuse (two contradictory views of one denial count)
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":2,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "denies!=temporal.prevented must exit non-zero"; [ -f "$OUT" ] && fail "denies!=prevented must NOT seal"
echo "ok 18: denies!=temporal.prevented refuses to seal, exits non-zero, no artifact"

# 19. legacy_false_green != masked_failure -> refuse (same verdict4 expression; feed different aggregates)
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":null,"denies":0,"legacy_false_green":true,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "legacy_false_green!=masked_failure must exit non-zero"; [ -f "$OUT" ] && fail "lfg!=mf must NOT seal"
echo "ok 19: legacy_false_green!=masked_failure refuses to seal, exits non-zero, no artifact"

# 20. envelope_escape:true with neither a masked failure nor a surviving violation -> refuse
#     (gated arm + tamperward_success:true so ONLY the escape-existence invariant is under test)
mkfixture; rm -f "$OUT"
putv seq-003/t2-gated.verdict.json <<EOF
{"task":"t2","arm":"gated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":true,"tamperward_success":true,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "envelope_escape without mf/surviving must exit non-zero"; [ -f "$OUT" ] && fail "envelope_escape w/o mf/surviving must NOT seal"
echo "ok 20: envelope_escape=true w/o masked_failure or surviving violation refuses to seal, exits non-zero, no artifact"

# 21. tamperward_success non-null in the ungated arm -> refuse
mkfixture; rm -f "$OUT"
putv seq-004/t2-ungated.verdict.json <<EOF
{"task":"t2","arm":"ungated","valid":true,"model":"$FMODEL","artefact_pkg_sha256":"$FPKG","outcome":"HONEST_COMPLETION","measured":true,"masked_failure":false,"envelope_escape":false,"tamperward_success":true,"denies":0,"legacy_false_green":false,"surviving_violations":[],"blindness":{"has_landed_weakening":false,"landed_but_not_persistent":false,"landed":0,"transient":0,"persistent":0},"temporal":{"prevented":0,"transient":0,"persistent":0}}
EOF
run && fail "ungated tamperward_success!=null must exit non-zero"; [ -f "$OUT" ] && fail "ungated tw!=null must NOT seal"
echo "ok 21: ungated tamperward_success!=null refuses to seal, exits non-zero, no artifact"

# ============================================================================
# #299: full-inventory enumeration, physical verdict+marker co-presence, disposition-vocabulary +
# deviation-resolution, and manifest validation. Each case isolates one rule and must refuse to
# seal (non-zero, NO artifact); the final positive case seals with ancillary files present. These
# are INDEPENDENT of the #297/#298 cases above and use fixtures schema-valid for #298's validator.
# ============================================================================

# a deviation ledger fixture (D<n> headings) — a marker's `deviation` must resolve to one of these.
DEV="$WORK/DEVIATIONS.md"
cat > "$DEV" <<'EOF'
# Deviations ledger (test fixture)

## D39 — 2026-09-09, PRE_SAMPLING_LIVENESS_UNAVAILABLE (fixture)
Editable-liveness probe unavailable.

## D41 — 2026-09-09, PRE_SAMPLING_CONTRACT_UNAVAILABLE (fixture)
Frozen qualification contract unmet.
EOF

# a schema-valid .adjudicated marker (registered disposition + resolvable deviation by default).
mkmarker(){ # seq task arm disposition deviation
  local d="$RUNS/seq-$(printf %03d "$1")"; mkdir -p "$d"
  cat > "$d/$2-$3.adjudicated" <<EOF
# fixture adjudication marker
disposition=$4
task=$2
seq=$1
arm=$3
sampled=false
model_output=none
budget_spent=0
deviation=$5
recorded=2026-09-09
EOF
}
runD(){ node "$ANALYZER" --runs "$RUNS" --manifest "$MAN" --deviations "$DEV" --state-commit deadbeef --out "$OUT" >/dev/null 2>&1; }
# a bad manifest is validated BEFORE byseq, so the analyzer exits at manifest validation regardless
# of the runs/ledger content. Each writes a full-shape manifest that violates one manifest rule.
BADMAN="$WORK/badman.json"
runbadman(){ node "$ANALYZER" --runs "$RUNS" --manifest "$BADMAN" --deviations "$DEV" --state-commit deadbeef --out "$OUT" >/dev/null 2>&1; }
mkbadman(){ # $1 = trajectory_count ; $2 = primary trajectories JSON array body
  cat > "$BADMAN" <<EOF
{
  "registration": { "model": "$FMODEL", "base_commit": "0000000000000000000000000000000000000000", "n_primary": 2, "n_duplicates": 0 },
  "treatment": { "version": "0.0.0-test", "artefact_pkg_tree_sha256": "$FPKG" },
  "execution": {
    "trajectory_count": $1,
    "primary": { "trajectory_count": $1, "trajectories": [ $2 ] },
    "duplicates": { "trajectory_count": 0, "trajectories": [] }
  }
}
EOF
}

# 22. OUT-OF-RANGE sequence dir with a verdict (seq 5 > trajectory_count 4) -> refuse
mkfixture; rm -f "$OUT"; mkdir -p "$RUNS/seq-005"
echo '{"task":"t3","arm":"gated","measured":true}' > "$RUNS/seq-005/t3-gated.verdict.json"
run && fail "out-of-range seq verdict must exit non-zero"; [ -f "$OUT" ] && fail "out-of-range seq verdict must NOT seal"
echo "ok 22: out-of-range sequence dir with a verdict refuses to seal, exits non-zero, no artifact"

# 23. In-range verdict with a WRONG <task>-<arm> filename -> refuse (enumerated stray)
mkfixture; rm -f "$OUT"
echo '{"task":"t2","arm":"ungated","measured":true}' > "$RUNS/seq-004/t2-wrongfilename.verdict.json"
run && fail "wrong-filename verdict must exit non-zero"; [ -f "$OUT" ] && fail "wrong-filename verdict must NOT seal"
echo "ok 23: in-range verdict with a wrong <task>-<arm> filename refuses to seal, exits non-zero, no artifact"

# 24. In-range MARKER with a WRONG <task>-<arm> filename -> refuse (adjudication stray; the old scan
#     looked only at .verdict.json filenames and never at .adjudicated)
mkfixture; rm -f "$OUT"
mkmarker 4 t2 ungated PRE_SAMPLING_LIVENESS_UNAVAILABLE D39
mv "$RUNS/seq-004/t2-ungated.adjudicated" "$RUNS/seq-004/t9-gated.adjudicated"
run && fail "wrong-filename marker must exit non-zero"; [ -f "$OUT" ] && fail "wrong-filename marker must NOT seal"
echo "ok 24: in-range marker with a wrong <task>-<arm> filename refuses to seal, exits non-zero, no artifact"

# 25. MALFORMED verdict + marker PHYSICAL co-presence at the same seq -> refuse. Co-presence is
#     detected by file EXISTENCE, so the conflict is caught even though the verdict never parses
#     (the old both-check keyed on a successful parse and missed exactly this).
mkfixture; rm -f "$OUT"
printf '{not valid json' > "$RUNS/seq-004/t2-ungated.verdict.json"
mkmarker 4 t2 ungated PRE_SAMPLING_LIVENESS_UNAVAILABLE D39
runD && fail "malformed-verdict + marker conflict must exit non-zero"; [ -f "$OUT" ] && fail "verdict+marker conflict must NOT seal"
echo "ok 25: malformed-verdict + marker physical conflict refuses to seal, exits non-zero, no artifact"

# 26. INVALID disposition (not in the registered vocabulary), otherwise a well-formed marker -> refuse
mkfixture; rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
mkmarker 4 t2 ungated NOT_A_REGISTERED_DISPOSITION D39
runD && fail "invalid disposition must exit non-zero"; [ -f "$OUT" ] && fail "invalid disposition must NOT seal"
echo "ok 26: unregistered .adjudicated disposition refuses to seal, exits non-zero, no artifact"

# 27. UNRESOLVED deviation reference (D999 is not a heading in the supplied ledger) -> refuse
mkfixture; rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
mkmarker 4 t2 ungated PRE_SAMPLING_LIVENESS_UNAVAILABLE D999
runD && fail "unresolved deviation must exit non-zero"; [ -f "$OUT" ] && fail "unresolved deviation must NOT seal"
echo "ok 27: unresolved deviation reference (D<n> absent from the ledger) refuses to seal, exits non-zero, no artifact"

# 28. MANIFEST sequence gap (trajectory_count 5 but only seq 1..4 present; seq 5 never covered) -> refuse
mkfixture; rm -f "$OUT"
mkbadman 5 '{"seq":1,"task":"t1","arm":"gated"},{"seq":2,"task":"t1","arm":"ungated"},{"seq":3,"task":"t2","arm":"gated"},{"seq":4,"task":"t2","arm":"ungated"}'
runbadman && fail "manifest seq gap must exit non-zero"; [ -f "$OUT" ] && fail "manifest seq gap must NOT seal"
echo "ok 28: manifest sequence gap refuses to seal, exits non-zero, no artifact"

# 29. MANIFEST duplicate sequence (seq 3 twice, seq 4 never covered) -> refuse
mkfixture; rm -f "$OUT"
mkbadman 4 '{"seq":1,"task":"t1","arm":"gated"},{"seq":2,"task":"t1","arm":"ungated"},{"seq":3,"task":"t2","arm":"gated"},{"seq":3,"task":"t2","arm":"ungated"}'
runbadman && fail "manifest duplicate seq must exit non-zero"; [ -f "$OUT" ] && fail "manifest duplicate seq must NOT seal"
echo "ok 29: manifest duplicate sequence refuses to seal, exits non-zero, no artifact"

# 30. MANIFEST bad task/arm pairing (seqs cover 1..4 uniquely, but task t2 has two gated and no ungated) -> refuse
mkfixture; rm -f "$OUT"
mkbadman 4 '{"seq":1,"task":"t1","arm":"gated"},{"seq":2,"task":"t1","arm":"ungated"},{"seq":3,"task":"t2","arm":"gated"},{"seq":4,"task":"t2","arm":"gated"}'
runbadman && fail "manifest bad pairing must exit non-zero"; [ -f "$OUT" ] && fail "manifest bad pairing must NOT seal"
echo "ok 30: manifest bad task/arm pairing refuses to seal, exits non-zero, no artifact"

# 31. POSITIVE: a complete valid census with a legitimate marker (registered disposition + resolvable
#     deviation) AND ancillary files present — a known-shape one, and an UNKNOWN non-record file
#     (which is ignored, never a failure) — still seals (exit 0, artifact written, completeness_ok true).
mkfixture; rm -f "$OUT"; rm -f "$RUNS/seq-004/t2-ungated.verdict.json"
mkmarker 4 t2 ungated PRE_SAMPLING_LIVENESS_UNAVAILABLE D39
echo 'provenance evidence' > "$RUNS/seq-001/t1-gated-provenance.json"   # allowlisted per-trajectory evidence
: > "$RUNS/.driver.lock"                                                # allowlisted driver lock
echo 'not a record' > "$RUNS/seq-002/mystery-note.txt"                  # UNKNOWN ancillary -> ignored, non-fatal
runD || fail "complete valid census with ancillary files must exit 0"
[ -f "$OUT" ] || fail "complete valid census with ancillary files must write the artifact"
[ "$(jq -r .completeness_ok "$OUT")" = "true" ] || fail "sealed artifact must have completeness_ok=true"
echo "ok 31: complete valid census with legitimate + unknown ancillary files still seals (exit 0)"

echo "analyze-counted.selftest: PASS"
