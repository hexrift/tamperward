import { describe, expect, it } from 'vitest';
import { declaredImageVolumePaths } from '../src/verifier-backend';

describe('isolated verifier image authority (#347)', () => {
  it('rejects image-declared writable volume paths from trusted image metadata', () => {
    expect(declaredImageVolumePaths({ Config: { Volumes: null } })).toEqual([]);
    expect(declaredImageVolumePaths({ Config: {} })).toEqual([]);
    expect(
      declaredImageVolumePaths({
        Config: {
          Volumes: {
            '/trusted-deps': {},
            '/var/lib/cache': {},
          },
        },
      }),
    ).toEqual(['/trusted-deps', '/var/lib/cache']);
  });

  it('fails closed on malformed image metadata rather than assuming there are no volumes', () => {
    expect(() => declaredImageVolumePaths(null)).toThrow(/image metadata/i);
    expect(() => declaredImageVolumePaths({ Config: { Volumes: [] } })).toThrow(/volume/i);
  });
});
