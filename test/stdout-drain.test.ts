// #415 — output a consumer parses must reach the pipe in full before the CLI exits.
//
// `process.exit(code)` straight after `process.stdout.write(doc)` is only safe when the
// write completed synchronously. Node makes pipe writes synchronous on Linux and
// ASYNCHRONOUS on macOS and Windows, and even a Linux pipe hands back once the kernel
// buffer is full and the reader is slow: whatever is still queued in the stream dies
// with the process. For `check --json` / `--format github` that is a truncated
// document; for the Claude hook it is a deny whose JSON Claude Code cannot parse — and
// a malformed hook response is ignored, which turns the deny into an ALLOW.
//
// Two consumers, one slow pipe. The built CLI is spawned with its stdout piped to this
// process, which does not start reading for a while (so the kernel buffer fills and the
// child's writes back up), and with `test/fixtures/async-stdout.cjs` preloaded, which
// makes every stdout write complete on a timer the way a macOS/Windows pipe does. Both
// must be survived: the document that arrives is the whole document.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { buildSync } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TW_VERSION } from '../src/wiring';
import { isRecord } from '../src/narrow';

const ROOT = join(__dirname, '..');
const PRELOAD = join(ROOT, 'test', 'fixtures', 'async-stdout.cjs');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI with stdout as a pipe nobody reads for `stallMs`, and every
 *  stdout write made asynchronous by the preload. */
