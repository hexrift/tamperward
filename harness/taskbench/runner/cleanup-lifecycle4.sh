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

printf '\ncleanup-lifecycle4: passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" = 0 ]
