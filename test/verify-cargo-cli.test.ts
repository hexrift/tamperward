import { expect, it } from 'vitest';
import { validateCliArgs } from '../src/cli/main';

it('accepts the cache option through the public verify command grammar', () => {
  expect(validateCliArgs('verify', ['--base', 'HEAD', '--cargo-target-root', '/tmp/operator-cache', '--json'])).toBeUndefined();
  expect(validateCliArgs('verify', ['--cargo-target-root'])).toMatch(/needs a value/);
});
