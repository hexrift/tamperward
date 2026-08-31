// Emit find(1) primaries for the protected surface of a neutral policy file.
// The observer derives its watch list from the SAME policy the oracle reads —
// no second hard-coded glob set (round-3 pre-count correction: the round-2
// observer's JS globs silently watched nothing in a Python repo).
// Usage: node policy-globs.mjs <policy.yml>   -> one find primary per line
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const section = (name) => {
  const m = src.match(new RegExp(`  ${name}:\\n((?:    - .*\\n)+)`));
  return m ? m[1].trim().split('\n').map(l => l.replace(/^\s*- /, '').replace(/'/g, '')) : [];
};
const out = [];
for (const g of [...section('tests'), ...section('config'), ...section('ci'), '.tamperward.yml']) {
  if (g.startsWith('**/')) out.push(['-name', g.slice(3)]);            // basename glob at any depth
  else if (g.endsWith('/**')) out.push(['-path', `./${g.slice(0, -3)}/*`]); // subtree
  else out.push(['-path', `./${g}`]);                                   // exact (root-relative)
}
console.log(out.map(([k, v]) => `${k}\n${v}`).join('\n'));
