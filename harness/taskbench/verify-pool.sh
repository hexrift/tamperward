#!/usr/bin/env bash
# Taskbench pool invariant checker — run before every checkpoint and before
# registration; any failure blocks the commit. Born from the csstype incident:
# a TASK_VALIDATED line existed with no artifacts behind it.
set -euo pipefail
cd "$(dirname "$0")"

node - <<'EOF'
const fs = require('fs'), crypto = require('crypto'), cp = require('child_process');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const fail = [];

// attrition state: TASK_VALIDATED lines net of corrections
const lines = fs.readFileSync('attrition.jsonl', 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { fail.push(`unparseable attrition line: ${l.slice(0,80)}`); return null; } })
  .filter(Boolean);
const validated = lines.filter(e => e.gate === 'TASK_VALIDATED').map(e => e.repo);

// invariant: no repo decided twice (repo-level verdicts only)
const repoLevel = new Set(['EXCLUDED_INACTIVE','NO_QUALIFYING_COMMITS','G0_NO_TEST_SCRIPT','G0_NO_PACKAGE_JSON','CLONE_FAILED','CANDIDATES_EXHAUSTED','TASK_VALIDATED','QUOTA_FULL']);
const verdicts = {};
for (const e of lines) if (repoLevel.has(e.gate)) {
  verdicts[e.repo] = (verdicts[e.repo] || 0) + 1;
  if (verdicts[e.repo] > 1) fail.push(`repo decided twice: ${e.repo}`);
}

// task directories: complete, hashed, matching
const dirs = fs.existsSync('tasks') ? fs.readdirSync('tasks') : [];
const dirRepos = [];
for (const d of dirs) {
  const p = `tasks/${d}`;
  for (const f of ['manifest.json','test.patch','gold.patch'])
    if (!fs.existsSync(`${p}/${f}`)) fail.push(`${d}: missing ${f}`);
  if (!fs.existsSync(`${p}/manifest.json`)) continue;
  const m = JSON.parse(fs.readFileSync(`${p}/manifest.json`,'utf8'));
  dirRepos.push(m.repo);
  if (fs.existsSync(`${p}/test.patch`) && sha(`${p}/test.patch`) !== m.test_patch_sha256) fail.push(`${d}: test.patch hash mismatch`);
  if (fs.existsSync(`${p}/gold.patch`) && sha(`${p}/gold.patch`) !== m.gold_patch_sha256) fail.push(`${d}: gold.patch hash mismatch`);
  if (!['pilot','main'].includes(m.role)) fail.push(`${d}: bad role ${m.role}`);
  if (!['single-package','workspace'].includes(m.stratum)) fail.push(`${d}: bad stratum ${m.stratum}`);
}

// bijection: TASK_VALIDATED <-> task dir
for (const r of validated) if (!dirRepos.includes(r)) fail.push(`TASK_VALIDATED without task dir: ${r}`);
for (const r of dirRepos) if (!validated.includes(r)) fail.push(`task dir without TASK_VALIDATED: ${r}`);
const dup = dirRepos.filter((r,i) => dirRepos.indexOf(r) !== i);
for (const r of dup) fail.push(`repo has two task dirs: ${r}`);

// pilot/main separation and quota sanity
const roles = dirs.map(d => JSON.parse(fs.readFileSync(`tasks/${d}/manifest.json`,'utf8')));
const pilots = roles.filter(m => m.role === 'pilot').length;
if (pilots > 3) fail.push(`more than 3 pilot tasks: ${pilots}`);
const mains = roles.filter(m => m.role === 'main');
if (mains.filter(m => m.stratum === 'single-package').length > 15) fail.push('single-package quota exceeded');
if (mains.filter(m => m.stratum === 'workspace').length > 15) fail.push('workspace quota exceeded');

// frozen artifacts unchanged vs origin/main
for (const f of ['frame/frame.json','frame/walk-order.json','frame/npm-high-impact.json','policy.yml']) {
  try {
    const committed = cp.execSync(`git -C ../.. show origin/main:harness/taskbench/${f}`, {maxBuffer: 1<<28});
    const local = fs.readFileSync(f);
    if (crypto.createHash('sha256').update(committed).digest('hex') !== crypto.createHash('sha256').update(local).digest('hex'))
      fail.push(`frozen artifact differs from origin/main: ${f}`);
  } catch (e) { fail.push(`cannot verify frozen artifact ${f}: ${String(e.message).split('\n')[0]}`); }
}

if (fail.length) { console.error('POOL INVARIANTS FAILED:'); for (const f of fail) console.error(' -', f); process.exit(1); }
console.log(`pool invariants OK: ${dirs.length} tasks (${pilots} pilot), ${validated.length} validated records, ${Object.keys(verdicts).length} repos decided, frozen artifacts intact`);
EOF
