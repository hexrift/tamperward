// Taskbench withheld-case splitter (DESIGN §11, FRAME.md rules).
// A "case" is a top-level test()/it() call ADDED by the task's test patch
// (test.each counts as one case). Cases are ordered by sha256(file + ":" +
// header line); the first ceil(n/2) stay visible, the rest are withheld:
// removed from the agent-visible tree, with the pristine full files saved
// oracle-side for verdict time.
// Usage: node split-cases.mjs <task-dir> <repo-dir> <oracle-dir>
// Writes: <oracle-dir>/pristine/<file> (full patched versions of every test
// file the patch touches), <oracle-dir>/withheld.json (what was withheld).
// Exits 0 with {withheld:N} on stdout; exits 3 if no split is possible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [taskDir, repoDir, oracleDir] = process.argv.slice(2);
const patch = fs.readFileSync(path.join(taskDir, 'test.patch'), 'utf8');

// files the patch touches + the added case-header lines per file
const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]).filter(f => f !== '/dev/null');
const addedHeaders = {};
let cur = null;
for (const line of patch.split('\n')) {
  const f = line.match(/^\+\+\+ b\/(.+)$/); if (f) { cur = f[1]; continue; }
  if (cur && /^\+/.test(line) && /^\+\s*(test|it)\s*\(/.test(line))
    (addedHeaders[cur] ||= []).push(line.slice(1).trim());
}

// pristine copies of every touched test file (full-patch state), always saved
fs.mkdirSync(path.join(oracleDir, 'pristine'), { recursive: true });
for (const f of files) {
  const p = path.join(repoDir, f);
  if (!fs.existsSync(p)) continue;
  const dest = path.join(oracleDir, 'pristine', f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(p, dest);
}

// enumerate added cases in the patched files
const cases = [];
for (const [f, headers] of Object.entries(addedHeaders)) {
  const p = path.join(repoDir, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8'); const lines = src.split('\n');
  for (const h of headers) {
    const idx = lines.findIndex((l, i) => l.trim() === h && !cases.some(c => c.file === f && c.start === i));
    if (idx < 0) continue;
    // balanced-paren scan from the call's first '(' to its close, then to EOL
    let depth = 0, seen = false, end = -1;
    outer: for (let i = idx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '(') { depth++; seen = true; }
        else if (ch === ')') { depth--; if (seen && depth === 0) { end = i; break outer; } }
      }
    }
    if (end < 0) continue;
    cases.push({ file: f, header: h, start: idx, end,
      key: crypto.createHash('sha256').update(`${f}:${h}`).digest('hex') });
  }
}

if (cases.length < 3) { console.log(JSON.stringify({ withheld: 0, cases: cases.length })); process.exit(3); }

cases.sort((a, b) => a.key < b.key ? -1 : 1);
const visibleN = Math.ceil(cases.length / 2);
const withheld = cases.slice(visibleN);

// remove withheld blocks from the agent-visible tree (bottom-up per file)
const byFile = {};
for (const c of withheld) (byFile[c.file] ||= []).push(c);
for (const [f, cs] of Object.entries(byFile)) {
  const p = path.join(repoDir, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const c of cs.sort((a, b) => b.start - a.start)) {
    let len = c.end - c.start + 1;
    // splice hygiene: also consume one blank line adjacent to the removed
    // block so format checkers (prettier) don't see doubled blanks
    if (lines[c.end + 1]?.trim() === '' && lines[c.start - 1]?.trim() === '') len++;
    lines.splice(c.start, len);
  }
  fs.writeFileSync(p, lines.join('\n'));
}

fs.writeFileSync(path.join(oracleDir, 'withheld.json'), JSON.stringify(
  { total: cases.length, visible: visibleN,
    withheld: withheld.map(c => ({ file: c.file, header: c.header })) }, null, 1));
console.log(JSON.stringify({ withheld: withheld.length, cases: cases.length }));
