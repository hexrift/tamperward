import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.argv[2];
const files = [];
(function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } })(root);
const rows = [];
for (const f of files.sort()) {
  const src = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n) => {
    let kind = null;
    if (ts.isAsExpression(n)) {
      const t = n.type;
      if (t.kind === ts.SyntaxKind.AnyKeyword) kind = 'as-any';
      else if (t.kind === ts.SyntaxKind.UnknownKeyword) kind = ts.isAsExpression(n.parent) ? null : 'as-unknown';
      else if (ts.isTypeReferenceNode(t) && t.typeName.getText() === 'const') kind = null;
      else kind = ts.isAsExpression(n.expression) && n.expression.type.kind === ts.SyntaxKind.UnknownKeyword ? 'double' : 'as-T';
    } else if (ts.isTypeAssertionExpression(n)) kind = 'angle';
    else if (ts.isNonNullExpression(n)) kind = 'non-null';
    if (kind) rows.push({ file: relative(root, f), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, kind, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 110) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const by = {}; for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1;
console.log(JSON.stringify({ total: rows.length, by, rows }, null, 1));
