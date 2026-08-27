// snapshot-rewrite FP sweep over real mainline history. For each first-parent,
// non-merge commit: classify changed files against the default snapshot globs; for
// snapshot-touching commits, run the built CLI over parent...sha and count
// snapshot-rewrite findings, plus the CO-TOUCH signature (did the same commit change
// any non-snapshot file / any test file). Mainline commits are presumed legitimate,
// so for block-graduation purposes every fire counts against graduating as-is.
// Usage: node harness/fp-study/fp-snapshot.mjs <repoDir> [<repoDir> ...]
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import picomatch from 'picomatch';

const CLI = resolve(new URL('../../dist/cli/index.js', import.meta.url).pathname);
const SNAP_GLOBS = ['**/*.snap', '**/__snapshots__/**', '**/golden/**', '**/*.golden.*'];
const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**', '**/test/**'];
const isSnap = picomatch(SNAP_GLOBS, { dot: true });
const isTest = picomatch(TEST_GLOBS, { dot: true });

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

for (const dir of process.argv.slice(2)) {
  const repo = basename(dir);
  const out = resolve(new URL('.', import.meta.url).pathname, `snapshot-${repo}-fires.jsonl`);
  const shas = sh(dir, ['rev-list', '--first-parent', '--no-merges', 'HEAD']).trim().split('\n');

  let scanned = 0, snapTouching = 0, fired = 0, coTouch = 0, snapOnly = 0;
  const ops = { A: 0, M: 0, D: 0, R: 0 };

  for (const sha of shas) {
    let parent;
    try { parent = sh(dir, ['rev-parse', `${sha}^`]).trim(); } catch { break; } // shallow edge
    scanned++;
    const rows = sh(dir, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', sha])
      .trim().split('\n').filter(Boolean)
      .map((l) => { const [st, ...p] = l.split('\t'); return { st: st[0], path: p[p.length - 1] }; });
    const snapRows = rows.filter((r) => isSnap(r.path));
    // op:add is not flagged by the detector, so an adds-only commit is not in the denominator
    const flaggable = snapRows.filter((r) => r.st !== 'A');
    if (!flaggable.length) continue;
    snapTouching++;
    for (const r of flaggable) ops[r.st] = (ops[r.st] ?? 0) + 1;

    const others = rows.filter((r) => !isSnap(r.path));
    const touchesTest = others.some((r) => isTest(r.path));
    const touchesOther = others.length > 0;
    if (touchesOther) coTouch++; else snapOnly++;

    let findings = [];
    try {
      const json = execFileSync('node', [CLI, 'check', '--diff', `${parent}...${sha}`, '--cwd', dir, '--json'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      findings = (JSON.parse(json).findings ?? []).filter((f) => f.rule === 'snapshot-rewrite');
    } catch (e) {
      // exit 1 = blocking findings elsewhere; stdout still carries the JSON
      const so = String(e.stdout ?? '');
      try { findings = (JSON.parse(so).findings ?? []).filter((f) => f.rule === 'snapshot-rewrite'); } catch { /* skip */ }
    }
    if (findings.length) fired++;
    appendFileSync(out, JSON.stringify({
      repo, sha: sha.slice(0, 10), snapFiles: flaggable.length,
      ops: flaggable.map((r) => r.st).join(''),
      coTouch: touchesOther, touchesTest, fires: findings.length,
      sample: findings[0] ? { file: findings[0].file, message: findings[0].message } : null,
    }) + '\n');
  }

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
  console.log(`${repo}: ${scanned} commits | snapshot-touching ${snapTouching} (${pct(snapTouching, scanned)})` +
    ` | fired ${fired} (${pct(fired, snapTouching)} of touching)` +
    ` | co-touch ${coTouch} (${pct(coTouch, snapTouching)}) | snapshot-only ${snapOnly}` +
    ` | ops A-excluded M=${ops.M} D=${ops.D} R=${ops.R}`);
}
