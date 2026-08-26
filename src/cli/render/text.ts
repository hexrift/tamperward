// Terminal rendering of the verdict.
//
// ACCESSIBILITY CONTRACT. Severity is carried by the WORD ("BLOCK" / "warn"), never by
// colour alone: colour is decoration layered on top of text that already says the same
// thing. That keeps the output correct on a colour-blind reader's terminal, through a
// screen reader, in a pipe, and in a CI log — the four places this output actually gets
// read. For the same reason there are no emoji, no box-drawing, and no glyph anywhere
// that is the sole carrier of meaning.
//
// The `path:line` pair stays on the finding's own line rather than being hoisted into a
// group heading, because terminals linkify it — clicking straight to the offending line
// is worth more than the few characters grouping would save.

import { Finding } from '../../types';

export interface TextOpts {
  colour: boolean;
  width: number;
}

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;

/**
 * Honours the NO_COLOR convention (https://no-color.org): set to any non-empty value,
 * colour is off regardless of what it says. FORCE_COLOR overrides in the other direction
 * so a CI log or a `less -R` pager can opt back in. Otherwise: colour only on a TTY.
 */
export function colourEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

/** Wrap to the terminal, but never past 100 columns — long measures are hard to track. */
export function terminalWidth(stream: { columns?: number } = process.stdout): number {
  const c = stream.columns;
  if (!c || c < 40) return 80;
  return Math.min(c, 100);
}

function paint(s: string, code: string, on: boolean): string {
  return on ? code + s + RESET : s;
}

/** Greedy wrap. A word longer than the measure is emitted whole rather than split — a
 *  path or a flag broken across lines stops being copy-pasteable. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Evidence is the literal offending line, so it is clipped rather than wrapped: a
 *  reflowed source line no longer looks like the thing it quotes. */
function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, Math.max(1, max - 1)) + '…' : one;
}

/** Blocking first, then by file, then by line — the order you would work them in. */
export function orderFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'block' ? -1 : 1;
    const fa = a.file ?? '';
    const fb = b.file ?? '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

export function countsPhrase(blocks: number, warns: number): string {
  const parts: string[] = [];
  if (blocks) parts.push(`${blocks} blocking`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function scopePhrase(scanned: number, ignoredFiles: number): string {
  const ignored =
    ignoredFiles > 0 ? `, ${ignoredFiles} file${ignoredFiles === 1 ? '' : 's'} ignored by policy` : '';
  return `${scanned} change${scanned === 1 ? '' : 's'} scanned${ignored}`;
}

export const SIGNOFF_NOTE =
  'A blocking finding clears only with a human sign-off. In CI that sign-off is out-of-band ' +
  '— a PR label applied by a reviewer — never a file committed on the branch under ' +
  'review. See SPEC §5.4.';

export interface TextInput {
  findings: Finding[];
  scanned: number;
  ignoredFiles: number;
}

/** The whole verdict as a string. Returned rather than written so it can be asserted on
 *  directly and reused verbatim as the body of the CI log. */
export function renderText(input: TextInput, opts: TextOpts): string {
  const { scanned, ignoredFiles } = input;
  const findings = orderFindings(input.findings);
  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  const c = opts.colour;
  const out: string[] = [];

  // Verdict first. You should not have to scroll to learn whether you are blocked.
  if (findings.length === 0) {
    return `${paint('tamperward: clean', GREEN, c)} — no integrity findings (${scopePhrase(scanned, ignoredFiles)}).\n`;
  }
  const headColour = blocks.length ? RED : YELLOW;
  out.push(paint(`tamperward: ${countsPhrase(blocks.length, warns.length)}`, BOLD + headColour, c));
  out.push(paint(`(${scopePhrase(scanned, ignoredFiles)})`, DIM, c));
  out.push('');

  const LABEL = 'sign-off'.length; // widest label; every row aligns to it
  const pad = (k: string) => (k + ' '.repeat(LABEL)).slice(0, LABEL);
  const body = Math.max(20, opts.width - LABEL - 6);

  for (const f of findings) {
    const isBlock = f.severity === 'block';
    const mark = paint(isBlock ? 'BLOCK' : 'warn ', isBlock ? BOLD + RED : YELLOW, c);
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(command)';
    out.push(`  ${mark}  ${paint(f.rule, BOLD, c)}  ${paint(loc, DIM, c)}`);

    // The message is the finding, so it gets the shallowest indent and no label —
    // burying the one sentence that says what happened behind a label column reads
    // as if it were an attribute of the finding rather than the finding itself.
    for (const l of wrap(f.message, opts.width - 4)) out.push(`    ${l}`);

    const row = (key: string, lines: string[]) => {
      lines.forEach((l, i) => out.push(`    ${paint(pad(i === 0 ? key : ''), DIM, c)}  ${l}`));
    };
    row('evidence', [paint(clip(f.evidence, body), DIM, c)]);
    row('instead', wrap(f.remediation, body));
    if (f.signoff.required) row('sign-off', [f.signoff.command]);
    out.push('');
  }

  if (blocks.length > 0) {
    out.push(
      wrap(SIGNOFF_NOTE, opts.width - 2)
        .map((l) => paint(l, DIM, c))
        .join('\n'),
    );
  }

  return out.join('\n').replace(/\n+$/, '') + '\n';
}
