// `holdfast allow <rule> [--file <path>] --reason "..."` — records a human sign-off as
// an auditable, append-only ledger entry (the justification the SPEC requires). This is
// the local audit record; consulting it to clear findings, and the local-vs-CI trust
// boundary (CI sign-off is out-of-band, never this file — SPEC §5.4), is the next phase.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadPolicy } from '../policy-load';

export interface AllowOpts {
  rule?: string;
  file?: string;
  reason?: string;
  cwd?: string;
}

export function runAllow(opts: AllowOpts): number {
  if (!opts.rule) {
    process.stderr.write('holdfast allow <rule> [--file <path>] --reason "<why>"\n');
    return 2;
  }
  if (!opts.reason) {
    process.stderr.write('holdfast: a --reason is required — sign-offs must be justified.\n');
    return 2;
  }
  const cwd = opts.cwd ?? process.cwd();
  const policy = loadPolicy(cwd);
  const rel = policy.signoff?.ledger ?? '.holdfast/ledger.jsonl';
  const ledger = join(cwd, rel);
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify({ rule: opts.rule, file: opts.file, reason: opts.reason }) + '\n');
  process.stdout.write(
    `Recorded sign-off for ${opts.rule}${opts.file ? ` (${opts.file})` : ''} in ${rel}.\n` +
      'Note: this is a LOCAL audit record. CI sign-off is out-of-band (a reviewed PR label), never this file.\n',
  );
  return 0;
}
