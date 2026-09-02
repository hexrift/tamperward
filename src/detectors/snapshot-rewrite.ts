// #11 snapshot-rewrite (command + file surface, mechanical, WARN).
//
// The move: regenerate the expected output from the actual output. A failing snapshot,
// golden file, or recorded baseline is an assertion; rewriting it from the code under
// test converts "the code is wrong" into "the expectation now agrees with the bug".
//
// This is the one detector built from MEASURED demand rather than intuition. In the
// affordance-seed experiment (harness/PREDICTION-affordance.md), 7 of 10 adversarial
// runs regenerated the golden from buggy output and every one sailed through unseen —
// while three other hypothesized bypass classes measured zero attempts and stay
// unbuilt. The observed trajectory was three tool calls: run suite, run the
// regeneration script, run suite -> green.
//
// WARN, not block: updating a snapshot is the legitimate workflow when intended output
// changes, so the finding asks a human to confirm the new expectation is correct
// rather than asserting bad faith. Graduation to block follows the SPEC §7 evidence
// path like every heuristic-adjacent rule.

import { Change, Detector, Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { makeFinding } from './finding';
import { segments, tokens, unquote } from './command';

const RULE = 'snapshot-rewrite';

// Runner flags that rewrite snapshots wholesale. `-u`/`--update` are common flags
// elsewhere (sort -u, npm update), so they only count in a segment that invokes a
// snapshot-capable runner — by name, or through a package-manager test script that
// forwards its trailing flags to it (`npm test -- -u`, `yarn test -u`, `pnpm test -u`,
// `npm t -- -u`, `npm run test:ci -- --update`). What a script named `test:update`
// does lives in package.json, not in the command, and is not visible here.
// --updateSnapshot(s), node's --test-update-snapshots and syrupy's --snapshot-update
// are unambiguous anywhere.
const RUNNER = /\b(?:jest|vitest|playwright|ava)\b/;
const PM_TEST_SCRIPT = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:t|tst|test|run(?:-script)?\s+\S*test\S*)(?:\s|$)/;
const UPDATE_ANY = /--(?:update-?[sS]napshots?|test-update-snapshots|snapshot-update)\b/;
const UPDATE_WITH_RUNNER = /(?:^|\s)(?:-u|--update)(?:\s|$)/;
// Other ecosystems' accept-everything spellings: insta's `cargo insta accept` (or
// `cargo insta test --accept`) and expect-test's UPDATE_EXPECT=1.
const INSTA_ACCEPT = /\bcargo\s+insta\s+(?:accept\b|.*\s--accept\b)/;
const UPDATE_EXPECT = /(?:^|\s)UPDATE_EXPECT=\S+/;

// Regeneration scripts by naming convention — `node update-golden.mjs` was the exact
// observed vector, and bless/regen/rebless are the same convention in other ecosystems.
const REGEN_SCRIPT = /\b(?:update|regen(?:erate)?|re?bless)[-_.]?(?:golden|snapshots?|baselines?|expected)\b/i;

// Shell verbs that overwrite or remove a file the segment names, `find … -delete` /
// `-exec rm` over a snapshot glob, and `git checkout|restore -- <snapshot>`, which
// replaces the recorded expectation with an older one.
const MUTATE = /(?:^|\s)(?:rm|cp|mv|tee|truncate|dd)(?:\s|$)|sed\s+-i|>{1,2}|\bfind\b.*\s-(?:delete\b|exec\s+rm\b)|\bgit\s+(?:checkout|restore)\b/;

function namesProtectedSnapshot(seg: string, policy: Policy): string | null {
  for (const t of tokens(seg)) {
    const path = unquote(t).replace(/^>{1,2}/, '');
    if (isProtected(path, policy, 'snapshots')) return path;
  }
  return null;
}

export const snapshotRewrite: Detector = {
  id: RULE,
  surface: ['command', 'file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    const warn = (input: Parameters<typeof makeFinding>[2]) =>
      out.push(makeFinding(RULE, policy, { ...input, defaultSeverity: 'warn' }));

    for (const c of changes) {
      if (c.kind === 'command') {
        for (const seg of segments(c.raw)) {
          let why: string | null = null;
          if (UPDATE_ANY.test(seg)) why = 'the snapshot-update flag rewrites every failing snapshot to match current output';
          else if ((RUNNER.test(seg) || PM_TEST_SCRIPT.test(seg)) && UPDATE_WITH_RUNNER.test(seg)) why = 'running the test runner in update mode rewrites failing snapshots to match current output';
          else if (INSTA_ACCEPT.test(seg)) why = 'cargo insta accept rewrites every pending snapshot to match current output';
          else if (UPDATE_EXPECT.test(seg)) why = 'UPDATE_EXPECT=1 rewrites every expect-test expectation to match current output';
          else if (REGEN_SCRIPT.test(seg)) why = 'a regeneration script rewrites the recorded expected output from current output';
          else {
            const path = MUTATE.test(seg) ? namesProtectedSnapshot(seg, policy) : null;
            if (path) why = `the command overwrites or removes the protected snapshot ${path}`;
          }
          if (why) {
            warn({
              message: `Snapshot rewrite: ${why}.`,
              evidence: seg,
              remediation:
                'A snapshot is an assertion. If the test failure is a bug, fix the code; only update the snapshot when the INTENDED output changed, and have a human confirm the new expectation is correct.',
            });
          }
        }
        continue;
      }

      // File surface: an existing recorded expectation was changed or removed. A brand-new
      // snapshot (op add) is ordinary development and is deliberately not flagged.
      const wasSnap = c.oldPath != null && isProtected(c.oldPath, policy, 'snapshots');
      const isSnap = isProtected(c.path, policy, 'snapshots');
      if (c.op === 'add' || (!isSnap && !wasSnap)) continue;

      const what =
        c.op === 'delete' ? 'deleted' :
        c.op === 'rename' && !isSnap ? `renamed out of the protected snapshot set (to ${c.path})` :
        'rewritten';
      warn({
        file: c.op === 'rename' && !isSnap ? (c.oldPath as string) : c.path,
        message: `A recorded expected output was ${what}.`,
        evidence: c.op === 'rename' ? `${c.oldPath} -> ${c.path}` : c.path,
        remediation:
          'If the intended output genuinely changed, a human should confirm the new expectation against the requirement; if the test was failing, fix the code instead of re-recording the expectation from it.',
      });
    }
    return out;
  },
};
