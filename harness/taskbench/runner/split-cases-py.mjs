// Taskbench withheld-case splitter — PYTHON grammar, identical frozen
// semantics to split-cases.mjs (DESIGN §11): a "case" is a test function
// ADDED by the task's test patch (`def test_*` / `async def test_*`;
// parametrization is one case — one def). Cases are ordered by
// sha256(file + ":" + header line); the first ceil(n/2) stay visible, the
// rest are withheld: removed from the agent-visible tree, with the pristine
// full files saved oracle-side for verdict time. Exits 3 if no split is
// possible (<3 cases), exactly as the JS splitter does.
//
// Block extents are PYTHON-PARSER-DERIVED (v2 correction): v1 approximated
// function extent from indentation, which fails on valid Python whenever a
// multiline string contains column-0 interior lines (revalidation run-2,
// 04-ipython: an embedded-script triple-quote was cut mid-string; caught by
// the py_compile gate). v2 asks Python's ast for each ALREADY-SELECTED
// function's extent: start = earliest decorator line when decorators exist,
// else the def line; end = node.end_lineno. FunctionDef and AsyncFunctionDef
// both handled. Selection, ordering, partitioning, and fallback rules are
// unchanged — this replaces only "where does the selected function begin and
// end", never what counts as a test.
// Usage: node split-cases-py.mjs <task-dir> <repo-dir> <oracle-dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [taskDir, repoDir, oracleDir] = process.argv.slice(2);
const patch = fs.readFileSync(path.join(taskDir, 'test.patch'), 'utf8');

const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]).filter(f => f !== '/dev/null');
const addedHeaders = {};
let cur = null;
for (const line of patch.split('\n')) {
  const f = line.match(/^\+\+\+ b\/(.+)$/); if (f) { cur = f[1]; continue; }
  if (cur && /^\+/.test(line) && /^\+\s*(async\s+)?def test_/.test(line))
    (addedHeaders[cur] ||= []).push(line.slice(1)); // keep indentation: it scopes the block
}

fs.mkdirSync(path.join(oracleDir, 'pristine'), { recursive: true });
for (const f of files) {
  const p = path.join(repoDir, f);
  if (!fs.existsSync(p)) continue;
  const dest = path.join(oracleDir, 'pristine', f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(p, dest);
}

// AST extents for the selected def lines of one file: prints JSON
// [{def_line, start, end}] (0-based). Only extent computation lives in
// Python; selection stays above, in the patch-derived header match.
const AST_HELPER = `
import ast, json, sys
src = open(sys.argv[1]).read()
want = set(int(x) for x in sys.argv[2:])
out = []
try:
    tree = ast.parse(src)
except SyntaxError:
    print(json.dumps(out)); raise SystemExit(0)
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and (node.lineno - 1) in want:
        start = min((d.lineno for d in node.decorator_list), default=node.lineno) - 1
        out.append({"def_line": node.lineno - 1, "start": start, "end": node.end_lineno - 1})
print(json.dumps(out))
`;

const cases = [];
for (const [f, headers] of Object.entries(addedHeaders)) {
  const p = path.join(repoDir, f);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const defLines = [];
  for (const h of headers) {
    const idx = lines.findIndex((l, i) => l === h && !defLines.some(d => d.idx === i));
    if (idx < 0) continue;
    defLines.push({ idx, h });
  }
  if (!defLines.length) continue;
  let extents = [];
  try {
    extents = JSON.parse(execFileSync('python3', ['-c', AST_HELPER, p, ...defLines.map(d => String(d.idx))], { encoding: 'utf8' }));
  } catch { continue; }
  for (const { idx, h } of defLines) {
    const e = extents.find(x => x.def_line === idx);
    if (!e) continue;
    cases.push({ file: f, header: h.trim(), defLine: idx, start: e.start, end: e.end,
      key: crypto.createHash('sha256').update(`${f}:${h.trim()}`).digest('hex') });
  }
}

if (cases.length < 3) { console.log(JSON.stringify({ withheld: 0, cases: cases.length })); process.exit(3); }

cases.sort((a, b) => a.key < b.key ? -1 : 1);
const visibleN = Math.ceil(cases.length / 2);
const withheld = cases.slice(visibleN);

const byFile = {};
for (const c of withheld) (byFile[c.file] ||= []).push(c);
for (const [f, cs] of Object.entries(byFile)) {
  const p = path.join(repoDir, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const c of cs.sort((a, b) => b.start - a.start)) {
    let len = c.end - c.start + 1;
    // splice hygiene: also consume one adjacent blank line so the removal
    // doesn't leave tripled blanks between the neighbours
    if (lines[c.end + 1]?.trim() === '' && lines[c.start - 1]?.trim() === '') len++;
    lines.splice(c.start, len);
  }
  fs.writeFileSync(p, lines.join('\n'));
}

fs.writeFileSync(path.join(oracleDir, 'withheld.json'), JSON.stringify(
  { total: cases.length, visible: visibleN,
    withheld: withheld.map(c => ({ file: c.file, header: c.header })) }, null, 1));
console.log(JSON.stringify({ withheld: withheld.length, cases: cases.length }));
