import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): { repo: string; good: string } {
  const root = mkdtempSync(join(tmpdir(), 'tw-fp-harness-'));
  dirs.push(root);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.email', 't@b'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'tb'], { cwd: repo });
  writeFileSync(join(repo, 'a.test.js'), "test('a', () => {});\n");
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'one'], { cwd: repo });
  writeFileSync(join(repo, 'a.test.js'), "test('b', () => {});\n");
  execFileSync('git', ['commit', '-qam', 'two'], { cwd: repo });

  const good = join(root, 'good.mjs');
  writeFileSync(
    good,
    "console.log(JSON.stringify({ verdict: 'PASS', findings: [] })); process.exit(0);\n",
  );
  chmodSync(good, 0o755);
  return { repo, good };
}

function run(repo: string, baseCli: string, candidateCli: string) {
  return spawnSync(
    process.execPath,
    [
      resolve('harness/fp-study/test-skip-ast-delta.mjs'),
      'fixture',
      repo,
      baseCli,
      candidateCli,
    ],
    { encoding: 'utf8' },
  );
}

describe('test-skip AST precision harness', () => {
  it('fails closed on malformed CLI JSON', () => {
    const { repo, good } = fixture();
    const bad = join(repo, '..', 'bad.mjs');
    writeFileSync(bad, "console.log('not-json');\n");
    const r = run(repo, good, bad);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/malformed JSON/);
  });

  it('fails closed on an unexpected cannot-adjudicate exit', () => {
    const { repo, good } = fixture();
    const bad = join(repo, '..', 'bad-exit.mjs');
    writeFileSync(bad, "console.log(JSON.stringify({ findings: [] })); process.exit(2);\n");
    const r = run(repo, good, bad);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unexpected CLI exit 2/);
  });

  it('records the exact corpus head on a valid run', () => {
    const { repo, good } = fixture();
    const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const r = run(repo, good, good);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({
      repo: 'fixture',
      corpus_head: expectedHead,
      pairs: 1,
      new_findings: 0,
    });
  });
});
