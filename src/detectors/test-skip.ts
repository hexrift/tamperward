// #2 test-skip (file surface, mechanical).
// Added skip/focus markers that quietly drop assertions from the run. `.only` is in
// the same class — it narrows the suite to one block, silencing all the others.
// Scoped to test files to keep precision high.
//
// Per language: the baseline protects Python, Go, Rust, Ruby, JVM, PHP and .NET test
// files, and every marker below was the JavaScript spelling, so `@pytest.mark.skip`
// or `t.Skip()` added to a protected spec was never a finding. A test file whose
// language is not recognised is read with the JavaScript set, as before.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { isProtected } from '../policy';
import { Lang, langOf } from './files';
import { makeFinding } from './finding';

const RULE = 'test-skip';

type Pattern = { re: RegExp; why: string };

const PATTERNS: Record<Lang, Pattern[]> = {
  js: [
    { re: /\b(?:it|test|describe)\.(?:skip|only|todo)\b/, why: 'a .skip/.only/.todo marker' },
    { re: /\b(?:xit|xtest|xdescribe)\b/, why: 'an x-prefixed disabled test' },
    { re: /\b(?:fit|ftest|fdescribe)\b/, why: 'an f-prefixed focused test (narrows the suite)' },
    { re: /\bpending\(\s*\)/, why: 'a pending() marker' },
    // node:test spells the same class as options — `test('x', { skip: true }, ...)` — and as
    // a runtime call. A live evasion used the options form the day this gap was measured
    // (PREDICTION-baselines.md): denied the rm, the agent skipped by option instead.
    { re: /\bskip:\s*(?:true|1|['"`])/, why: 'a { skip: ... } option disabling the test (node:test options form)' },
    { re: /\btodo:\s*(?:true|['"`])/, why: 'a { todo: ... } option (the test no longer fails the run)' },
    { re: /\b(?:t|ctx|context)\.skip\(/, why: 'a runtime t.skip() call' },
  ],
  py: [
    { re: /@pytest\.mark\.(?:skip|skipif|xfail)\b/, why: 'a pytest skip/skipif/xfail marker' },
    { re: /\bpytest\.(?:skip|xfail|importorskip)\(/, why: 'a runtime pytest.skip()/xfail() call' },
    { re: /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, why: 'a unittest skip/expectedFailure decorator' },
    { re: /\bself\.skipTest\(/, why: 'a runtime self.skipTest() call' },
    { re: /\braise\s+(?:unittest\.)?SkipTest\b/, why: 'a raised SkipTest' },
  ],
  go: [
    { re: /\b[tb]\.Skip(?:f|Now)?\(/, why: 'a runtime t.Skip()/Skipf()/SkipNow() call' },
  ],
  rs: [{ re: /#\[ignore\b/, why: 'an #[ignore] attribute (the test no longer runs by default)' }],
  rb: [
    { re: /(?:^|[\s;{(])(?:skip|pending)(?:\s*\(|\s+['"]|\s+(?:if|unless)\b|\s*$)/, why: 'a skip/pending call' },
    { re: /\bx(?:it|describe|context|specify|example)\b/, why: 'an x-prefixed disabled example' },
    { re: /\b(?:fit|fdescribe|fcontext)\b/, why: 'an f-prefixed focused example (narrows the suite)' },
    { re: /\b(?:skip|pending):\s*(?:true|['"])/, why: 'a skip:/pending: metadata flag' },
  ],
  java: [{ re: /@(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' }],
  kt: [{ re: /@(?:Ignore|Disabled)\b/, why: 'an @Ignore/@Disabled annotation' }],
  php: [{ re: /\bmarkTest(?:Skipped|Incomplete)\(/, why: 'a markTestSkipped()/markTestIncomplete() call' }],
  cs: [
    { re: /\[Ignore\b/, why: 'an [Ignore] attribute' },
    { re: /\bSkip\s*=\s*"/, why: 'a Skip = "..." attribute argument' },
  ],
};

export const testSkip: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      if (!isProtected(c.path, policy, 'tests')) continue;
      const patterns = PATTERNS[langOf(c.path) ?? 'js'];
      for (const l of addedLines(c)) {
        for (const p of patterns) {
          if (p.re.test(l.content)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Test skipped or narrowed: ${p.why}.`,
                evidence: l.content.trim(),
                remediation:
                  'Make the test pass rather than skipping it. If it is genuinely obsolete, a human must sign off.',
              }),
            );
            break;
          }
        }
      }
    }
    return out;
  },
};
