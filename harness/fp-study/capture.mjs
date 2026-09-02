// Reusable FP-study capture: run the SHIPPED detectors across one repo's real merged-commit
// diffs, write one record per block-severity finding (rule/file/line/message/inline-hunk +
// verdict:pending) to a durable jsonl, and print a compact summary (block-fire diffs, by rule,
// and the ts-any-cast test/src split). Usage: node capture.mjs <label> <repoDir> <outFile>
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [label, repo, out] = process.argv.slice(2);
// The built CLI, resolved relative to this script (as fp-snapshot.mjs does) — never a
// machine-specific absolute path. Run `npm run build` first.
const CLI = resolve(new URL('../../dist/cli/index.js', import.meta.url).pathname);
const sh = (c) => { try { return execSync(c, { cwd: repo, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { return String(e.stdout || ''); } };
const commits = sh('git rev-list --reverse HEAD').split('\n').filter(Boolean);
writeFileSync(out, '');
let pairs = 0, blkDiffs = 0; const byRule = {}; let tdAny = 0, anyTest = 0, anySrc = 0;
for (let i = 1; i < commits.length; i++) {
  const base = commits[i - 1], head = commits[i];
  let o = ''; try { o = execSync(`node ${CLI} check --diff ${base}...${head} --json`, { cwd: repo, encoding: 'utf8', maxBuffer: 128e6 }); } catch (e) { o = String(e.stdout || ''); }
  pairs++;
  let j; try { j = JSON.parse(o); } catch { continue; }
  const blocks = (j.findings || []).filter((f) => f.severity === 'block');
  if (blocks.length) blkDiffs++;
  for (const f of blocks) {
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    if (f.rule === 'ts-any-cast') { /\.test\.|\.spec\.|test-d|\/tests?\//.test(f.file || '') ? anyTest++ : anySrc++; }
    // argv form: the file name comes from a third-party repository and is never shell-parsed
    let hunk = '';
    if (f.file) {
      try { hunk = execFileSync('git', ['diff', base, head, '--', f.file], { cwd: repo, encoding: 'utf8', maxBuffer: 128e6 }); }
      catch (e) { hunk = String(e.stdout || ''); }
      hunk = hunk.split('\n').slice(0, 40).join('\n');
    }
    appendFileSync(out, JSON.stringify({ repo: label, diffIdx: i, base: base.slice(0, 10), head: head.slice(0, 10), rule: f.rule, file: f.file, line: f.line, message: f.message, evidence: f.evidence, hunk, verdict: 'pending', note: '' }) + '\n');
  }
}
console.log(`${label}: ${pairs} diffs; ${blkDiffs} with a BLOCK fire; by rule ${JSON.stringify(byRule)}; ts-any-cast split test=${anyTest} src=${anySrc}`);
