import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('security documentation status (#311)', () => {
  it('binds the build spec to the shipped major/minor line', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const [major, minor] = pkg.version.split('.');
    const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');

    expect(spec).toContain(`**Implementation status:** TamperWard ${major}.${minor}.x`);
  });

  it('names the currently supported ecosystem surface instead of the old TS/Jest-only slice', () => {
    const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');
    for (const ecosystem of ['JavaScript/TypeScript', 'Python', 'Go', 'Rust', 'Ruby', 'JVM', 'PHP', '.NET']) {
      expect(spec).toContain(ecosystem);
    }
  });

  it('separates current residuals from historical closed/corrected findings', () => {
    const tracker = readFileSync(join(root, 'SECURITY-ENVELOPE.md'), 'utf8');

    expect(tracker).toContain('## Current open residuals');
    expect(tracker).toContain('## Historical findings — closed');
    expect(tracker).toContain('## Historical findings — withdrawn/corrected');
    expect(tracker).not.toContain('## Open — scoped, not yet closed');

    // Every current residual must point readers to the live threat-model/test
    // evidence rather than forcing them to infer status from historical rows.
    expect(tracker).toMatch(/checkpointed-local[\s\S]*THREAT-MODEL-pristine-run[\s\S]*verifier-container-e2e/);
    expect(tracker).toMatch(/suite-exit-only[\s\S]*THREAT-MODEL-pristine-run[\s\S]*verifier-container-e2e/);
    expect(tracker).toMatch(/verification surface[\s\S]*THREAT-MODEL-pristine-run/);
  });
});
