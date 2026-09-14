// Deterministic synthetic fixtures for harness/perf/bench.mjs.
//
// Every byte here derives from a fixed seed, so two runs on two machines build
// byte-identical repositories and the only variable a comparison sees is the
// machine. Nothing is downloaded and no package is installed: the "dependency
// tree" is a generated node_modules of plausible shape (nested packages, a few
// symlinked workspace packages, package.json files, JS sources and binary-ish
// blobs) sized by a byte budget, because the fingerprint walks and hashes bytes
// and does not care what they say.
//
// Node built-ins only: this file must stay loadable with no `npm ci`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** mulberry32: a tiny seedable PRNG, good enough for filler text. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One independent stream per file, so a file can be regenerated (with a
 *  variant) without replaying every file before it. */
export function fileRng(seed, i) {
  return rng((seed * 1000003 + i * 7919) >>> 0);
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'lambda', 'zeta'];

function word(r) {
  return WORDS[Math.floor(r() * WORDS.length)];
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'perf',
      GIT_AUTHOR_EMAIL: 'perf@example.invalid',
      GIT_COMMITTER_NAME: 'perf',
      GIT_COMMITTER_EMAIL: 'perf@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    ...opts,
  });
}

/** A vitest spec of a few cases: the shape the protected-tests rules read. */
export function specSource(i, r, extraCase = false) {
  const lines = [
    `import { describe, it, expect } from 'vitest';`,
    `import { ${word(r)}${i} as f } from '../src/mod${i}';`,
    ``,
    `describe('module ${i}', () => {`,
  ];
  const cases = 3 + Math.floor(r() * 4);
  for (let c = 0; c < cases; c++) {
    lines.push(`  it('${word(r)} ${word(r)} case ${c}', () => {`);
    lines.push(`    expect(f(${Math.floor(r() * 1000)})).toBe(${Math.floor(r() * 1000)});`);
    lines.push(`  });`);
  }
  if (extraCase) {
    lines.push(`  it('added by the diff fixture', () => {`);
    lines.push(`    expect(f(1)).toBe(1);`);
    lines.push(`  });`);
  }
  lines.push(`});`, ``);
  return lines.join('\n');
}

export function srcSource(i, r, variant = 0) {
  const name = `${word(r)}${i}`;
  const lines = [`// module ${i} (variant ${variant})`, `export function ${name}(n: number): number {`];
  const ops = 2 + Math.floor(r() * 6);
  for (let o = 0; o < ops; o++) lines.push(`  n = (n * ${1 + Math.floor(r() * 97)} + ${Math.floor(r() * 1000)} + ${variant}) % 100003;`);
  lines.push(`  return n;`, `}`, ``);
  return lines.join('\n');
}

/** Shard files 100 per directory so a 10k tree is not one flat readdir. */
function shard(prefix, i) {
  return `${prefix}/d${String(Math.floor(i / 100)).padStart(3, '0')}`;
}

export function specPath(i) {
  return `${shard('test', i)}/mod${i}.test.ts`;
}

export function srcPath(i) {
  return `${shard('src', i)}/mod${i}.ts`;
}

/**
 * A repository with `protectedFiles` spec files (default policy: every one is a
 * protected test), a quarter as many plain sources, a package.json (protected
 * config) and a `.gitignore` for the build tree. Committed as `perf-base`.
 */
export function makeRepo(dir, { protectedFiles, seed = 1 }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < protectedFiles; i++) write(join(dir, specPath(i)), specSource(i, fileRng(seed, i)));
  const sources = Math.max(1, Math.floor(protectedFiles / 4));
  for (let i = 0; i < sources; i++) write(join(dir, srcPath(i)), srcSource(i, fileRng(seed, 1_000_000 + i)));
  write(join(dir, 'package.json'), JSON.stringify({ name: 'perf-fixture', version: '1.0.0', private: true, scripts: { test: 'true' } }, null, 2) + '\n');
  write(join(dir, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.venv/\n*.log\n');
  write(join(dir, 'README.md'), `# perf fixture (${protectedFiles} protected files)\n`);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'perf base']);
  git(dir, ['tag', 'perf-base']);
  return { dir, protectedFiles, sources, seed };
}

/**
 * Two tagged commits on top of `perf-base`: `perf-small` touches a handful of
 * files, `perf-large` touches `large` of them (spec additions and source
 * rewrites, no weakening — the gate should evaluate them, not deny them). The
 * working tree is left at `perf-base` afterwards.
 */
export function makeDiffs(repo, { small = 3, large = 500 }) {
  const { dir, protectedFiles, sources, seed } = repo;
  const apply = (count, tag, variant) => {
    const specs = Math.min(protectedFiles, Math.ceil(count * 0.8));
    const srcs = Math.min(sources, count - specs);
    // The same stream as makeRepo, so the only difference is the added case.
    for (let i = 0; i < specs; i++) write(join(dir, specPath(i)), specSource(i, fileRng(seed, i), true));
    for (let i = 0; i < srcs; i++) write(join(dir, srcPath(i)), srcSource(i, fileRng(seed, 1_000_000 + i), variant));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `perf ${tag}`]);
    git(dir, ['tag', tag]);
    git(dir, ['reset', '-q', '--hard', 'perf-base']);
  };
  apply(small, 'perf-small', 1);
  apply(large, 'perf-large', 2);
}

