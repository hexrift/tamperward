import { compactOobToken } from '../signoff';

export interface SignoffLabelOpts {
  rule?: string;
  file?: string;
  head?: string;
}

/** Print the compact label a reviewer can apply to the current PR head. */
export function runSignoffLabel(opts: SignoffLabelOpts): number {
  if (!opts.rule) {
    process.stderr.write('tamperward signoff-label --rule <rule> --head <full-head-sha> [--file <path>]\n');
    return 2;
  }
  if (!opts.head) {
    process.stderr.write('tamperward: --head is required and must be a full 40- or 64-character object id.\n');
    return 2;
  }
  const want = opts.file ? `${opts.rule}:${opts.file}` : opts.rule;
  const token = compactOobToken(want, opts.head);
  if (!token) {
    process.stderr.write('tamperward: --head must be a full 40- or 64-character hexadecimal object id.\n');
    return 2;
  }
  process.stdout.write(`${token}\n`);
  return 0;
}