function runSlowPipe(cli: string, args: string[], opts: { cwd: string; input?: string; stallMs?: number; asyncMs?: number }): Promise<Run> {
  const child = spawn(process.execPath, ['--require', PRELOAD, cli, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, TAMPERWARD_HOOK_SERVICE: '', TAMPERWARD_TEST_ASYNC_STDOUT_MS: String(opts.asyncMs ?? 5) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stderr.on('data', (b: Buffer) => err.push(b));
  if (opts.input !== undefined) child.stdin.end(opts.input);
  else child.stdin.end();
  // No 'data' listener yet: the socket stays paused, the kernel pipe buffer fills, and
  // the child's writes back up behind a reader that is not reading.
  setTimeout(() => child.stdout.on('data', (b: Buffer) => out.push(b)), opts.stallMs ?? 400);
  return new Promise((resolve) => {
    child.on('close', (status) =>
      resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
  });
}

describe('#415 · parsed output drains fully before the CLI exits', () => {
  let cliDir = '';
  let CLI = '';
  const dirs: string[] = [];

  beforeAll(() => {
    // The CLI as `npm run build` ships it, in the package layout it ships in, so this
    // test never depends on (or races) the repository's own dist/.
    cliDir = mkdtempSync(join(tmpdir(), 'tw-drain-cli-'));
    symlinkSync(join(ROOT, 'node_modules'), join(cliDir, 'node_modules'), 'dir');
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tamperward', version: TW_VERSION, type: 'module' }));
    mkdirSync(join(cliDir, 'dist', 'cli'), { recursive: true });
    CLI = join(cliDir, 'dist', 'cli', 'index.js');
    buildSync({ entryPoints: [join(ROOT, 'src/cli/index.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: CLI, logLevel: 'silent' });
  }, 60_000);
  afterAll(() => {
    if (cliDir) rmSync(cliDir, { recursive: true, force: true });
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...a: string[]): void => {
    execFileSync('git', a, { cwd, stdio: 'pipe' });
  };

  /** A repository whose worktree skips every test in `files` protected spec files,
   *  `perFile` tests each: one blocking finding per skip. */
  function skippedRepo(files: number, perFile: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'tw-drain-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'h@x');
    git(dir, 'config', 'user.name', 'h');
    writeFileSync(join(dir, '.tamperward.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
    for (let i = 0; i < files; i++) writeFileSync(join(dir, `a${i}.spec.ts`), specBody(i, perFile, ''));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    for (let i = 0; i < files; i++) writeFileSync(join(dir, `a${i}.spec.ts`), specBody(i, perFile, '.skip'));
    return dir;
  }

  function specBody(file: number, tests: number, marker: string): string {
    let s = '';
    for (let t = 0; t < tests; t++) s += `it${marker}('file ${file} test ${t}', () => { expect(${t}).toBe(${t}); });\n`;
    return s;
  }

  it('a multi-megabyte `check --json` through a slow pipe is one complete, parseable document', async () => {
    const files = 400;
    const perFile = 12;
    const dir = skippedRepo(files, perFile);
    const r = await runSlowPipe(CLI, ['check', '--worktree', '--json'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(r.stdout.endsWith('}\n')).toBe(true);
    const doc: unknown = JSON.parse(r.stdout);
    if (!isRecord(doc) || !Array.isArray(doc.findings)) throw new Error('check --json did not return a findings document');
    expect(doc.findings.length).toBe(files * perFile);
    expect(doc.summary).toEqual({ block: files * perFile, warn: 0 });
    expect(doc.scanned).toBe(files);
  }, 60_000);

  it('a `--format github` verdict through a slow pipe ends with the full text rendering', async () => {
    const dir = skippedRepo(100, 12);
    // Annotations are one write per line; keep the per-write delay small so the whole
    // run stays well inside the budget while every write is still asynchronous.
    const r = await runSlowPipe(CLI, ['check', '--worktree', '--format', 'github'], { cwd: dir, asyncMs: 1 });
    expect(r.status).toBe(1);
    // Every annotation line lands, and the text verdict follows the last one.
    const annotations = r.stdout.split('\n').filter((l) => l.startsWith('::error '));
    expect(annotations.length).toBe(100 * 12);
    const lastAnnotation = r.stdout.lastIndexOf('::error file=a99.spec.ts,line=12');
    expect(lastAnnotation).toBeGreaterThan(0);
    expect(r.stdout.indexOf('tamperward: 1200 blocking')).toBeGreaterThan(lastAnnotation);
  }, 60_000);

  it('a hook deny with a long reason through a slow pipe is one complete JSON deny', async () => {
    const dir = skippedRepo(1, 1);
    const tests = 3000;
    const raw = JSON.stringify({
      tool_name: 'Write',
      session_id: 'drain-415',
      cwd: dir,
      tool_input: { file_path: join(dir, 'a0.spec.ts'), content: specBody(0, tests, '.skip') },
    });
    const r = await runSlowPipe(CLI, ['hook', 'claude'], { cwd: dir, input: raw });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(128 * 1024);
    expect(r.stdout.endsWith('}\n')).toBe(true);
    const doc: unknown = JSON.parse(r.stdout);
    const out = isRecord(doc) && isRecord(doc.hookSpecificOutput) ? doc.hookSpecificOutput : null;
    if (!out) throw new Error('hook did not return a PreToolUse verdict');
    expect(out.permissionDecision).toBe('deny');
    const reason = typeof out.permissionDecisionReason === 'string' ? out.permissionDecisionReason : '';
    expect(reason).toMatch(/a0\.spec\.ts:2\)/);
    expect(reason).toMatch(new RegExp(`a0\\.spec\\.ts:${tests}\\)`));
    expect(reason).toMatch(/a human must sign off/);
  }, 60_000);

  it('a Stop block with a long reason through a slow pipe is one complete JSON block', async () => {
    const dir = skippedRepo(200, 12);
    const raw = JSON.stringify({ session_id: 'drain-415-stop', cwd: dir, stop_hook_active: false });
    const r = await runSlowPipe(CLI, ['sweep', 'claude'], { cwd: dir, input: raw });
    expect(r.status).toBe(0);
    expect(r.stdout.endsWith('}\n')).toBe(true);
    const doc: unknown = JSON.parse(r.stdout);
    if (!isRecord(doc)) throw new Error('sweep did not return a Stop verdict');
    expect(doc.decision).toBe('block');
    const reason = typeof doc.reason === 'string' ? doc.reason : '';
    expect(reason).toMatch(/a199\.spec\.ts:12\)/);
  }, 60_000);
});