/**
 * A large wholly-ignored build tree plus a few untracked scratch files: the
 * shape `git ls-files --others --directory` collapses and the snapshot walk
 * must prune. `files` regular files under `dist/`, sharded 200 per directory.
 */
export function makeIgnoredTree(repo, { files = 20000, seed = 11 }) {
  const { dir } = repo;
  const r = rng(seed);
  const root = join(dir, 'dist');
  rmSync(root, { recursive: true, force: true });
  for (let i = 0; i < files; i++) {
    const p = join(root, `chunk${String(Math.floor(i / 200)).padStart(3, '0')}`, `asset${i}.js`);
    write(p, `// built ${i}\nmodule.exports=${Math.floor(r() * 1e9)};\n`);
  }
  // A protected-looking file INSIDE the ignored tree: the ignored enumeration
  // must find it (it is judged), which is what makes the second pass cost real.
  write(join(root, 'leak', 'hidden.test.ts'), `it('x', () => {});\n`);
  for (let i = 0; i < 5; i++) write(join(dir, `scratch${i}.txt`), `scratch ${i}\n`);
}

/**
 * A synthetic node_modules of about `bytes` bytes: `packages` top-level
 * packages, each with a package.json, a handful of JS modules, one nested
 * dependency, and one larger blob so the byte budget is met with a realistic
 * file-count-to-bytes ratio (roughly 6 KB per file on real installs).
 */
export function makeDependencyTree(repo, { bytes, seed = 23 }) {
  const { dir } = repo;
  const root = join(dir, 'node_modules');
  rmSync(root, { recursive: true, force: true });
  const r = rng(seed);
  const perFile = 6 * 1024;
  const totalFiles = Math.max(20, Math.floor(bytes / perFile));
  const packages = Math.max(4, Math.floor(totalFiles / 12));
  let written = 0;
  const filler = (n) => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = 32 + Math.floor(r() * 90);
    return buf;
  };
  for (let p = 0; p < packages && written < bytes; p++) {
    const name = `pkg-${word(r)}-${p}`;
    const pdir = join(root, name);
    write(join(pdir, 'package.json'), JSON.stringify({ name, version: `1.${p}.0`, main: 'index.js' }) + '\n');
    write(join(pdir, 'index.js'), `module.exports = require('./lib/a');\n`);
    for (let f = 0; f < 8; f++) {
      const size = 1024 + Math.floor(r() * 8192);
      write(join(pdir, 'lib', `${String.fromCharCode(97 + f)}.js`), filler(size));
      written += size;
    }
    const nested = join(pdir, 'node_modules', `dep-${p}`);
    write(join(nested, 'package.json'), JSON.stringify({ name: `dep-${p}`, version: '0.0.1' }) + '\n');
    write(join(nested, 'index.js'), filler(2048));
    written += 2048;
    const blob = 16 * 1024 + Math.floor(r() * 32 * 1024);
    write(join(pdir, 'dist', 'bundle.min.js'), filler(blob));
    written += blob;
  }
  // A symlinked package (pnpm-style store link), resolved inside the tree so the
  // verifier's dependency-domain symlink rules accept it.
  const store = join(root, '.store', 'local-lib');
  write(join(store, 'package.json'), JSON.stringify({ name: 'local-lib', version: '0.0.0' }) + '\n');
  write(join(store, 'index.js'), `module.exports = 1;\n`);
  symlinkSync(join('.store', 'local-lib'), join(root, 'local-lib'), 'dir');
  return { bytes: written, packages };
}

/**
 * A long watcher event log: `bytes` of JSONL churn records over `paths`
 * protected files (modified and restored, so every record classifies as a
 * transient candidate and the sweep does its full per-path work).
 */
export function makeEventLog(file, { bytes, paths = 200, seed = 31 }) {
  const r = rng(seed);
  mkdirSync(dirname(file), { recursive: true });
  const chunks = [];
  let size = 0;
  let i = 0;
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  while (size < bytes) {
    const p = specPath(i % paths);
    const flip = i % 2 === 0;
    const rec = {
      ts: new Date(t0 + i * 10).toISOString(),
      path: p,
      kind: 'change',
      mode: 0o100644,
      size: 512 + (i % 7),
      hash: (flip ? 'a' : 'b').repeat(8) + Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0'),
    };
    const line = JSON.stringify(rec) + '\n';
    chunks.push(line);
    size += line.length;
    i++;
  }
  writeFileSync(file, chunks.join(''));
  return { events: i, bytes: size };
}

export function ensureDir(d) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
