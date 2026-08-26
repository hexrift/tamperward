import { Finding } from '../types';

export interface ReportInput {
  findings: Finding[];
  scanned: number;
  ignoredFiles: number;
  json?: boolean;
}

/** Human- (and CI-log-) readable rendering of the verdict. */
export function report(input: ReportInput): void {
  const { findings, scanned, ignoredFiles } = input;

  if (input.json) {
    process.stdout.write(JSON.stringify({ findings, scanned, ignoredFiles }, null, 2) + '\n');
    return;
  }

  const ignoredNote = ignoredFiles > 0 ? `, ${ignoredFiles} file(s) ignored by policy` : '';

  if (findings.length === 0) {
    process.stdout.write(`tamperward: clean — no integrity findings (${scanned} change(s) scanned${ignoredNote}).\n`);
    return;
  }

  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');

  for (const f of findings) {
    const mark = f.severity === 'block' ? 'BLOCK' : 'warn';
    const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    process.stdout.write(`\n[${mark}] ${f.rule}${loc}\n`);
    process.stdout.write(`  ${f.message}\n`);
    process.stdout.write(`  evidence: ${f.evidence}\n`);
    process.stdout.write(`  fix:      ${f.remediation}\n`);
    if (f.signoff.required) process.stdout.write(`  sign-off: ${f.signoff.command}\n`);
  }

  process.stdout.write(
    `\ntamperward: ${blocks.length} blocking, ${warns.length} warning (${scanned} change(s) scanned${ignoredNote}).\n`,
  );
  if (blocks.length > 0) {
    process.stdout.write(
      'A blocking finding clears only with a human sign-off. In CI, sign-off is out-of-band ' +
        '(a reviewed PR label), never a committed file — see SPEC §5.4.\n',
    );
  }
}
