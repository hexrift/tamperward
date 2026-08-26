// Reusable FP-study capture: run the SHIPPED detectors across one repo's real merged-commit
// diffs, write one record per block-severity finding (rule/file/line/message/inline-hunk +
// verdict:pending) to a durable jsonl, and print a compact summary (block-fire diffs, by rule,
// and the ts-any-cast test/src split). Usage: node capture.mjs <label> <repoDir> <outFile>
import { execSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';

const [label, repo, out] = process.argv.slice(2);
const CLI = '/Users/hamsajama/projects/ballast/tamperward/dist/cli/index.js';
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
    let hunk = ''; if (f.file) hunk = sh(`git diff ${base} ${head} -- "${f.file}"`).split('\n').slice(0, 40).join('\n');
    appendFileSync(out, JSON.stringify({ repo: label, diffIdx: i, base: base.slice(0, 10), head: head.slice(0, 10), rule: f.rule, file: f.file, line: f.line, message: f.message, evidence: f.evidence, hunk, verdict: 'pending', note: '' }) + '\n');
  }
}
console.log(`${label}: ${pairs} diffs; ${blkDiffs} with a BLOCK fire; by rule ${JSON.stringify(byRule)}; ts-any-cast split test=${anyTest} src=${anySrc}`);
