// D-9: every string a finding carries reaches the terminal and the Actions log
// control-stripped — not only evidence. Message and remediation quote policy-
// derived text (an `ignore` glob, a verify command), so `ignore: ["[2J…"]`
// used to print a raw clear-screen through the text renderer.

import { describe, expect, it } from 'vitest';
import { Finding } from '../src/types';
import { renderText, stripControl } from '../src/cli/render/text';
import { annotations, renderSummary } from '../src/cli/render/github';
import { policyWeakening } from '../src/detectors/policy-diff';

const ESC = '\u001b';
const CLEAR = `${ESC}[2J${ESC}[1;1H`;

function finding(over: Partial<Finding> = {}): Finding {
  return {
    rule: 'hook-tampering',
    severity: 'block',
    file: '.tamperward.yml',
    line: 3,
    message: `The policy was weakened: ignore globs added (${CLEAR}forged clean verdict).`,
    evidence: 'plain',
    remediation: `Remove the glob ${CLEAR} and try again.`,
    signoff: { required: true, command: `tamperward allow hook-tampering --reason "${CLEAR}"` },
    ...over,
  };
}
const plain = { colour: false, width: 100 };

describe('stripControl', () => {
  it('replaces C0 and C1 bytes but keeps tab, newline and carriage return', () => {
    expect(stripControl('a\u001bb\u0007c\u007fd\u0085e\tf\ng\rh')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\tf\ng\rh');
  });
});

describe('text renderer strips control bytes from every field', () => {
  it('message, remediation and sign-off command', () => {
    const out = renderText({ findings: [finding()], scanned: 1, ignoredFiles: 0 }, plain);
    expect(out).not.toContain(ESC);
    expect(out).toContain('�[2J');
    expect(out).toContain('forged clean verdict');
  });

  it('rule and file', () => {
    const out = renderText(
      { findings: [finding({ rule: `x${ESC}[31m`, file: `a${ESC}[2Jb.ts`, message: 'm', remediation: 'r', signoff: { required: false, command: '' } })], scanned: 1, ignoredFiles: 0 },
      plain,
    );
    expect(out).not.toContain(ESC);
  });

  it('with colour on, the only escapes are the renderer\'s own SGR sequences (control)', () => {
    const out = renderText({ findings: [finding()], scanned: 1, ignoredFiles: 0 }, { ...plain, colour: true });
    expect(out.replace(/\[[0-9;]*m/g, '')).not.toContain(ESC);
  });
});

describe('github renderer strips control bytes', () => {
  it('annotations', () => {
    for (const a of annotations([finding()])) expect(a).not.toContain(ESC);
    expect(annotations([finding()])[0]).toContain('forged clean verdict');
  });
  it('job summary cells', () => {
    expect(renderSummary({ findings: [finding()], scanned: 1, ignoredFiles: 0 }, {})).not.toContain(ESC);
  });
});

describe('the policy-diff reason is where the policy string enters a message', () => {
  it('an ignore glob carrying an escape sequence is quoted in the reason verbatim (so the renderer must strip it)', () => {
    const reasons = policyWeakening('version: 1\n', `version: 1\nignore: ["${CLEAR}"]\n`) ?? [];
    expect(reasons.some((r) => r.includes(ESC))).toBe(true);
  });
});
