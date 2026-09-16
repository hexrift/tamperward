// The shared CLI status renderer (src/cli/render/status.ts): one palette + severity→colour
// map for every surface, with the accessibility contract (the word carries severity; colour
// strips to a byte-identical line) asserted here so no surface can quietly break it.

import { describe, it, expect } from 'vitest';
import { statusLine, severityColour, paint, RED, YELLOW, GREEN, CYAN, type Severity } from '../src/cli/render/status';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, '');
const SEVERITIES: Severity[] = ['ok', 'warn', 'bad', 'info'];

describe('shared status renderer', () => {
  it('coloured output is byte-identical to uncoloured once SGR escapes are stripped', () => {
    for (const sev of SEVERITIES) {
      const on = statusLine(sev, 'LABEL', 'the message text', true);
      const off = statusLine(sev, 'LABEL', 'the message text', false);
      expect(strip(on)).toBe(off);
    }
  });

  it('the label word carries the severity and is padded to a fixed width', () => {
    const off = statusLine('bad', 'ERROR', 'boom', false);
    expect(off).toBe('ERROR    boom'); // 'ERROR' padded to 8 + ' ' + text
    expect(off).toContain('ERROR');
  });

  it('severity→colour map is the single source of truth', () => {
    expect(severityColour('ok')).toBe(GREEN);
    expect(severityColour('warn')).toBe(YELLOW);
    expect(severityColour('bad')).toBe(RED);
    expect(severityColour('info')).toBe(CYAN);
  });

  it('a coloured line actually carries the severity colour, and only bad is emphasised', () => {
    expect(statusLine('warn', 'WARN', 'x', true)).toContain(YELLOW);
    expect(statusLine('bad', 'ERROR', 'x', true)).toContain('[1m'); // BOLD
    expect(statusLine('warn', 'WARN', 'x', true)).not.toContain('[1m');
  });

  it('paint is a no-op when colour is off and wraps+resets when on', () => {
    expect(paint('x', GREEN, false)).toBe('x');
    expect(paint('x', GREEN, true)).toBe(`${GREEN}x[0m`);
  });
});
