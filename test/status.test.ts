// The shared CLI status renderer (#543). These guard the accessibility contract every
// surface now depends on: severity survives with colour stripped, the severity→colour map
// is the one source of truth, and a crafted message cannot smuggle terminal-control bytes
// through a status line. No surface-specific prose here — those live with each command.

import { describe, expect, it } from 'vitest';
import {
  colourEnabled,
  paint,
  statusLine,
  STATUS_LABEL_WIDTH,
  stripControl,
  terminalText,
  terminalWidth,
  toneColour,
  type StatusTone,
} from '../src/cli/render/status';

const ESC = '';
const ANSI = /\[[0-9;]*m/g;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[38;2;255;107;107m`;
const YELLOW = `${ESC}[38;2;227;179;65m`;
const GREEN = `${ESC}[38;2;63;185;80m`;
const CYAN = `${ESC}[38;2;86;212;221m`;

describe('statusLine accessibility contract', () => {
  it('carries severity as the label WORD, so stripping colour loses nothing', () => {
    const coloured = statusLine('bad', 'ERROR', 'the thing broke', true);
    const mono = statusLine('bad', 'ERROR', 'the thing broke', false);
    expect(coloured.replace(ANSI, '')).toBe(mono);
    expect(mono).toContain('ERROR');
    expect(mono).toContain('the thing broke');
  });

  it('emits no escape sequence at all when colour is off', () => {
    for (const tone of ['ok', 'warn', 'bad', 'info', 'muted'] as StatusTone[]) {
      expect(statusLine(tone, 'LABEL', 'text', false)).not.toContain(ESC);
    }
  });

  it('pads the label to a fixed column so text aligns across surfaces', () => {
    const line = statusLine('info', 'OK', 'aligned', false);
    expect(line).toBe('OK'.padEnd(STATUS_LABEL_WIDTH) + ' aligned');
    expect(line.startsWith('OK' + ' '.repeat(STATUS_LABEL_WIDTH - 2))).toBe(true);
  });

  it('strips terminal-control bytes from the message before it reaches the terminal', () => {
    // A crafted message must not be able to clear the screen / repaint a forged line.
    const line = statusLine('info', 'NOTE', 'before[2Jafter', false);
    expect(line).not.toContain(ESC);
    expect(line).toContain('�[2Jafter');
  });

  it('flattens a multi-line / multi-space message onto one physical line', () => {
    expect(statusLine('ok', 'OK', '  a\n\n   b  ', false)).toBe('OK'.padEnd(STATUS_LABEL_WIDTH) + ' a b');
  });
});

describe('severity → colour is the one source of truth', () => {
  const cases: Array<[StatusTone, string]> = [
    ['ok', GREEN],
    ['warn', YELLOW],
    ['bad', BOLD + RED],
    ['info', CYAN],
    ['muted', DIM],
  ];

  it('paints each tone with its documented colour and always resets', () => {
    for (const [tone, sgr] of cases) {
      const line = statusLine(tone, 'X', 'y', true);
      expect(line.startsWith(sgr + 'X')).toBe(true);
      expect(line).toContain(RESET);
      expect(toneColour(tone)).toBe(sgr);
    }
  });

  it('makes a failure bold so it stands out even where bold is the only styling', () => {
    expect(statusLine('bad', 'ERROR', 'x', true).startsWith(BOLD + RED)).toBe(true);
  });

  it('paint is a no-op when colour is off', () => {
    expect(paint('x', RED, false)).toBe('x');
    expect(paint('x', RED, true)).toBe(RED + 'x' + RESET);
  });
});

describe('shared colour/width/strip primitives', () => {
  it('colourEnabled honours NO_COLOR / FORCE_COLOR / dumb / TTY', () => {
    expect(colourEnabled({}, { isTTY: true })).toBe(true);
    expect(colourEnabled({}, { isTTY: false })).toBe(false);
    expect(colourEnabled({ NO_COLOR: '1' }, { isTTY: true })).toBe(false);
    expect(colourEnabled({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(true);
    expect(colourEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, { isTTY: true })).toBe(false);
    expect(colourEnabled({ TERM: 'dumb' }, { isTTY: true })).toBe(false);
  });

  it('terminalWidth clamps to a readable measure', () => {
    expect(terminalWidth({})).toBe(80);
    expect(terminalWidth({ columns: 400 })).toBe(100);
    expect(terminalWidth({ columns: 72 })).toBe(72);
  });

  it('stripControl replaces C0/C1 bytes with U+FFFD but keeps tab/newline/return', () => {
    expect(stripControl('abcde\tf\ng\rh')).toBe('a�b�c�d�e\tf\ng\rh');
  });

  it('terminalText scrubs control bytes and collapses whitespace to one line', () => {
    expect(terminalText('  x[2J   y  ')).toBe('x�[2J y');
  });
});
