// The one source of truth for terminal STATUS presentation, shared by every CLI surface
// (check, onboard, doctor, verify). Before this module each command re-declared its own
// palette and status helper — onboard even used the basic 8-colour codes where the verdict
// used 24-bit truecolour — so the same concept read three different ways and the
// accessibility-critical rendering logic was duplicated per surface.
//
// ACCESSIBILITY CONTRACT (identical to the verdict renderer's — see render/text.ts).
// Severity is carried by the WORD ("OK" / "WARN" / "BROKEN"), never by colour alone:
// colour is decoration layered on top of text that already says the same thing. So the
// output stays correct on a colour-blind reader's terminal, through a screen reader, in a
// pipe, and in a CI log. Colour is emitted solely as SGR escapes that strip to nothing and
// never add or remove a printable byte, so a status line renders BYTE-IDENTICALLY with
// colour off. There is no emoji, box-drawing, or glyph that is the sole carrier of meaning.
// `NO_COLOR` / a pipe / `TERM=dumb` drop every escape (see `colourEnabled`).

const ESC = '';
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
// 24-bit palette — the canonical accessible one. A terminal without truecolour
// down-samples to its nearest colour; NO_COLOR / a pipe / TERM=dumb drop them entirely.
const truecolour = (r: number, g: number, b: number): string => `${ESC}[38;2;${r};${g};${b}m`;
export const RED = truecolour(255, 107, 107);
export const YELLOW = truecolour(227, 179, 65);
export const GREEN = truecolour(63, 185, 80);
export const CYAN = truecolour(86, 212, 221);

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

/** Replace C0/C1 control bytes with U+FFFD. Written as a code-point scan rather
 *  than a regex literal on purpose: the character class needs `no-control-regex`
 *  suppressed, and this project's own gate blocks lint suppressions — correctly.
 *  \t \n \r are left for the \\s+ collapse callers apply. */
export function stripControl(v: string): string {
  let outStr = '';
  for (const ch of v) {
    const cp = ch.codePointAt(0) ?? 0;
    const control = (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
    outStr += control ? '�' : ch;
  }
  return outStr;
}

/** Repository paths, policy commands and diagnostic detail are untrusted terminal input.
 *  Keep a status line on one physical line and remove terminal-control bytes before any
 *  ANSI decoration is added, so a crafted detail cannot emit `ESC[2J` and repaint a forged
 *  line in tamperward's own stdout. */
export function terminalText(text: string): string {
  return stripControl(text).replace(/\s+/g, ' ').trim();
}

/** Layer an SGR code over text, but only when colour is on; off, the text is returned
 *  untouched so the line is byte-identical to the coloured one with escapes stripped. */
export function paint(s: string, code: string, on: boolean): string {
  return on ? code + s + RESET : s;
}

/** The four documented status severities, plus a neutral `muted` tone for secondary,
 *  non-severity lines (a continuation, a de-emphasised piece of context). Severity picks
 *  the colour; the LABEL word passed to `statusLine` still carries the meaning. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

/** Severity → colour. THE one map; no surface re-declares it. `bad` is bold so a failure
 *  still stands out on a terminal where bold is the only styling that renders. */
const TONE_SGR: Record<StatusTone, string> = {
  ok: GREEN,
  warn: YELLOW,
  bad: BOLD + RED,
  info: CYAN,
  muted: DIM,
};

/** The colour a tone paints with (the raw SGR code), exposed so a surface that must build
 *  a line by hand still draws from the one map rather than re-deriving the mapping. */
export function toneColour(tone: StatusTone): string {
  return TONE_SGR[tone];
}

/** Width the label is padded to, so message text aligns into a column across every
 *  surface. The widest canonical label ("GIT ROOT", "RUNTIME", "BROKEN") is 8. */
export const STATUS_LABEL_WIDTH = 8;

/**
 * One status line, shared by every CLI surface: a tone-coloured, column-padded LABEL then
 * the message. The label word carries the severity (colour is decoration that strips to a
 * byte-identical line); `text` is control-scrubbed and flattened to one physical line
 * because paths, policy commands and diagnostic detail are untrusted terminal input.
 */
export function statusLine(tone: StatusTone, label: string, text: string, colour: boolean): string {
  return paint(label.padEnd(STATUS_LABEL_WIDTH), TONE_SGR[tone], colour) + ' ' + terminalText(text);
}
