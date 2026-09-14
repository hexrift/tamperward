// #19 test-support (file surface, mechanical, warn).
//
// The `tests` globs also cover the files that SERVE the specs: helpers, setup
// modules, mocks, JSON fixtures, case tables. Until #443 those were judged by the
// spec rules and blocked on deletion or trimming although they define no test.
// This rule takes that class at warn: a deleted, moved-out or shrunk support
// file is worth a reviewer's glance — a gutted `setup.ts` can silence a mock
// that made a spec strict — but it removes no test, so it is a prompt, not a gate.
// Which files are support is `isSpecShaped`'s decision (spec-shape.ts), shared
// with the spec rules so a file is one or the other, never both and never neither.

import { Change, Detector, Finding } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { isSpecShaped } from './spec-shape';
import { isSignificantLine, langOf } from './files';

const RULE = 'test-support';
// The same floor as test-content-removal: a one- or two-line tweak is an edit.
const MIN_REMOVED_LINES = 3;

const ws = (s: string): string => s.replace(/\s+/g, '');

function significant(src: string, path: string): string[] {
  const lang = langOf(path);
  const out: string[] = [];
  for (const raw of src.split('\n')) {
    const l = raw.trim();
    if (isSignificantLine(l, lang)) out.push(l);
  }
  return out;
}

export const testSupport: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    // a tests-category file that is neither a snapshot (row 11's) nor a spec
    const isSupport = (p: string, before: string | null, after: string | null) =>
      isProtected(p, policy, 'tests') && !isProtected(p, policy, 'snapshots') && !isSpecShaped(p, before, after);

    // Everything the change keeps or adds anywhere, whitespace-stripped: a support
    // line that reappears there moved, and a move is not a removal.
    let kept = '';
    for (const c of changes) {
      if (c.kind === 'file' && c.after != null) kept += ws(c.after);
    }

    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (c.op === 'delete') {
        if (!isSupport(c.path, c.before, null)) continue;
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: 'A test-support file was deleted (a helper, setup module or fixture under the test globs; it defines no test).',
            evidence: c.path,
            remediation: 'Check that nothing in the suite still needs it. A helper the specs import makes them fail loudly; a fixture or setup module they read makes them weaker quietly.',
            defaultSeverity: 'warn',
          }),
        );
      } else if (c.op === 'rename' && c.oldPath && isSupport(c.oldPath, c.before, c.after) && !isProtected(c.path, policy, 'tests')) {
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: `A test-support file was renamed out of the test globs (${c.oldPath} → ${c.path}).`,
            evidence: `${c.oldPath} → ${c.path}`,
            remediation: 'Keep test helpers and fixtures under the test tree, where the policy protects them.',
            defaultSeverity: 'warn',
          }),
        );
      } else if ((c.op === 'modify' || c.op === 'rename') && c.before != null && c.after != null) {
        if (!isSupport(c.path, c.before, c.after)) continue;
        const beforeSig = significant(c.before, c.path);
        const afterSig = significant(c.after, c.path);
        const netDrop = beforeSig.length - afterSig.length;
        if (netDrop < MIN_REMOVED_LINES) continue;
        const afterSet = new Set(afterSig);
        const gone = [...new Set(beforeSig)].filter((l) => !afterSet.has(l) && !kept.includes(ws(l)));
        if (gone.length < MIN_REMOVED_LINES) continue;
        out.push(
          makeFinding(RULE, policy, {
            file: c.path,
            message: `Test-support content removed: ${gone.length} significant line(s) gone from a helper, setup module or fixture under the test globs.`,
            evidence: gone.slice(0, 3).map((l) => l.slice(0, 80)).join(' | '),
            remediation: 'Check what the specs lose. A mock, a fixture row or a setup step removed here weakens every spec that relied on it without any spec changing.',
            defaultSeverity: 'warn',
          }),
        );
      }
    }
    return out;
  },
};
