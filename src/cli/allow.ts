// `tamperward allow <rule> [--file <path>] --reason "..."` — record a HUMAN sign-off, bound to the
// specific tamper it clears. It re-evaluates the current working tree, finds the matching
// blocking finding(s), and records each one's fingerprint (rule + file + evidence) with an
// expiry — so the sign-off clears THAT tamper, not a standing license for the rule. Honored only
// at the LOCAL layer (pre-commit); the agent-layer hook ignores the ledger entirely, and CI
// honors only an out-of-band approval — see src/signoff.ts.

import { diffWorktree } from '../git/build';
import { evaluate } from '../engine';
import { loadPolicy } from '../policy-load';
import { appendEntry, fingerprintOf, makeEntry } from '../signoff';

export interface AllowOpts {
  rule?: string;
  file?: string;
  reason?: string;
  cwd?: string;
}

export function runAllow(opts: AllowOpts): number {
  if (!opts.rule) {
    process.stderr.write('tamperward allow <rule> [--file <path>] --reason "<why>"\n');
    return 2;
  }
  if (!opts.reason) {
    process.stderr.write('tamperward: a --reason is required — sign-offs must be justified.\n');
    return 2;
  }
  const cwd = opts.cwd ?? process.cwd();
  const policy = loadPolicy(cwd);

  let findings;
  try {
    findings = evaluate(diffWorktree({ cwd }), policy);
  } catch {
    process.stderr.write('tamperward: cannot read the working tree (not a git repo?).\n');
    return 2;
  }

  // Bind the sign-off to the actual blocking tamper(s) for this rule (+ file, if given).
  const targets = findings.filter(
    (f) => f.severity === 'block' && f.rule === opts.rule && (!opts.file || f.file === opts.file),
  );
  if (targets.length === 0) {
    process.stderr.write(
      `tamperward: no current blocking "${opts.rule}"${opts.file ? ` (${opts.file})` : ''} finding to sign off — nothing recorded.\n` +
        'A sign-off must clear a specific tamper that the gate is currently flagging.\n',
    );
    return 2;
  }

  const now = Date.now();
  const seen = new Set<string>();
  for (const f of targets) {
    const fp = fingerprintOf(f);
    if (seen.has(fp)) continue;
    seen.add(fp);
    appendEntry(cwd, policy, makeEntry(f, opts.reason, now));
  }
  process.stdout.write(
    `Recorded ${seen.size} human sign-off(s) for ${opts.rule}${opts.file ? ` (${opts.file})` : ''}, bound to the current tamper (expires in 30 days).\n` +
      'Honored at LOCAL pre-commit only. The agent-layer hook ignores this file; CI requires an out-of-band approval, never a committed entry.\n',
  );
  return 0;
}
