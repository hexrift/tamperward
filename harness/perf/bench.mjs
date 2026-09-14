// Repeatable performance budgets for the built CLI (issue #334).
//
//   node harness/perf/bench.mjs [--profile full|smoke] [--runs 7] [--cli dist/cli/index.js]
//        [--work <dir>] [--out perf.json] [--md perf.md] [--items a,b,...]
//        [--dep-mb 8] [--ignored-files 20000] [--log-mb 8] [--keep]
//
// Every item is measured the way a user pays for it: a fresh `node
// dist/cli/index.js ...` process per run, wall clock around the process and the
// children's CPU (user+sys) from bash's `times` builtin, on synthetic
// repositories generated deterministically by fixtures.mjs. One untimed warm-up
// run precedes each item so the page cache is warm; `runs` timed runs follow and
// p50/p95 (nearest rank) are reported per item, plus min/max/mean.
//
// Items (see docs/PERF.md for what each one stands for):
//   cli.noop           hook claude with empty stdin: process start + module load only
//                      (the parser is lazy, #407: this item never loads it)
//   cli.parse          hook claude PreToolUse Edit of one .ts source, no session: process
//                      start + module load + parser load + one file's evaluation — the
//                      smoke's yardstick, since every item that touches a .ts file pays it
//   hook.warm.100      PreToolUse hook, established session, 100 protected files
//   hook.cold.1k       PreToolUse hook, NEW session (baseline pin + first snapshot), 1k files
//   hook.warm.1k       PreToolUse hook, established session, 1k files
//   snapshot.100/1k/10k  Stop sweep (turn view + protected-tree snapshot) at each size
//   check.diff.small   check --diff over 3 changed files
//   check.diff.large   check --diff over 500 changed files
//   hook.ignored       PreToolUse hook with a 20k-file wholly-ignored dist/ tree
//   sweep.ignored      Stop sweep with the same tree (ignored/untracked enumeration)
//   deps.fingerprint   verify --cmd true with a --dep-mb node_modules (inner_ms is the
//                      fingerprint alone, from TAMPERWARD_DIAGNOSTICS=1)
//   verify.materialize verify --cmd true, no dependency tree: visible + pristine
//                      materialisation and adjudication with a ~1 ms suite
//   run.envelope       run --cmd true -- true: the whole envelope around a trivial agent
//   sweep.longlog      Stop sweep consuming a --log-mb watcher event log from offset 0
//
// The smoke profile is the cheapest items on the 100-file tree; harness/perf/smoke.test.ts
// runs it (alone, from `npm run test:perf-smoke`) and judges CPU ratios to cli.parse
// within the run. Node built-ins only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, tmpdir, arch } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { makeDependencyTree, makeDiffs, makeEventLog, makeIgnoredTree, makeRepo, git } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function parseArgs(argv) {
  const o = {
    profile: 'full',
    runs: 7,
    cli: join(ROOT, 'dist', 'cli', 'index.js'),
    work: join(tmpdir(), 'tw-perf'),
    out: null,
    md: null,
    items: null,
    depMb: 8,
    ignoredFiles: 20000,
    logMb: 8,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--profile') o.profile = v();
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--cli') o.cli = resolve(v());
    else if (a === '--work') o.work = resolve(v());
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--md') o.md = resolve(v());
    else if (a === '--items') o.items = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dep-mb') o.depMb = Number(v());
    else if (a === '--ignored-files') o.ignoredFiles = Number(v());
    else if (a === '--log-mb') o.logMb = Number(v());
    else if (a === '--keep') o.keep = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option "${a}"`);
  }
  if (o.profile !== 'full' && o.profile !== 'smoke') throw new Error(`--profile must be full or smoke (got "${o.profile}")`);
  for (const [k, label] of [['runs', '--runs'], ['depMb', '--dep-mb'], ['ignoredFiles', '--ignored-files'], ['logMb', '--log-mb']]) {
    if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`${label} must be a positive number`);
  }
  o.runs = Math.floor(o.runs);
  return o;
}

// ---------------------------------------------------------------- measurement

/**
 * Run one command under bash so the children's CPU time is observable: bash's
 * `times` builtin prints the accumulated user/sys time of every child after the
 * command exits, portably on Linux and macOS, with no /usr/bin/time dependency.
 * Wall is measured around the bash process (a few ms of shell start-up are
 * included in every item alike). stdout/stderr of the command land in files.
 */
let ioDir = tmpdir();
function measure(cmd, args, { cwd, env, input }) {
  // Never inside the repository under test: an untracked capture file would be
  // a dirty tree to `run` and an untracked add to the sweep.
  const outFile = join(ioDir, `perf-stdout-${process.pid}`);
  const errFile = join(ioDir, `perf-stderr-${process.pid}`);
  const script = '"$@" >"$TW_PERF_OUT" 2>"$TW_PERF_ERR"; c=$?; times; exit $c';
  const t0 = performance.now();
  const r = spawnSync('bash', ['-c', script, 'perf', cmd, ...args], {
    cwd,
    env: { ...process.env, ...env, TW_PERF_OUT: outFile, TW_PERF_ERR: errFile },
    input: input ?? '',
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });
  const wallMs = performance.now() - t0;
  const lines = (r.stdout ?? '').trim().split('\n');
  const children = lines[lines.length - 1] ?? '';
  const m = /(\d+)m([\d.]+)s\s+(\d+)m([\d.]+)s/.exec(children);
  const cpuMs = m ? (Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) * 60 + Number(m[4])) * 1000 : NaN;
  const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : '';
  rmSync(outFile, { force: true });
  rmSync(errFile, { force: true });
  return { wallMs, cpuMs, code: r.status, stdout, stderr };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const round = (n) => Number(n.toFixed(1));
  return { p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), min: round(s[0]), max: round(s[s.length - 1]), mean: round(mean) };
}

// ---------------------------------------------------------------- fixtures

function hookPayload(cwd, sessionId) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd, session_id: sessionId });
}

/** An Edit of the fixture's first plain source (src/d000/mod0.ts, a `.ts` file
 *  the cast rules read on the AST), with NO session: the parser is loaded and
 *  one file evaluated, and nothing is pinned or snapshotted. */
function editTsPayload(cwd) {
  return JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, 'src', 'd000', 'mod0.ts'), old_string: 'return n;', new_string: 'return n + 1;' },
    cwd,
  });
}

function stopPayload(cwd, sessionId) {
  return JSON.stringify({ cwd, session_id: sessionId, stop_hook_active: false });
}

let sessionCounter = 0;
function newSession() {
  return `perf-${process.pid}-${++sessionCounter}`;
}

/** One PreToolUse call so the session's baseline and protected-tree snapshot exist. */
function establishSession(cli, dir) {
  const sid = newSession();
  const r = measure(process.execPath, [cli, 'hook', 'claude'], { cwd: dir, input: hookPayload(dir, sid) });
  if (r.code !== 0) throw new Error(`cannot establish a hook session in ${dir}: exit ${r.code}\n${r.stderr}`);
  return sid;
}

function stateDir(dir) {
  const gd = git(dir, ['rev-parse', '--git-dir']).trim();
  return join(isAbsolute(gd) ? gd : join(dir, gd), 'tamperward');
}

/**
 * Item catalogue. `fixture` names a repository built lazily by `repos`;
 * `setup` runs once per item after the fixture exists; `each` runs before every
 * timed run (untimed); `command` returns the argv/stdin/env of one run;
 * `expect` is the exit code a healthy run reports; `inner` extracts an
 * in-process millisecond figure from stdout where the CLI exposes one.
 */
function catalogue(cli, opts) {
  const node = process.execPath;
  const hook = (dir, sid) => ({ cmd: node, args: [cli, 'hook', 'claude'], input: hookPayload(dir, sid) });
  const sweep = (dir, sid, env) => ({ cmd: node, args: [cli, 'sweep', 'claude'], input: stopPayload(dir, sid), env });
  return [
    {
      id: 'cli.noop', fixture: 'tree100', smoke: true,
      description: 'hook claude with EMPTY stdin: process start + module load, no evaluation (the fixed cost every item pays)',
      command: () => ({ cmd: node, args: [cli, 'hook', 'claude'], input: '' }), expect: 0,
    },
    {
      id: 'cli.parse', fixture: 'tree100', smoke: true,
      description: 'hook claude PreToolUse Edit of one .ts source, no session: process start + module load + parser load + one file evaluated (the smoke yardstick)',
      command: (dir) => ({ cmd: node, args: [cli, 'hook', 'claude'], input: editTsPayload(dir) }), expect: 0,
    },
    {
      id: 'hook.warm.100', fixture: 'tree100', smoke: true,
      description: 'PreToolUse hook, established session, 100 protected files',
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => hook(dir, st.sid), expect: 0,
    },
    {
      id: 'snapshot.100', fixture: 'tree100', smoke: true,
      description: 'Stop sweep: turn view + protected-tree snapshot, 100 protected files',
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => sweep(dir, st.sid), expect: 0,
    },
    {
      id: 'check.diff.small', fixture: 'tree100', smoke: true,
      description: 'check --diff perf-base...perf-small (3 changed files)',
      command: (dir) => ({ cmd: node, args: [cli, 'check', '--diff', 'perf-base...perf-small', '--format', 'text'] }), expect: 0,
    },
    {
      id: 'hook.cold.1k', fixture: 'tree1k',
      description: 'PreToolUse hook, NEW session every run (baseline pin + first snapshot), 1k protected files',
      each: () => ({ sid: newSession() }),
      command: (dir, st) => hook(dir, st.sid), expect: 0,
    },
    {
      id: 'hook.warm.1k', fixture: 'tree1k',
      description: 'PreToolUse hook, established session, 1k protected files',
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => hook(dir, st.sid), expect: 0,
    },
    {
      id: 'snapshot.1k', fixture: 'tree1k',
      description: 'Stop sweep: turn view + protected-tree snapshot, 1k protected files',
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => sweep(dir, st.sid), expect: 0,
    },
    {
      id: 'snapshot.10k', fixture: 'tree10k',
      description: 'Stop sweep: turn view + protected-tree snapshot, 10k protected files',
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => sweep(dir, st.sid), expect: 0,
    },
    {
      id: 'check.diff.large', fixture: 'tree1k',
      description: 'check --diff perf-base...perf-large (500 changed files)',
      command: () => ({ cmd: node, args: [cli, 'check', '--diff', 'perf-base...perf-large', '--format', 'text'] }), expect: 0,
    },
    {
      id: 'hook.ignored', fixture: 'ignored',
      description: `PreToolUse hook, established session, 1k protected files + ${opts.ignoredFiles}-file ignored dist/ + untracked scratch`,
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => hook(dir, st.sid), expect: 0,
    },
    {
      id: 'sweep.ignored', fixture: 'ignored',
      description: `Stop sweep (ignored/untracked enumeration) with a ${opts.ignoredFiles}-file ignored dist/`,
      setup: (dir) => ({ sid: establishSession(cli, dir) }),
      command: (dir, st) => sweep(dir, st.sid), expect: 0,
    },
    {
      id: 'deps.fingerprint', fixture: 'deps',
      description: `verify --cmd true with a ${opts.depMb} MB synthetic node_modules; inner_ms = dependency fingerprint alone`,
      command: () => ({ cmd: node, args: [cli, 'verify', '--cmd', 'true', '--json'], env: { TAMPERWARD_DIAGNOSTICS: '1' } }), expect: 0,
      inner: (stdout) => {
        try {
          const doc = JSON.parse(stdout);
          const ms = doc?.dependency_environment?.diagnostics?.total_ms;
          return typeof ms === 'number' ? ms : null;
        } catch {
          return null;
        }
      },
    },
    {
      id: 'verify.materialize', fixture: 'tree1k',
      description: 'verify --cmd true, no dependency tree: visible + pristine materialisation with a ~1 ms suite',
      command: () => ({ cmd: node, args: [cli, 'verify', '--cmd', 'true'] }), expect: 0,
    },
    {
      id: 'run.envelope', fixture: 'tree1k',
      description: 'run --cmd true -- true: the full envelope (base pin, checks, verify) around a trivial agent',
      command: () => ({ cmd: node, args: [cli, 'run', '--cmd', 'true', '--', 'true'] }), expect: 0,
    },
    {
      id: 'sweep.longlog', fixture: 'tree1k',
      description: `Stop sweep consuming a ${opts.logMb} MB watcher event log from offset 0`,
      setup: (dir, repos) => {
        const log = join(repos.work, 'fsevents.jsonl');
        const made = makeEventLog(log, { bytes: opts.logMb * 1024 * 1024 });
        return { sid: establishSession(cli, dir), log, events: made.events };
      },
      each: (dir, st) => {
        rmSync(join(stateDir(dir), `fscursor-${st.sid}.json`), { force: true });
        return st;
      },
      command: (dir, st) => sweep(dir, st.sid, { TAMPERWARD_FSEVENTS: st.log }), expect: 0,
    },
  ];
}

function buildRepos(work, opts) {
  const built = new Map();
  const get = (name) => {
    if (built.has(name)) return built.get(name);
    const dir = join(work, name);
    process.stderr.write(`perf: building fixture ${name}\n`);
    let repo;
    if (name === 'tree100') {
      repo = makeRepo(dir, { protectedFiles: 100, seed: 100 });
      makeDiffs(repo, { small: 3, large: 50 });
    } else if (name === 'tree1k') {
      repo = makeRepo(dir, { protectedFiles: 1000, seed: 1000 });
      makeDiffs(repo, { small: 3, large: 500 });
    } else if (name === 'tree10k') {
      repo = makeRepo(dir, { protectedFiles: 10000, seed: 10000 });
    } else if (name === 'ignored') {
      repo = makeRepo(dir, { protectedFiles: 1000, seed: 1001 });
      makeIgnoredTree(repo, { files: opts.ignoredFiles });
    } else if (name === 'deps') {
      repo = makeRepo(dir, { protectedFiles: 100, seed: 101 });
      repo.deps = makeDependencyTree(repo, { bytes: opts.depMb * 1024 * 1024 });
    } else {
      throw new Error(`unknown fixture ${name}`);
    }
    built.set(name, repo);
    return repo;
  };
  return { work, get };
}

// ---------------------------------------------------------------- reporting

function machine() {
  const c = cpus();
  const ci = process.env.GITHUB_ACTIONS === 'true' ? { ci: 'github-actions', runner: process.env.RUNNER_OS ?? null, image: process.env.ImageOS ?? null } : {};
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: c[0]?.model ?? 'unknown',
    cores: c.length,
    mem_gb: Number((totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
    git: (() => {
      try {
        return spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim();
      } catch {
        return 'unknown';
      }
    })(),
    ...ci,
  };
}

function versionOf(cli) {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
  void cli;
}

function markdown(report) {
  const rows = [
    `# perf — ${report.profile} profile, ${report.runs} runs/item, ${report.generated_at}`,
    '',
    `${report.machine.cpu} × ${report.machine.cores}, ${report.machine.mem_gb} GB, ${report.machine.platform} ${report.machine.arch}, ${report.machine.node}, tamperward ${report.tamperward_version ?? '?'}`,
    '',
    '| item | p50 wall ms | p95 wall ms | p50 cpu ms | p95 cpu ms | inner p50 ms | description |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const it of report.items) {
    rows.push(`| ${it.id} | ${it.wall_ms.p50} | ${it.wall_ms.p95} | ${it.cpu_ms.p50} | ${it.cpu_ms.p95} | ${it.inner_ms ? it.inner_ms.p50 : '—'} | ${it.description} |`);
  }
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------- main

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`perf: ${e.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 34).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }
  if (!existsSync(opts.cli)) {
    process.stderr.write(`perf: CLI not found at ${opts.cli} (run \`npm run build\` or pass --cli)\n`);
    return 2;
  }
  const bashProbe = spawnSync('bash', ['-c', 'times'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    process.stderr.write('perf: bash is required (the children CPU time comes from its `times` builtin)\n');
    return 2;
  }

  rmSync(opts.work, { recursive: true, force: true });
  mkdirSync(opts.work, { recursive: true });
  ioDir = join(opts.work, '.io');
  mkdirSync(ioDir);
  const repos = buildRepos(opts.work, opts);
  let items = catalogue(opts.cli, opts).filter((it) => (opts.profile === 'smoke' ? it.smoke === true : true));
  if (opts.items) {
    const want = new Set(opts.items);
    const known = new Set(items.map((i) => i.id));
    for (const id of want) if (!known.has(id)) {
      process.stderr.write(`perf: unknown item "${id}" (known: ${[...known].join(', ')})\n`);
      return 2;
    }
    items = items.filter((it) => want.has(it.id));
  }

  const results = [];
  let failed = 0;
  for (const it of items) {
    const repo = repos.get(it.fixture);
    const dir = repo.dir;
    let st = it.setup ? it.setup(dir, repos) : {};
    const walls = [];
    const cpu = [];
    const inner = [];
    const codes = new Set();
    let bad = null;
    for (let run = -1; run < opts.runs; run++) {
      if (it.each) st = it.each(dir, st) ?? st;
      const spec = it.command(dir, st);
      const r = measure(spec.cmd, spec.args, { cwd: dir, env: spec.env, input: spec.input });
      if (r.code !== it.expect) {
        bad = `exit ${r.code} (expected ${it.expect})\n${r.stderr}${r.stdout.slice(0, 2000)}`;
        break;
      }
      if (run < 0) continue; // warm-up
      walls.push(r.wallMs);
      cpu.push(r.cpuMs);
      codes.add(r.code);
      if (it.inner) {
        const v = it.inner(r.stdout);
        if (v != null) inner.push(v);
      }
    }
    if (bad) {
      failed++;
      process.stderr.write(`perf: ${it.id}: ${bad}\n`);
      continue;
    }
    const entry = {
      id: it.id,
      description: it.description,
      fixture: it.fixture,
      runs: walls.length,
      wall_ms: stats(walls),
      cpu_ms: stats(cpu),
      ...(inner.length ? { inner_ms: stats(inner) } : {}),
      ...(repo.deps && it.fixture === 'deps' ? { dependency_tree: { bytes: repo.deps.bytes, packages: repo.deps.packages } } : {}),
      ...(st.events ? { events: st.events } : {}),
    };
    results.push(entry);
    process.stderr.write(`perf: ${it.id.padEnd(20)} p50 ${entry.wall_ms.p50} ms  p95 ${entry.wall_ms.p95} ms  cpu p50 ${entry.cpu_ms.p50} ms${entry.inner_ms ? `  inner p50 ${entry.inner_ms.p50} ms` : ''}\n`);
  }

  const report = {
    schema: 1,
    generated_at: new Date().toISOString(),
    tamperward_version: versionOf(opts.cli),
    profile: opts.profile,
    runs: opts.runs,
    options: { dep_mb: opts.depMb, ignored_files: opts.ignoredFiles, log_mb: opts.logMb },
    machine: machine(),
    items: results,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  const md = markdown(report);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, json);
  }
  if (opts.md) {
    mkdirSync(dirname(opts.md), { recursive: true });
    writeFileSync(opts.md, md);
  }
  if (!opts.out && !opts.md) process.stdout.write(json);
  else process.stdout.write(md);
  if (!opts.keep) rmSync(opts.work, { recursive: true, force: true });
  return failed === 0 ? 0 : 1;
}

process.exit(main());
