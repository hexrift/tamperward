import { oobLabel } from '../signoff';

export interface SignoffLabelOpts {
  rule?: string;
  file?: string;
  head?: string;
}

/** Print the GitHub label that binds one CI approval to one exact scope/head. */
export function runSignoffLabel(opts: SignoffLabelOpts): number {
  if (!opts.rule) throw new Error('signoff-label requires a rule');
  if (!opts.head) throw new Error('signoff-label requires --head');
  const want = opts.file ? `${opts.rule}:${opts.file}` : opts.rule;
  process.stdout.write(`${oobLabel(want, opts.head)}\n`);
  return 0;
}
