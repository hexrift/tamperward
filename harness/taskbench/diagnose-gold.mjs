// Gold-failure diagnosis (post-sweep, read-only on task artifacts).
// For a task: establish the historical truth from the frozen SHAs, test the
// exact round-trip invariant (parent + test.patch + gold.patch must equal the
// commit tree file-for-file), surface git-apply's precise error, and classify
// the fix commit's transformation types (renames, deletes, adds, mode changes,
// binary).
// How to run: node harness/taskbench/diagnose-gold.mjs <task-id>   (needs network: clones the repo)
// Status: manual diagnostic, unwired — not run by CI or by any sweep driver.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const id = process.argv[2];
const task = path.join(HERE, 'tasks', id);
const m = JSON.parse(fs.readFileSync(path.join(task, 'manifest.json'), 'utf8'));
const W = fs.mkdtempSync('/tmp/tb-diag-');
const sh = (c, opts = {}) => execSync(c, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
const shTry = (c) => { try { return { ok: true, out: sh(c, { stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };

console.log(`== ${id} (${m.repo}) parent=${m.parent_sha.slice(0,10)} commit=${m.commit_sha.slice(0,10)}`);
sh(`git clone -q --filter=blob:none https://github.com/${m.repo}.git ${W}/r`);

// 1. transformation classes in the full historical diff
const status = sh(`git -C ${W}/r diff --name-status --find-renames ${m.parent_sha} ${m.commit_sha}`).trim();
const classes = {};
for (const row of status.split('\n')) { const t = row[0]; classes[t] = (classes[t] || 0) + 1; }
console.log('fix-commit ops:', JSON.stringify(classes));
console.log(status.split('\n').filter(r => !/^M/.test(r)).slice(0, 10).map(r => '  ' + r).join('\n') || '  (all plain modifications)');

// 2. materialize parent + test.patch, then try gold with precise errors
sh(`git -C ${W}/r checkout -q --detach ${m.parent_sha}`);
sh(`git -C ${W}/r apply ${task}/test.patch`);
const apply = shTry(`git -C ${W}/r apply --verbose ${task}/gold.patch`);
console.log(`gold apply: ${apply.ok ? 'OK' : 'FAILED'}`);
if (!apply.ok) console.log(apply.out.split('\n').slice(0, 12).map(l => '  ' + l).join('\n'));

// 3. round-trip invariant: tree equality vs frozen commit (whatever apply said)
if (!apply.ok) {
  const threeway = shTry(`git -C ${W}/r apply --3way ${task}/gold.patch`);
  console.log(`gold apply --3way: ${threeway.ok ? 'OK' : 'FAILED'}`);
}
const want = sh(`git -C ${W}/r ls-tree -r ${m.commit_sha} --format='%(objectname) %(path)'`).trim().split('\n');
let mismatches = 0, missing = 0;
for (const row of want) {
  const [oid, ...rest] = row.split(' '); const p = rest.join(' ');
  const f = path.join(`${W}/r`, p);
  if (!fs.existsSync(f)) { missing++; if (missing <= 5) console.log(`  MISSING: ${p}`); continue; }
  // argv form: the path comes from a third-party tree and is never shell-parsed
  const got = execFileSync('git', ['-C', `${W}/r`, 'hash-object', '--', p], { encoding: 'utf8' }).trim();
  if (got !== oid) { mismatches++; if (mismatches <= 5) console.log(`  DIFFERS: ${p}`); }
}
console.log(`round-trip vs commit tree: ${mismatches} differing, ${missing} missing of ${want.length} files ${mismatches + missing === 0 ? '— EXACT MATCH' : '— MISMATCH'}`);

// 4. GOLD_RED aid: does the suite consult git metadata?
const testScript = m.test_script || '';
const grep = shTry(`git -C ${W}/r grep -lE 'git (describe|rev-parse|log)|\\.git/' ${m.commit_sha} -- ':!node_modules' | head -5`);
console.log(`test script: ${JSON.stringify(testScript)}`);
if (grep.ok && grep.out.trim()) console.log('git-metadata references in tree:\n' + grep.out.trim().split('\n').map(l => '  ' + l).join('\n'));
fs.rmSync(W, { recursive: true, force: true });
