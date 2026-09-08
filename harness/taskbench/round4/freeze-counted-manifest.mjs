#!/usr/bin/env node
// Round-4 COUNTED EXECUTION MANIFEST — derive it, or check the frozen one.
//
// This is the faithful counted analog of freeze-pilot-manifest.mjs. It is the
// registration for the 110×2 primary counted run plus the 22×2 duplicate
// instability budget (264 trajectories): which tasks run, in what order, in
// which arm order, which 22 are duplicated, against which treatment, runner and
// environment. It exists so that after the counted round has run anyone can
// establish that the executed order was the REGISTERED order and that no
// identity drifted underneath it — without trusting a narrative.
//
// Nothing here is typed by hand. The order is DERIVED from registered seeds by
// published rules, and every identity is a content hash read off disk. `--check`
// re-derives the whole document and compares it to the frozen file.
//
//   node freeze-counted-manifest.mjs --derive   # write the frozen manifest
//   node freeze-counted-manifest.mjs --check    # re-derive and compare
//   node freeze-counted-manifest.mjs --print    # derive to stdout, write nothing
//   node freeze-counted-manifest.mjs --render   # render the page from the frozen JSON
//
// Exit codes mirror the pilot tool exactly:
//   0  frozen manifest matches the tree
//   2  BINDING drift — an identity that shapes the measurement changed
//   3  RECORDED drift — the environment moved; record it, do not silently accept
//   4  the artefact is not deployed here, so the treatment could not be verified
//   5  usage / structural error
//
// THE THREE DERIVATION RULES ARE REGISTERED, NOT DEFINED HERE. This script only
// IMPLEMENTS them; the authoritative statements live in PREDICTION4-taskbench.md
// (§2 order/arm; the corrections-appendix duplicate rule) and DEVIATIONS D34:
//   - task order:  ids sorted ascending by sha256(`${order_seed}:${id}`)
//   - arm order:   sha256(`${arm_order_seed}:${id}`)[0] % 2 === 0 ? [ungated,gated] : [gated,ungated]
//   - duplicates:  ids sorted ascending by sha256(`${duplicate_seed}:${id}`), ties broken
//                  lexicographically by id, take the first 22
// The duplicate rule was registered IN TEXT before this script existed and before
// any draw; running --derive here therefore post-dates the registration.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.resolve(HERE, '..');            // harness/taskbench
const REPO = path.resolve(TB, '..', '..');      // repository root
const MANIFEST = path.join(HERE, 'COUNTED-EXECUTION-MANIFEST.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (p) => sha256(fs.readFileSync(p));

// ---------------------------------------------------------------- registration
//
// Filled in code, not overridable at the command line: a registration that can
// be overridden is not a registration. The self-test supplies its own via
// TB_COUNTED_FREEZE_TEST, refused for the real manifest path.

const REGISTRATION = {
  // PREDICTION4 §1: the round runs on claude-sonnet-5, the qualified iteration-4
  // apparatus base X4, treatment 2.10.3.
  model: 'claude-sonnet-5',
  // PREDICTION4 §2 (order/arm) and the corrections-appendix duplicate rule (D34).
  // All three are DISTINCT from every pilot seed and from both mining seeds.
  order_seed: 'taskbench4-counted-order-2026-09-07',
  arm_order_seed: 'taskbench4-counted-arm-order-2026-09-07',
  duplicate_seed: 'taskbench4-counted-duplicate-selection-2026-09-07',
  // N and the duplicate budget, from PREDICTION4 §3.
  n_primary: 110,
  n_duplicates: 22,
  derivation:
    'order: task ids sorted by sha256(`${order_seed}:${id}`); ' +
    'arms: sha256(`${arm_order_seed}:${id}`)[0] % 2 === 0 ? [ungated, gated] : [gated, ungated]; ' +
    'duplicates: task ids sorted by sha256(`${duplicate_seed}:${id}`) (ties by id), first 22',
  // The merged harness commit this manifest is frozen against (PREDICTION4 §1).
  base_commit: '0947c9fab4c0798ed870b861977f76be32407aa9',
};

// TB_COUNTED_POOL_DIR is a self-test seam, refused for the real manifest.
const POOL_DIR = process.env.TB_COUNTED_POOL_DIR || path.join(HERE, 'pools', 'counted', 'tasks');

// Everything that SHAPES a trajectory — scripts AND the data they carry — is the
// SAME set that shapes a pilot trajectory: the counted round reuses the identical
// runner. The one difference is the ORDER-ENFORCING DRIVER: the pilot's is
// pilot-drive.sh; the counted round's driver is separate RUN infrastructure that
// does not exist yet, so it is NOT listed here. It is a KNOWN, DISCLOSED gap, not
// a silent one: `counted_driver` below is null and --check refuses to treat the
// binding set as complete-for-execution until a counted driver is registered into
// it. The measurement-shaping runner scripts, however, are all pinned now.
const BINDING_FILES = [
  'runner/run-task4.sh',
  'runner/deploy-gated4.sh',
  'runner/commit-harness-baseline.sh',
  'runner/agent-jail4.sh',
  'runner/net-jail.sh',
  'runner/allowlist-proxy.mjs',
  'runner/observe3.sh',
  'runner/policy-globs.mjs',
  'runner/split-cases-py.mjs',
  'runner/verdict4.mjs',
  'runner/suite-status.mjs',
  'runner/agent-exec-contract.mjs',
  'runner/editable-liveness.py',
  'runner/verdict-record.sh',
  'runner/cleanup-lifecycle4.sh',
  'runner/launcher4.sh',
  'round3/policy3.yml',
];
// The order-enforcing driver for the counted round. Until it exists it is null,
// and the manifest declares itself NOT execution-ready.
const COUNTED_DRIVER = fs.existsSync(path.join(TB, 'round4/counted-drive.sh')) ? 'round4/counted-drive.sh' : null;

const COPIED_INTO_TRAJECTORY = ['runner/observe3.sh', 'runner/policy-globs.mjs', 'round3/policy3.yml'];

const ART_DIR = process.env.TB_ART_DIR || '/opt/tw-artefact-2.10.3';
const ART_PKG = path.join(ART_DIR, 'node_modules', 'tamperward');
const ART_CLI = path.join(ART_PKG, 'dist', 'cli', 'index.js');
const ART_PKG_SHA_EXPECT = '0863d3a84056bb0d9d567a7851224cb5610b73081fa432db19fcc877a532f6d6';

const WIRING_FILES = [
  '.claude/settings.json',
  '.github/CODEOWNERS',
  '.github/workflows/tamperward.yml',
  '.tamperward.yml',
  '.git/hooks/pre-commit',
];

// ------------------------------------------------------------------ derivation

function treeHash(dir) {
  return execFileSync(
    'bash',
    ['-c', 'find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d" " -f1'],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
}

function derivePool() {
  if (!fs.existsSync(POOL_DIR)) fail(5, `pool directory missing: ${POOL_DIR}`);
  // The counted pool is named by directory, not by a contiguous id list: it is
  // the first N validated in walk order, so ids carry the completion sequence.
  // Every directory is admitted (there is no external id whitelist to admit a
  // wrong one — the pool ON DISK is the pool), but each is re-validated.
  const dirs = fs.readdirSync(POOL_DIR).filter((d) => d[0] !== '.').sort();
  const tasks = [];
  for (const id of dirs) {
    const dir = path.join(POOL_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const mfPath = path.join(dir, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    if (mf.role !== 'main') fail(5, `pool: ${id} has role '${mf.role}', expected 'main'`);
    if (mf.id !== id) fail(5, `pool: ${id} manifest id is '${mf.id}'`);
    const testSha = sha256file(path.join(dir, 'test.patch'));
    const goldSha = sha256file(path.join(dir, 'gold.patch'));
    if (testSha !== mf.test_patch_sha256) fail(5, `pool: ${mf.id} test.patch hashes ${testSha}, manifest says ${mf.test_patch_sha256}`);
    if (goldSha !== mf.gold_patch_sha256) fail(5, `pool: ${mf.id} gold.patch hashes ${goldSha}, manifest says ${mf.gold_patch_sha256}`);
    tasks.push({
      id: mf.id,
      repo: mf.repo,
      stratum: mf.stratum,
      parent_sha: mf.parent_sha,
      commit_sha: mf.commit_sha,
      test_patch_sha256: testSha,
      gold_patch_sha256: goldSha,
      manifest_sha256: sha256file(mfPath),
      test_files: mf.test_files,
      python: mf.python,
      uv: mf.uv,
      install_rung: mf.install_rung,
      suite_cmd: mf.suite_cmd,
    });
  }
  return {
    task_count: tasks.length,
    tasks,
    pool_sha256: sha256(tasks.map((t) => `${t.id} ${t.manifest_sha256} ${t.test_patch_sha256} ${t.gold_patch_sha256}\n`).join('')),
  };
}

// The counted order + arm assignment, by the registered keyed-hash rules.
function deriveOrder(ids, reg) {
  return ids
    .map((id) => [sha256(`${reg.order_seed}:${id}`), id])
    .sort()
    .map((x) => x[1]);
}
function deriveArms(order, reg) {
  const rows = [];
  let seq = 0;
  for (const id of order) {
    const b = createHash('sha256').update(`${reg.arm_order_seed}:${id}`).digest()[0];
    const arms = b % 2 === 0 ? ['ungated', 'gated'] : ['gated', 'ungated'];
    for (const arm of arms) rows.push({ seq: ++seq, task: id, arm });
  }
  return rows;
}

// The 22 duplicates, by the registered rule (PREDICTION4 corrections appendix /
// DEVIATIONS D34): sort ids ascending by sha256(`${duplicate_seed}:${id}`), tie
// broken lexicographically by id, take the first n_duplicates.
function deriveDuplicates(ids, reg) {
  return ids
    .map((id) => [sha256(`${reg.duplicate_seed}:${id}`), id])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .slice(0, reg.n_duplicates)
    .map((x) => x[1]);
}

function deriveExecution(ids, reg) {
  if (ids.length !== reg.n_primary) fail(5, `pool has ${ids.length} tasks, registration fixes N=${reg.n_primary}`);
  const order = deriveOrder(ids, reg);
  const primary = deriveArms(order, reg);
  const duplicates = deriveDuplicates(ids, reg);
  // The duplicate instability budget is a SEPARATE block, never part of the
  // N=110 primary denominator (PREDICTION4 §3). It reuses the same registered
  // order + arm mechanisms over the 22 selected ids so nothing new is invented;
  // its trajectories are numbered from n_primary*2 + 1 onward.
  const dupOrder = deriveOrder(duplicates, reg);
  const dupRows = [];
  let seq = primary.length;
  for (const id of dupOrder) {
    const b = createHash('sha256').update(`${reg.arm_order_seed}:${id}`).digest()[0];
    const arms = b % 2 === 0 ? ['ungated', 'gated'] : ['gated', 'ungated'];
    for (const arm of arms) dupRows.push({ seq: ++seq, task: id, arm, duplicate: true });
  }
  return {
    task_order: order,
    primary: { trajectories: primary, trajectory_count: primary.length },
    duplicates: { task_ids: duplicates, trajectories: dupRows, trajectory_count: dupRows.length },
    trajectory_count: primary.length + dupRows.length,
  };
}

function copyClosureViolations() {
  const src = fs.readFileSync(path.join(TB, 'runner/run-task4.sh'), 'utf8');
  const pinned = new Set(BINDING_FILES.map((f) => path.basename(f)));
  const declared = new Set(COPIED_INTO_TRAJECTORY.map((f) => path.basename(f)));
  const found = new Set();
  for (const line of src.split('\n')) {
    if (!/^\s*cp\s/.test(line) || !line.includes('OBSTOOL')) continue;
    for (const m of line.matchAll(/"\$(?:HERE|TB)\/([^"]+)"/g)) found.add(path.basename(m[1]));
  }
  const out = [];
  for (const f of found) {
    if (!pinned.has(f)) out.push(`run-task4.sh copies ${f} into the trajectory but it is not in the binding set`);
    if (!declared.has(f)) out.push(`run-task4.sh copies ${f} into the trajectory but COPIED_INTO_TRAJECTORY does not list it`);
  }
  for (const f of declared) {
    if (!found.has(f)) out.push(`COPIED_INTO_TRAJECTORY lists ${f}, but run-task4.sh no longer copies it`);
  }
  return out;
}

function deriveBindingSet() {
  const files = BINDING_FILES.map((rel) => {
    const p = path.join(TB, rel);
    if (!fs.existsSync(p)) fail(5, `binding file missing: ${rel}`);
    return { path: rel, sha256: sha256file(p) };
  });
  return {
    files,
    copied_into_trajectory: COPIED_INTO_TRAJECTORY,
    // The order-enforcing driver. null until a counted driver is registered; the
    // manifest is NOT execution-ready while it is null (see execution_ready).
    counted_driver: COUNTED_DRIVER ? { path: COUNTED_DRIVER, sha256: sha256file(path.join(TB, COUNTED_DRIVER)) } : null,
    binding_set_sha256: sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join('')),
  };
}

function deriveTreatment() {
  if (!fs.existsSync(ART_PKG)) return null;
  const pkg = treeHash(ART_PKG);
  const version = JSON.parse(fs.readFileSync(path.join(ART_PKG, 'package.json'), 'utf8')).version;
  const scratch = fs.mkdtempSync('/tmp/tb4c-wiring-');
  let wiring;
  try {
    execFileSync('git', ['init', '-q', '.'], { cwd: scratch });
    execFileSync('git', ['config', 'user.email', 'freeze@local'], { cwd: scratch });
    execFileSync('git', ['config', 'user.name', 'freeze'], { cwd: scratch });
    execFileSync(process.execPath, [ART_CLI, 'init'], { cwd: scratch, stdio: 'ignore' });
    const rows = WIRING_FILES.map((rel) => {
      const p = path.join(scratch, rel);
      if (!fs.existsSync(p)) fail(5, `tamperward init did not write ${rel}`);
      return { path: rel, sha256: sha256file(p) };
    });
    wiring = { files: rows, wiring_sha256: sha256(rows.map((f) => `${f.sha256}  ${f.path}\n`).join('')) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    version,
    artefact_dir: ART_DIR,
    artefact_pkg_tree_sha256: pkg,
    artefact_pin_matches: pkg === ART_PKG_SHA_EXPECT,
    init_wiring: wiring,
  };
}

const cmd = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

function deriveEnvironment() {
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    kernel: cmd('uname', ['-r']),
    python3: cmd('python3', ['--version']),
    uv: cmd('uv', ['--version']),
    claude_cli: cmd('claude', ['--version']),
  };
}

function derive() {
  const reg = testRegistration() || REGISTRATION;
  const pool = derivePool();
  const execution = deriveExecution(pool.tasks.map((t) => t.id), reg);
  const treatment = deriveTreatment();
  const binding_set = deriveBindingSet();
  return {
    schema: 'tamperward.round4.counted-execution-manifest/1',
    registration: reg,
    pool,
    execution,
    treatment,
    binding_set,
    // A counted trajectory may NOT run until an order-enforcing driver is pinned
    // into the binding set. This is the one piece the pilot has (pilot-drive.sh)
    // that the counted round does not yet — declared, never silent.
    execution_ready: binding_set.counted_driver !== null,
    environment_recorded: deriveEnvironment(),
    notes: {
      binding: 'registration, pool, execution, treatment, binding_set — a change to any invalidates the freeze',
      recorded: 'environment_recorded — captured for provenance; a difference is a deviation to record, not a silent change',
      arms: 'ungated = parent-owned observer only; gated = the complete frozen v2 envelope',
      duplicates: 'the 22 duplicate trajectories are a SEPARATE instability budget and NEVER enter the N=110 primary denominator',
      execution_ready: 'false until a counted order-enforcing driver (round4/counted-drive.sh) is built and pinned into the binding set',
      credential: 'not represented here; provisioned outside the repository, only its fingerprint recorded per trajectory by run-task4.sh',
    },
  };
}

function testRegistration() {
  const raw = process.env.TB_COUNTED_FREEZE_TEST;
  if (!raw) return null;
  return { ...REGISTRATION, ...JSON.parse(raw) };
}

function fail(code, msg) {
  process.stderr.write(`freeze-counted-manifest: ${msg}\n`);
  process.exit(code);
}

const render = (obj) => `${JSON.stringify(obj, null, 1)}\n`;

function renderMarkdown(m, jsonSha) {
  const t = (xs) => xs.join('\n');
  const head = (rows, n) => t(rows.slice(0, n).map((r) => `| ${r.seq} | \`${r.task}\` | **${r.arm}**${r.duplicate ? ' | dup' : ''} |`));
  const dupList = m.execution.duplicates.task_ids.map((x) => `\`${x}\``).join(', ');
  const binding = t(m.binding_set.files.map((f) => `| \`${f.path}\` | \`${f.sha256.slice(0, 16)}…\` |`));
  const tr = m.treatment;
  const wiring = tr ? t(tr.init_wiring.files.map((f) => `| \`${f.path}\` | \`${f.sha256.slice(0, 16)}…\` |`))
                    : '| _(no artefact deployed on the host that derived this)_ | |';
  const env = t(Object.entries(m.environment_recorded).map(([k, v]) => `| ${k} | \`${v}\` |`));
  return `# Round 4 — counted execution manifest

**${m.execution_ready ? 'Frozen.' : 'Frozen (NOT execution-ready — no counted driver pinned yet).'}** This is the
registration for the ${m.registration.n_primary}×2 primary counted run plus the
${m.registration.n_duplicates}×2 duplicate instability budget. It is generated, never typed:
\`freeze-counted-manifest.mjs --derive\` produces it and \`--check\` re-derives and compares.

| | |
|---|---|
| manifest | \`COUNTED-EXECUTION-MANIFEST.json\` |
| sha256 | \`${jsonSha}\` |
| base harness commit | \`${m.registration.base_commit}\` |
| model | \`${m.registration.model}\` |
| order seed | \`${m.registration.order_seed}\` |
| arm-order seed | \`${m.registration.arm_order_seed}\` |
| duplicate-selection seed | \`${m.registration.duplicate_seed}\` |
| N primary / duplicates | ${m.registration.n_primary} / ${m.registration.n_duplicates} |
| tasks / trajectories | ${m.pool.task_count} / ${m.execution.trajectory_count} |
| execution ready | ${m.execution_ready ? 'yes' : '**no — counted driver not yet pinned**'} |

**Nothing here is a counted result.** No trajectory has run and the credential is
not provisioned. Freezing this before trajectory one is the point.

## Derivation (registered, not chosen)

> ${m.registration.derivation}

The order, arm and duplicate seeds are all distinct from every pilot seed and both
mining seeds. \`--check\` re-derives the order, arms and the 22 duplicates from the
manifest's own seeds, so any of them edited by hand is caught.

## Duplicate set — ${m.registration.n_duplicates} of ${m.registration.n_primary}

A SEPARATE instability budget; these are re-runs of tasks already in the primary
${m.registration.n_primary}, and **never** enter the primary denominator:

${dupList}

## Execution — ${m.execution.trajectory_count} trajectories (${m.execution.primary.trajectory_count} primary + ${m.execution.duplicates.trajectory_count} duplicate)

First 10 primary trajectories (a task's two arms run adjacently):

| seq | task | arm |
|---|---|---|
${head(m.execution.primary.trajectories, 10)}

## Treatment — ${tr ? `v${tr.version}` : 'NOT VERIFIED HERE'}

| | |
|---|---|
| artefact | \`${tr ? tr.artefact_dir : 'not deployed here'}\` |
| package tree sha256 | \`${tr ? tr.artefact_pkg_tree_sha256 : '— unverifiable on this host'}\` |
| init wiring sha256 | \`${tr ? tr.init_wiring.wiring_sha256 : '— unverifiable on this host'}\` |

${tr ? `| file | sha256 |\n|---|---|\n${wiring}` : wiring}

## Binding set — everything that shapes a trajectory

Scripts and the data they carry, the SAME measurement-shaping set as the pilot
(the counted round reuses the identical runner). Combined hash:
\`${m.binding_set.binding_set_sha256}\`.

**Order-enforcing driver:** ${m.binding_set.counted_driver ? `\`${m.binding_set.counted_driver.path}\`` : '**not yet built** — the counted round has no order-enforcing driver pinned. This manifest is therefore **not execution-ready**; a counted driver (the analog of `pilot-drive.sh`) must be built and pinned before trajectory one.'}

| file | sha256 |
|---|---|
${binding}

## Environment — recorded, not binding

| | |
|---|---|
${env}

## The credential is not represented here

It is provisioned outside the repository, short-lived and spending-limited, and
only its fingerprint is recorded — per trajectory — by \`run-task4.sh\`.
`;
}

// ----------------------------------------------------------------------- modes

const mode = process.argv[2];
const target = process.env.TB_COUNTED_MANIFEST || MANIFEST;
if (mode === '--derive' || mode === '--check') {
  for (const seam of ['TB_COUNTED_FREEZE_TEST', 'TB_COUNTED_POOL_DIR']) {
    if (process.env[seam] && path.resolve(target) === MANIFEST) {
      fail(5, `${seam} is a self-test seam and must not be set against the real manifest`);
    }
  }
}
const mdTarget = target.replace(/\.json$/, '.md');

if (mode === '--print') { process.stdout.write(render(derive())); process.exit(0); }

if (mode === '--render') {
  if (!fs.existsSync(target)) fail(5, `no frozen manifest at ${target}`);
  const raw = fs.readFileSync(target, 'utf8');
  process.stdout.write(renderMarkdown(JSON.parse(raw), sha256(raw)));
  process.exit(0);
}

if (mode === '--derive') {
  const doc = derive();
  const rendered = render(doc);
  if (fs.existsSync(target)) {
    const cur = fs.readFileSync(target, 'utf8');
    if (cur === rendered) {
      fs.writeFileSync(mdTarget, renderMarkdown(doc, sha256(rendered)));
      process.stdout.write(`unchanged: ${target}\n  page re-rendered: ${mdTarget}\n`);
      process.exit(0);
    }
    if (process.env.TB_COUNTED_REFREEZE !== '1') {
      fail(2, `${target} exists and differs. Re-freezing is a registered act: set TB_COUNTED_REFREEZE=1 and record the reason append-only in DEVIATIONS.md`);
    }
  }
  if (!doc.treatment) fail(4, `the artefact is not deployed at ${ART_PKG} — a manifest cannot be frozen without the treatment identity`);
  if (!doc.treatment.artefact_pin_matches) fail(2, `artefact tree ${doc.treatment.artefact_pkg_tree_sha256} != pinned ${ART_PKG_SHA_EXPECT}`);
  fs.writeFileSync(target, rendered);
  fs.writeFileSync(mdTarget, renderMarkdown(doc, sha256(rendered)));
  process.stdout.write(`froze ${target}\n  and rendered ${mdTarget}\n  manifest sha256: ${sha256(rendered)}\n`);
  if (!doc.execution_ready) process.stdout.write(`  NOTE: execution_ready=false — a counted driver must be pinned before any trajectory runs.\n`);
  process.exit(0);
}

if (mode === '--check') {
  if (!fs.existsSync(target)) fail(5, `no frozen manifest at ${target}`);
  const frozenRaw = fs.readFileSync(target, 'utf8');
  const frozen = JSON.parse(frozenRaw);
  const now = derive();
  const noArtefact = process.env.TB_COUNTED_CHECK_NO_ARTEFACT === '1';
  let binding = 0, recorded = 0;
  const driftLines = [];
  const cmp = (label, a, b) => {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x === y) return true;
    process.stdout.write(`  BINDING DRIFT  ${label}\n    frozen:  ${x}\n    on disk: ${y}\n`);
    binding++; return false;
  };
  process.stdout.write(`counted execution manifest: ${target}\n  sha256: ${sha256(frozenRaw)}\n\n`);
  if (frozen.schema !== now.schema) cmp('schema', frozen.schema, now.schema);
  cmp('registration', frozen.registration, now.registration);
  cmp('pool', frozen.pool, now.pool);
  cmp('binding_set', frozen.binding_set, now.binding_set);
  for (const v of copyClosureViolations()) { process.stdout.write(`  BINDING DRIFT  ${v}\n`); binding++; }
  // Re-derive the execution (order, arms, duplicates) from the frozen seeds AND
  // from the on-disk pool — a recorded draw that does not follow from its own
  // seeds is the forgery this document exists to make impossible.
  cmp('execution (re-derived from the frozen seeds)', frozen.execution, deriveExecution(frozen.pool.tasks.map((t) => t.id), frozen.registration));
  cmp('execution (re-derived from the on-disk pool)', frozen.execution, now.execution);
  if (!now.treatment) {
    process.stdout.write(`  treatment: artefact NOT deployed at ${ART_PKG} — treatment identity UNVERIFIED\n`);
    if (!noArtefact) { process.stdout.write('\nRESULT: cannot verify the treatment here (set TB_COUNTED_CHECK_NO_ARTEFACT=1 to accept that)\n'); process.exit(4); }
  } else {
    cmp('treatment', frozen.treatment, now.treatment);
    if (!now.treatment.artefact_pin_matches) { process.stdout.write(`  BINDING DRIFT  artefact pin: tree != ${ART_PKG_SHA_EXPECT}\n`); binding++; }
  }
  if (process.env.TB_COUNTED_CHECK_BINDING_ONLY === '1') {
    process.stdout.write('  environment: comparison SKIPPED (TB_COUNTED_CHECK_BINDING_ONLY=1)\n');
  } else {
    for (const [k, v] of Object.entries(now.environment_recorded)) {
      const was = frozen.environment_recorded?.[k];
      if (JSON.stringify(was) !== JSON.stringify(v)) {
        process.stdout.write(`  recorded drift  environment.${k}\n    frozen:  ${was}\n    on disk: ${v}\n`);
        driftLines.push(`${k}:${JSON.stringify(was)}=>${JSON.stringify(v)}`); recorded++;
      }
    }
  }
  if (!fs.existsSync(mdTarget)) { process.stdout.write(`  BINDING DRIFT  the rendered page ${mdTarget} is missing\n`); binding++; }
  else if (fs.readFileSync(mdTarget, 'utf8') !== renderMarkdown(frozen, sha256(frozenRaw))) { process.stdout.write('  BINDING DRIFT  the rendered page is not what this manifest renders to\n'); binding++; }
  if (frozen.execution_ready === false) process.stdout.write('  NOTE: execution_ready=false — no counted driver pinned; no trajectory may run until one is.\n');
  process.stdout.write(`\n  binding drift: ${binding}   recorded drift: ${recorded}\n`);
  if (binding > 0) { process.stdout.write('RESULT: BINDING DRIFT — the frozen manifest no longer describes this tree. The counted round must not run.\n'); process.exit(2); }
  if (recorded > 0) {
    process.stdout.write(`  environment drift fingerprint: ${sha256(driftLines.slice().sort().join('\n'))}\n`);
    process.stdout.write('RESULT: environment drift — acknowledge it explicitly, then proceed.\n'); process.exit(3);
  }
  process.stdout.write('RESULT: the frozen manifest describes this tree exactly.\n');
  process.exit(0);
}

process.stderr.write(`usage: freeze-counted-manifest.mjs --derive | --check | --print | --render\n`);
process.exit(5);
