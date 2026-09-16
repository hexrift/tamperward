// The single source of truth for the CLI's status palette and status-line rendering.
//
// ACCESSIBILITY CONTRACT (shared with render/text.ts). Severity is carried by the WORD
// (the label), never by colour alone: colour is decoration layered on text that already
// says the same thing, so the output reads correctly for a colour-blind reader, through a
// screen reader, in a pipe, and in a CI log. Colour is emitted solely as SGR escapes that
// strip to nothing, so a line rendered with colour off is byte-identical to the coloured
// one with the escapes removed. NO_COLOR / a pipe / TERM=dumb drop colour entirely
// (colourEnabled). No emoji or glyph is ever the sole carrier of meaning.

const ESC = '';
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;

// 24-bit palette. A terminal without truecolor down-samples to its nearest colour.
const truecolour = (r: number, g: number, b: number): string => `${ESC}[38;2;${r};${g};${b}m`;
export const RED = truecolour(255, 107, 107);
export const YELLOW = truecolour(227, 179, 65);
export const GREEN = truecolour(63, 185, 80);
export const CYAN = truecolour(86, 212, 221);

/** Wrap `s` in `code` (and a reset) only when colour is on, so the off rendering stays
 *  byte-identical to the on rendering with the escapes stripped. */
export function paint(s: string, code: string, on: boolean): string {
  return on ? code + s + RESET : s;
}

/** The fixed severity set every surface maps onto. `bad` is the only one emphasised. */
export type Severity = 'ok' | 'warn' | 'bad' | 'info';

const TONE: Record<Severity, { colour: string; bold: boolean }> = {
  ok: { colour: GREEN, bold: false },
  warn: { colour: YELLOW, bold: false },
  bad: { colour: RED, bold: true },
  info: { colour: CYAN, bold: false },
};

/** The colour for a severity — the one map every surface reads instead of re-deriving it. */
export function severityColour(sev: Severity): string {
  return TONE[sev].colour;
}

/** The label column width — every surface's status word aligns to it. */
export const STATUS_LABEL_WIDTH = 8;

/**
 * One status line: a padded label word that ALONE carries the severity, then the message.
 * Only the label is painted, and it strips to a byte-identical line, so `colour: false`
 * output equals the coloured output with SGR escapes removed.
 */
export function statusLine(severity: Severity, label: string, text: string, colour: boolean): string {
  const t = TONE[severity];
  const painted = paint(label.padEnd(STATUS_LABEL_WIDTH), (t.bold ? BOLD : '') + t.colour, colour);
  return `${painted} ${text}`;
}
