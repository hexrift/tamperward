import { describe, expect, it } from 'vitest';
import { parsePolicy, PolicyError } from '../src/policy-load';
import { policyWeakening } from '../src/detectors/policy-diff';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const IMAGE = 'ghcr.io/example/tamperward-verifier@' + DIGEST;

describe('isolated verifier policy', () => {
  it('accepts a digest-pinned container backend from trusted policy', () => {
    const p = parsePolicy({
      verify: {
        command: 'sh test/check.sh',
        budget: 60,
        backend: 'container',
        image: IMAGE,
      },
    } as any);

    expect(p.verify).toMatchObject({
      command: 'sh test/check.sh',
      budget: 60,
      backend: 'container',
      image: IMAGE,
    });
  });

  it('rejects an unpinned/mutable container image reference', () => {
    expect(() =>
      parsePolicy({
        verify: {
          command: 'sh test/check.sh',
          budget: 60,
          backend: 'container',
          image: 'ghcr.io/example/tamperward-verifier:latest',
        },
      } as any),
    ).toThrow(PolicyError);
  });

  it('requires an image for the container backend', () => {
    expect(() =>
      parsePolicy({
        verify: {
          command: 'sh test/check.sh',
          budget: 60,
          backend: 'container',
        },
      } as any),
    ).toThrow(PolicyError);
  });

  it('treats weakening isolated -> local and changing the pinned verifier image as policy weakening', () => {
    const before =
      'verify:\n' +
      '  command: sh test/check.sh\n' +
      '  budget: 60\n' +
      '  backend: container\n' +
      `  image: ${IMAGE}\n`;

    const local =
      'verify:\n' +
      '  command: sh test/check.sh\n' +
      '  budget: 60\n' +
      '  backend: local\n';

    const other =
      'verify:\n' +
      '  command: sh test/check.sh\n' +
      '  budget: 60\n' +
      '  backend: container\n' +
      `  image: ghcr.io/example/tamperward-verifier@sha256:${'b'.repeat(64)}\n`;

    expect(policyWeakening(before, local)?.join('\n')).toMatch(/backend|container|local/i);
    expect(policyWeakening(before, other)?.join('\n')).toMatch(/image|verifier/i);
  });
});
