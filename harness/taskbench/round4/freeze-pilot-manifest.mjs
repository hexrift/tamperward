#!/usr/bin/env node
// Round-4 PILOT EXECUTION MANIFEST — derive it, or check the frozen one.
//
// The pilot execution manifest is the registration for the 10x2 sacrificial
// pilot: which tasks run, in what order, in which arm order, against which
// treatment, runner and environment. It exists so that after the pilot has run
// anyone can establish that the executed order was the REGISTERED order and
// that no identity drifted underneath it — without trusting a narrative.
//
// Nothing here is typed by hand. The order is DERIVED from two registered
// seeds by a published rule, and every identity is a content hash read off
// disk. `--check` re-derives the whole document and compares it to the frozen
// file, so a manifest that no longer describes the tree cannot pass silently.
//
//   node freeze-pilot-manifest.mjs --derive   # write the frozen manifest
//   node freeze-pilot-manifest.mjs --check    # re-derive and compare
//   node freeze-pilot-manifest.mjs --print    # derive to stdout, write nothing
//
// Exit codes are distinct because they mean different things to an operator:
//   0  frozen manifest matches the tree
//   2  BINDING drift — an identity that shapes the measurement changed
//   3  RECORDED drift — the environment moved; a deviation to record, not a
//      silent difference (the pilot may proceed only once it is recorded)
//   4  the artefact is not deployed here, so the treatment could not be
//      verified (allowed only under TB_PILOT_CHECK_NO_ARTEFACT=1, which CI sets)
//   5  usage / structural error
//
// BINDING vs RECORDED is the whole design. A binding field is one whose change
// would change what the pilot measures: the pool, the order, the seeds, the
// artefact, the runner scripts, the model. A recorded field is one that varies
// with the machine and must be captured but cannot be frozen in advance: the
// CLI build, the kernel. Freezing a recorded field would make the manifest
// unusable on the next host; ignoring it would lose the provenance.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TB = path.resolve(HERE, '..');            // harness/taskbench
const REPO = path.resolve(TB, '..', '..');      // repository root
const MANIFEST = path.join(HERE, 'PILOT-EXECUTION-MANIFEST.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256file = (p) => sha256(fs.readFileSync(p));

// ---------------------------------------------------------------- registration
//
// Filled here, deliberately in code rather than in an environment variable: a
// registration that can be overridden at the command line is not a
// registration. The self-test supplies its own via TB_PILOT_FREEZE_TEST, which
// is refused for the real manifest path.

const REGISTRATION = {
  // FRAME5 "Model": the round-3.1 snapshot if still servable, else one newly
  // pinned ID. `claude-sonnet-5` is therefore the registered default and not a
  // choice made here. Servability is confirmed when the pilot credential is
  // provisioned; if the snapshot is gone, freeze 1's fallback applies and this
  // manifest is re-frozen (append-only, with the reason) BEFORE trajectory one.
  model: 'claude-sonnet-5',
  // Distinct from every counted seed and from both mining seeds, so the pilot
  // cannot perturb the counted draw.
  trajectory_order_seed: 'taskbench4-pilot-trajectory-order-v1-2026-09-04',
  arm_order_seed: 'taskbench4-pilot-arm-order-v1-2026-09-04',
  // The rule rounds 1-3.1 all used, restated so the derivation is checkable
  // from the document alone.
  derivation:
    'order: task ids sorted by sha256(`${trajectory_order_seed}:${id}`); ' +
    'arms: sha256(`${arm_order_seed}:${id}`)[0] % 2 === 0 ? [ungated, gated] : [gated, ungated]',
  // The merged harness commit this manifest is frozen against.
  base_commit: '08a1d42b596e142f336f24b9b5c5ceb6bcc005e4',
};

// The ten FRESH tasks. Ids 01-10 are disclosed development data and are
// excluded by id, not by a filter that could quietly admit them.
const POOL_IDS = ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20'];
// TB_PILOT_POOL_DIR is a self-test seam, refused for the real manifest by the
// same guard as TB_PILOT_FREEZE_TEST.
const POOL_DIR = process.env.TB_PILOT_POOL_DIR || path.join(HERE, 'pools', 'pilot', 'tasks');

// The scripts that SHAPE a trajectory. Editing any of them changes what the
// pilot measures, so each is pinned individually. Self-tests and fixtures under
// runner/ are deliberately NOT here — they cannot reach a trajectory — but the
// whole runner tree is hashed as a recorded field so their movement is still
// visible rather than invisible.
const RUNNER_FILES = [
  'runner/run-task4.sh',        // the trajectory runner itself
  'runner/deploy-gated4.sh',    // writes the gated arm's deployment
  'runner/agent-jail4.sh',      // mount/PID/capability separation, both arms
  'runner/net-jail.sh',         // network isolation, both arms
  'runner/allowlist-proxy.mjs', // the only egress path out of the jail
  'runner/observe3.sh',         // the parent-owned PostToolUse observer
  'runner/policy-globs.mjs',    // the observer's protected-surface matcher
  'runner/split-cases-py.mjs',  // pytest case extraction for the oracle
  'runner/verdict4.mjs',        // the neutral adjudicator: the outcome source
  'runner/verdict-record.sh',   // what counts as a verdict at all
  'runner/cleanup-lifecycle4.sh', // the cleanup contract the runner is held to
  'runner/launcher4.sh',        // the immutable bare-launcher deployment gate
];

const ART_DIR = process.env.TB_ART_DIR || '/opt/tw-artefact-2.10.2';
const ART_PKG = path.join(ART_DIR, 'node_modules', 'tamperward');
const ART_CLI = path.join(ART_PKG, 'dist', 'cli', 'index.js');
// Independently stated, not read from run-task4.sh: two files that must agree
// is a check; one file read twice is not.
const ART_PKG_SHA_EXPECT = 'a0328112d99451e998037a3b26005c622590f9e5dee075db7606419a06ad3458';

// The files `tamperward init` writes. Named explicitly so that init writing one
// FEWER file is caught: hashing "whatever appeared" would silently accept a
// deployment that stopped writing the pre-commit hook.
const WIRING_FILES = [
  '.claude/settings.json',
  '.github/CODEOWNERS',
  '.github/workflows/tamperward.yml',
  '.tamperward.yml',
  '.git/hooks/pre-commit',
];

// ------------------------------------------------------------------ derivation

// Canonical tree hash. This SHELLS OUT to the exact pipeline run-task4.sh,
// launcher4.sh and deploy-gated4.sh use, rather than reimplementing it, so
// there is one definition of "the artefact's identity" in the project and not
// two that must be kept in agreement.
//
// A first version of this function did reimplement it in JS and produced a
// different digest for a byte-identical tree, because `sha256sum` prints
// `./path` and the reimplementation printed `path`. The pin comparison caught
// it. A tree hash that cannot reproduce the value everything else pins against
// is worse than no tree hash: it is a check that always fails, and a check that
// always fails gets disabled.
function treeHash(dir) {
  return execFileSync(
    'bash',
    ['-c', 'find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d" " -f1'],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
}

function derivePool() {
  if (!fs.existsSync(POOL_DIR)) fail(5, `pool directory missing: ${POOL_DIR}`);
  const dirs = fs.readdirSync(POOL_DIR).sort();
  const tasks = [];
  for (const id of POOL_IDS) {
    const matches = dirs.filter((d) => d.startsWith(`${id}-`));
    if (matches.length !== 1) fail(5, `pool: expected exactly one task directory for id ${id}, found ${matches.length}`);
    const dir = path.join(POOL_DIR, matches[0]);
    const mfPath = path.join(dir, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    if (mf.role !== 'pilot') fail(5, `pool: ${matches[0]} has role '${mf.role}', expected 'pilot'`);
    if (mf.id !== matches[0]) fail(5, `pool: ${matches[0]} manifest id is '${mf.id}'`);
    // Re-hash the patches rather than copying the manifest's own claim: the
    // point is to pin what is ON DISK, and a manifest that disagrees with its
    // own patches must not be able to certify itself.
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
    // One hash over the whole pool, so a driver can pin the pool with a single
    // value instead of ten.
    pool_sha256: sha256(tasks.map((t) => `${t.id} ${t.manifest_sha256} ${t.test_patch_sha256} ${t.gold_patch_sha256}\n`).join('')),
  };
}

function deriveOrder(ids, reg) {
  const order = ids
    .map((id) => [sha256(`${reg.trajectory_order_seed}:${id}`), id])
    .sort()
    .map((x) => x[1]);
  const rows = [];
  let seq = 0;
  for (const id of order) {
    const b = createHash('sha256').update(`${reg.arm_order_seed}:${id}`).digest()[0];
    const arms = b % 2 === 0 ? ['ungated', 'gated'] : ['gated', 'ungated'];
    for (const arm of arms) rows.push({ seq: ++seq, task: id, arm });
  }
  return { task_order: order, trajectories: rows, trajectory_count: rows.length };
}

function deriveRunner() {
  const files = RUNNER_FILES.map((rel) => {
    const p = path.join(TB, rel);
    if (!fs.existsSync(p)) fail(5, `runner file missing: ${rel}`);
    return { path: rel, sha256: sha256file(p) };
  });
  return {
    files,
    runner_sha256: sha256(files.map((f) => `${f.sha256}  ${f.path}\n`).join('')),
  };
}

// The treatment identity: the artefact tree as deployed, plus the wiring that
// `tamperward init` actually produces from it. The artefact hash alone says
// which bytes are installed; the wiring hash says what those bytes DO to a
// repository, which is the thing the gated arm is.
function deriveTreatment() {
  if (!fs.existsSync(ART_PKG)) return null;
  const pkg = treeHash(ART_PKG);
  const version = JSON.parse(fs.readFileSync(path.join(ART_PKG, 'package.json'), 'utf8')).version;
  const scratch = fs.mkdtempSync('/tmp/tb4-wiring-');
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
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function deriveEnvironment() {
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    kernel: cmd('uname', ['-r']),
    python3: cmd('python3', ['--version']),
    uv: cmd('uv', ['--version']),
    // Recorded, never binding: the CLI build moves under us, and run-task4.sh
    // already captures the banner into every trajectory's provenance record,
    // which is where the per-trajectory truth lives.
    claude_cli: cmd('claude', ['--version']),
  };
}

function derive() {
  const reg = testRegistration() || REGISTRATION;
  const pool = derivePool();
  const order = deriveOrder(pool.tasks.map((t) => t.id), reg);
  const treatment = deriveTreatment();
  return {
    schema: 'tamperward.round4.pilot-execution-manifest/1',
    registration: reg,
    pool,
    execution: order,
    treatment,
    runner: deriveRunner(),
    environment_recorded: deriveEnvironment(),
    notes: {
      binding:
        'registration, pool, execution, treatment, runner — a change to any of these ' +
        'changes what the pilot measures and invalidates the freeze',
      recorded:
        'environment_recorded — captured for provenance; it moves with the host, so ' +
        'a difference is a deviation to record before trajectory one, not a silent change',
      arms: 'ungated = parent-owned observer only; gated = the complete frozen v2 envelope',
      credential:
        'not represented here. The pilot credential is provisioned outside the repository ' +
        'and only its fingerprint is recorded, per trajectory, by run-task4.sh',
    },
  };
}

// A self-test seam, loudly named. It cannot reach the real manifest: --derive
// and --check refuse to touch PILOT-EXECUTION-MANIFEST.json while it is set.
function testRegistration() {
  const raw = process.env.TB_PILOT_FREEZE_TEST;
  if (!raw) return null;
  const t = JSON.parse(raw);
  return { ...REGISTRATION, ...t };
}

function fail(code, msg) {
  process.stderr.write(`freeze-pilot-manifest: ${msg}\n`);
  process.exit(code);
}

// Canonical JSON: stable key order (insertion order, which is fixed by the
// code above) and a trailing newline, so byte comparison is meaningful.
const render = (obj) => `${JSON.stringify(obj, null, 1)}\n`;


// The human-readable page is RENDERED from the frozen JSON, never written by
// hand, for the same reason the JSON is derived: a prose copy maintained beside
// a machine copy is two sources that must agree, and they stop agreeing.
// `--check` asserts the committed page is exactly what this produces.
function renderMarkdown(m, jsonSha) {
  const t = (xs) => xs.join('\n');
  const rows = t(m.execution.trajectories.map((r) => `| ${r.seq} | \`${r.task}\` | **${r.arm}** |`));
  const pool = t(m.pool.tasks.map((x) => `| \`${x.id}\` | ${x.repo} | \`${x.parent_sha.slice(0, 10)}\` | \`${x.test_files.join(', ')}\` |`));
  const runner = t(m.runner.files.map((f) => `| \`${f.path}\` | \`${f.sha256.slice(0, 16)}…\` |`));
  const wiring = t(m.treatment.init_wiring.files.map((f) => `| \`${f.path}\` | \`${f.sha256.slice(0, 16)}…\` |`));
  const env = t(Object.entries(m.environment_recorded).map(([k, v]) => `| ${k} | \`${v}\` |`));
  const first = m.execution.trajectories[0];
  return `# Round 4 — pilot execution manifest

**Frozen.** This is the registration for the 10×2 sacrificial pilot. It is
generated, never typed: \`freeze-pilot-manifest.mjs --derive\` produces it and
\`--check\` re-derives the whole document and compares. The authoritative copy is
the JSON beside this file; this page is rendered from it by \`--render\`, and
\`--check\` fails if the two have drifted apart.

| | |
|---|---|
| manifest | \`PILOT-EXECUTION-MANIFEST.json\` |
| sha256 | \`${jsonSha}\` |
| base harness commit | \`${m.registration.base_commit}\` |
| model | \`${m.registration.model}\` |
| trajectory-order seed | \`${m.registration.trajectory_order_seed}\` |
| arm-order seed | \`${m.registration.arm_order_seed}\` |
| tasks / trajectories | ${m.pool.task_count} / ${m.execution.trajectory_count} |

**Nothing here is a pilot result.** No trajectory has run and the credential is
not provisioned. Freezing this before trajectory one is the point: an order
chosen after seeing an outcome is not an order.

## Verify before trajectory one

\`\`\`
node harness/taskbench/round4/freeze-pilot-manifest.mjs --check
\`\`\`

| exit | meaning |
|---|---|
| 0 | the frozen manifest describes this tree exactly — proceed |
| 2 | **binding drift** — something that shapes the measurement changed. The pilot must not run |
| 3 | **environment drift** — record it in \`DEVIATIONS.md\`, then proceed |
| 4 | the artefact is not deployed here, so the treatment could not be verified |

**Binding** identities (registration, pool, execution order, treatment, runner)
are frozen: a change to any of them changes what the pilot measures.
**Recorded** identities (the host environment) move with the machine, so they
are captured for provenance and a difference is a deviation to record, not a
silent change. Freezing a recorded field would make the manifest unusable on the
next host; ignoring it would lose the provenance.

## Derivation

The order is not chosen, it is derived, by the rule rounds 1–3.1 all used:

> ${m.registration.derivation}

Both seeds are distinct from every counted seed and from both mining seeds, so
nothing the pilot does perturbs the counted draw. \`--check\` re-derives the order
from the manifest's own seeds, so an order edited by hand is caught even though
the pool and the seeds beside it are untouched.

## Execution order — ${m.execution.trajectory_count} trajectories

The **joint dry run is seq 1**: \`${first.task}\`, ${first.arm} arm. The remaining
19 follow in this order. A task's two arms run adjacently.

| seq | task | arm |
|---|---|---|
${rows}

\`ungated\` = the parent-owned observer only. \`gated\` = the complete frozen v2
envelope. Isolation is applied symmetrically to both.

## Pool — the fresh ten

Ids \`01\`–\`10\` are disclosed development data and are excluded by id, not by a
filter that could quietly admit them. Every patch is re-hashed from disk at
derivation time: a task manifest cannot certify its own patches.

| id | repository | parent | protected test file |
|---|---|---|---|
${pool}

Pool hash: \`${m.pool.pool_sha256}\`

## Treatment — v${m.treatment.version}

| | |
|---|---|
| artefact | \`${m.treatment.artefact_dir}\` |
| package tree sha256 | \`${m.treatment.artefact_pkg_tree_sha256}\` |
| init wiring sha256 | \`${m.treatment.init_wiring.wiring_sha256}\` |

The artefact hash says which bytes are installed. The **wiring** hash says what
those bytes do to a repository, and is derived by actually running
\`tamperward init\` from the artefact into a scratch repository and hashing what
it writes — the deployment rule executed rather than asserted:

| file | sha256 |
|---|---|
${wiring}

## Runner — the scripts that shape a trajectory

Editing any of these changes what the pilot measures, so each is pinned
individually. Self-tests and fixtures under \`runner/\` are deliberately absent:
they cannot reach a trajectory. The whole \`runner/\` tree is not pinned, so their
movement stays visible without being binding.

| file | sha256 |
|---|---|
${runner}

Combined runner hash: \`${m.runner.runner_sha256}\`

## Environment — recorded, not binding

| | |
|---|---|
${env}

The Claude CLI build is recorded here and captured again per trajectory by
\`run-task4.sh\`, which is where the per-trajectory truth lives.

## The credential is not represented here

It is provisioned outside the repository, short-lived and spending-limited, and
only its **fingerprint** is recorded — a one-way sha256 prefix, per trajectory.
It remains reachable symmetrically in both arms, which is the disclosed
\`⚠ partial\` sub-item of the isolation checklist (DEVIATIONS "Credential
isolation"), never a whole-item pass.

## Re-freezing

Re-freezing is a registered act, not a convenience: \`--derive\` refuses to
overwrite a manifest that differs unless \`TB_PILOT_REFREEZE=1\` is set, and the
reason belongs in \`DEVIATIONS.md\`, append-only. The one anticipated cause is the
model: FRAME5 registers the round-3.1 \`claude-sonnet-5\` snapshot **if still
servable**, else one newly pinned ID. Servability is confirmed when the
credential is provisioned; if the snapshot is gone, freeze 1's fallback applies
and this manifest is re-frozen **before** trajectory one.
`;
}

// ----------------------------------------------------------------------- modes

const mode = process.argv[2];
const target = process.env.TB_PILOT_MANIFEST || MANIFEST;
// The seams are refused wherever the REAL manifest is at stake. `--print`
// writes nothing and validates nothing, so it is the mode the self-test drives
// them through.
if (mode === '--derive' || mode === '--check') {
  for (const seam of ['TB_PILOT_FREEZE_TEST', 'TB_PILOT_POOL_DIR']) {
    if (process.env[seam] && path.resolve(target) === MANIFEST) {
      fail(5, `${seam} is a self-test seam and must not be set against the real manifest`);
    }
  }
}

const MD = MANIFEST.replace(/\.json$/, '.md');
const mdTarget = target.replace(/\.json$/, '.md');

if (mode === '--print') {
  process.stdout.write(render(derive()));
  process.exit(0);
}

if (mode === '--render') {
  if (!fs.existsSync(target)) fail(5, `no frozen manifest at ${target}`);
  const raw = fs.readFileSync(target, 'utf8');
  process.stdout.write(renderMarkdown(JSON.parse(raw), sha256(raw)));
  process.exit(0);
}

if (mode === '--derive') {
  const doc = derive();
  if (!doc.treatment) fail(4, `the artefact is not deployed at ${ART_PKG} — a manifest cannot be frozen without the treatment identity`);
  if (!doc.treatment.artefact_pin_matches) {
    fail(2, `artefact tree ${doc.treatment.artefact_pkg_tree_sha256} != pinned ${ART_PKG_SHA_EXPECT}`);
  }
  const rendered = render(doc);
  if (fs.existsSync(target)) {
    const cur = fs.readFileSync(target, 'utf8');
    if (cur === rendered) {
      // The page is re-rendered even on the unchanged path. An early return
      // here could never restore a page that had been deleted or edited, so
      // --derive would report success while --check reported drift.
      fs.writeFileSync(mdTarget, renderMarkdown(doc, sha256(rendered)));
      process.stdout.write(`unchanged: ${target}\n  page re-rendered: ${mdTarget}\n`);
      process.exit(0);
    }
    if (process.env.TB_PILOT_REFREEZE !== '1') {
      fail(2, `${target} exists and differs. Re-freezing is a registered act: set TB_PILOT_REFREEZE=1 and record the reason append-only in DEVIATIONS.md`);
    }
  }
  fs.writeFileSync(target, rendered);
  fs.writeFileSync(mdTarget, renderMarkdown(doc, sha256(rendered)));
  process.stdout.write(`froze ${target}\n  and rendered ${mdTarget}\n  manifest sha256: ${sha256(rendered)}\n`);
  process.exit(0);
}

if (mode === '--check') {
  if (!fs.existsSync(target)) fail(5, `no frozen manifest at ${target}`);
  const frozenRaw = fs.readFileSync(target, 'utf8');
  const frozen = JSON.parse(frozenRaw);
  const now = derive();
  const noArtefact = process.env.TB_PILOT_CHECK_NO_ARTEFACT === '1';
  let binding = 0;
  let recorded = 0;

  const cmp = (label, a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    if (x === y) return true;
    process.stdout.write(`  BINDING DRIFT  ${label}\n    frozen:  ${x}\n    on disk: ${y}\n`);
    binding++;
    return false;
  };

  process.stdout.write(`pilot execution manifest: ${target}\n  sha256: ${sha256(frozenRaw)}\n\n`);

  if (frozen.schema !== now.schema) cmp('schema', frozen.schema, now.schema);
  cmp('registration', frozen.registration, now.registration);
  cmp('pool', frozen.pool, now.pool);
  cmp('runner', frozen.runner, now.runner);

  // The order is not merely compared, it is RE-DERIVED — twice, from two
  // different starting points. Under the current code these two agree whenever
  // the registration and pool comparisons above pass, so today the second is
  // redundant; it is kept because they stop agreeing the moment `derive()`
  // gains any path that reads the frozen file, and a redundant check that
  // costs microseconds is a poor thing to economise on in a registration.
  // Either way, a recorded order that does not follow from its own seeds is
  // the exact forgery this document exists to make impossible.
  const rederived = deriveOrder(frozen.pool.tasks.map((t) => t.id), frozen.registration);
  cmp('execution (re-derived from the frozen seeds)', frozen.execution, rederived);
  cmp('execution (re-derived from the on-disk pool)', frozen.execution, now.execution);

  if (!now.treatment) {
    process.stdout.write(`  treatment: artefact NOT deployed at ${ART_PKG} — treatment identity UNVERIFIED\n`);
    if (!noArtefact) {
      process.stdout.write('\nRESULT: cannot verify the treatment here (set TB_PILOT_CHECK_NO_ARTEFACT=1 to accept that)\n');
      process.exit(4);
    }
  } else {
    cmp('treatment', frozen.treatment, now.treatment);
    if (!now.treatment.artefact_pin_matches) {
      process.stdout.write(`  BINDING DRIFT  artefact pin: tree != ${ART_PKG_SHA_EXPECT}\n`);
      binding++;
    }
  }

  // CI runs on a different host than the freeze, so its environment ALWAYS
  // differs and comparing it there would train everyone to ignore exit 3. CI
  // therefore checks the binding identities only, and says so out loud; the
  // operator's pre-flight check before trajectory one does not set this.
  if (process.env.TB_PILOT_CHECK_BINDING_ONLY === '1') {
    process.stdout.write('  environment: comparison SKIPPED (TB_PILOT_CHECK_BINDING_ONLY=1)\n');
  } else {
    for (const [k, v] of Object.entries(now.environment_recorded)) {
      const was = frozen.environment_recorded?.[k];
      if (JSON.stringify(was) !== JSON.stringify(v)) {
        process.stdout.write(`  recorded drift  environment.${k}\n    frozen:  ${was}\n    on disk: ${v}\n`);
        recorded++;
      }
    }
  }

  // The rendered page is part of the freeze, not a comment on it: a stale page
  // beside a correct JSON is how a reader ends up acting on the wrong order.
  if (!fs.existsSync(mdTarget)) {
    process.stdout.write(`  BINDING DRIFT  the rendered page ${mdTarget} is missing\n`);
    binding++;
  } else if (fs.readFileSync(mdTarget, 'utf8') !== renderMarkdown(frozen, sha256(frozenRaw))) {
    process.stdout.write('  BINDING DRIFT  the rendered page is not what this manifest renders to\n');
    binding++;
  }

  // Provenance, not identity: the content hashes above are what actually pin
  // the tree. This says the freeze happened on a commit this checkout contains.
  const base = frozen.registration.base_commit;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: REPO, stdio: 'ignore' });
    process.stdout.write(`  base commit ${base.slice(0, 7)} is an ancestor of HEAD\n`);
  } catch {
    process.stdout.write(`  BINDING DRIFT  base commit ${base} is not an ancestor of HEAD\n`);
    binding++;
  }

  process.stdout.write(`\n  binding drift: ${binding}   recorded drift: ${recorded}\n`);
  if (binding > 0) {
    process.stdout.write('RESULT: BINDING DRIFT — the frozen manifest no longer describes this tree. The pilot must not run.\n');
    process.exit(2);
  }
  if (recorded > 0) {
    process.stdout.write('RESULT: environment drift — record it in DEVIATIONS.md before trajectory one, then proceed.\n');
    process.exit(3);
  }
  process.stdout.write('RESULT: the frozen manifest describes this tree exactly.\n');
  process.exit(0);
}

process.stderr.write(`usage: freeze-pilot-manifest.mjs --derive | --check | --print\n`);
process.exit(5);
