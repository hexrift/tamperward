import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, loadPolicyAt, PolicyError } from '../src/policy-load';
import { defaultPolicy } from '../src/policy';
import { runVerify } from '../src/cli/verify';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true }); });
function fixture(floor: unknown = { version: 2, rules: { 'assertion-weakening': { severity: 'block' } } }) {
  const root = mkdtempSync(join(tmpdir(), 'tw-floor-')); dirs.push(root);
  const cwd = join(root, 'repo'), file = join(root, 'floor.yml'); mkdirSync(cwd);
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'h'); git('config', 'user.email', 'h@x');
  writeFileSync(join(cwd, 'source.js'), 'module.exports = 42;\n'); git('add', '.'); git('commit', '-qm', 'seed');
  const source = JSON.stringify(floor);
  writeFileSync(file, source);
  const pin = createHash('sha256').update(source).digest('hex');
  vi.stubEnv('TAMPERWARD_POLICY_FLOOR', file); vi.stubEnv('TAMPERWARD_POLICY_FLOOR_SHA256', pin);
  const repository = (raw: unknown) => writeFileSync(join(cwd, '.tamperward.yml'), JSON.stringify(raw));
  return { cwd, file, pin, git, repository };
}
describe('operator-pinned organisation policy floor (#781)', () => {
  it('inherits the baseline with no repository policy, including trusted-revision fallback', () => {
    const f = fixture();
    expect(loadPolicy(f.cwd)).toMatchObject({ version: 2, organizationFloor: { sha256: f.pin }, rules: { 'assertion-weakening': { severity: 'block' } } });
    expect(loadPolicyAt('HEAD', f.cwd)).toEqual(loadPolicy(f.cwd));
    f.repository({ rules: { 'guard-removal': { severity: 'block' } } });
    expect(loadPolicy(f.cwd).rules['guard-removal'].severity).toBe('block');
    expect(loadPolicy(f.cwd).version).toBe(2);
    mkdirSync(join(f.cwd, 'sub')); expect(loadPolicy(join(f.cwd, 'sub'))).toEqual(loadPolicy(f.cwd));
  });
  it.each([
    { version: 1 },
    { rules: { 'assertion-weakening': { severity: 'warn' } } },
    { rules: { 'assertion-weakening': { enabled: false } } },
    { rules: { 'test-skip': { exclude: ['**'] } } },
    { ignore: ['**'] },
    { protected: { tests: [] } },
    { protected: { tests: ['src/**'] } },
    { protected: { custom: ['src/**'] } },
    { signoff: { required_for: [] } },
    { signoff: { ledger: 'other-ledger.jsonl' } },
  ])('rejects weakening or unsupported classification change: %j', raw => {
    const f = fixture(); f.repository(raw); expect(() => loadPolicy(f.cwd)).toThrow(PolicyError);
  });
  it('permits stricter literal exclusions/ignore and preserves exact protected sets', () => {
    const f = fixture({ version: 1, ignore: ['docs/**'], rules: { 'test-skip': { exclude: ['fixtures/**'] } } });
    f.repository({ ignore: [], rules: { 'test-skip': { exclude: [] } }, protected: { tests: defaultPolicy().protected.tests } });
    expect(loadPolicy(f.cwd).ignore).toEqual([]);
    expect(loadPolicy(f.cwd).rules['test-skip'].exclude).toEqual([]);
  });
  it.each([
    { verify: { command: 'true' } },
    { verify: { command: 'node test/check.cjs', budget: 1 } },
    { verify: { command: 'node test/check.cjs', inputs: [] } },
    { verify: { command: 'node test/check.cjs', inputs: ['runner.cjs', 'source.js'] } },
    { verify: { command: 'node test/check.cjs', backend: 'container', image: 'registry.invalid/test@sha256:' + 'a'.repeat(64) } },
  ])('refuses verifier substitutions or scope changes: %j', raw => {
    const f = fixture({ version: 1, verify: { command: 'node test/check.cjs', budget: 10, inputs: ['runner.cjs'] } });
    f.repository(raw); expect(() => loadPolicy(f.cwd)).toThrow(PolicyError);
  });
  it('allows a larger verification budget but refuses weakening CLI flags', () => {
    const f = fixture({ version: 1, verify: { command: 'node test/check.cjs', budget: 10 } });
    f.repository({ verify: { command: 'node test/check.cjs', budget: 15 } }); expect(loadPolicy(f.cwd).verify?.budget).toBe(15);
    expect(runVerify({ cwd: f.cwd, silent: true, cmd: 'true' })).toBe(2);
    expect(runVerify({ cwd: f.cwd, silent: true, budget: 1 })).toBe(2);
  });
  it('enforces the floor against the trusted revision, not an uncommitted candidate overlay', () => {
    const f = fixture(); f.repository({ version: 2 }); f.git('add', '.'); f.git('commit', '-qm', 'policy');
    f.repository({ rules: { 'test-skip': { enabled: false } } });
    expect(() => loadPolicy(f.cwd)).toThrow();
    expect(loadPolicyAt('HEAD', f.cwd)?.rules['test-skip'].enabled).not.toBe(false);
  });
  it('refuses changed bytes, a missing pin, unavailable baseline and unknown baseline rules', () => {
    const f = fixture(); writeFileSync(f.file, 'version: 1\n'); expect(() => loadPolicy(f.cwd)).toThrow(/pin mismatch/);
    vi.stubEnv('TAMPERWARD_POLICY_FLOOR_SHA256', ''); expect(() => loadPolicy(f.cwd)).toThrow(/requires/);
    vi.stubEnv('TAMPERWARD_POLICY_FLOOR_SHA256', f.pin); vi.stubEnv('TAMPERWARD_POLICY_FLOOR', join(f.cwd, 'absent.yml')); expect(() => loadPolicyAt('HEAD', f.cwd)).toThrow(PolicyError);
    const unknown = fixture({ rules: { 'future-required-rule': { severity: 'block' } } }); expect(() => loadPolicy(unknown.cwd)).toThrow(/understood/);
  });
  it.each(['constructor', '__proto__', 'toString'])('does not mistake prototype member %s for an enforced floor rule', name => {
    const f = fixture({ rules: Object.fromEntries([[name, { severity: 'block' }]]) });
    expect(() => loadPolicy(f.cwd)).toThrow(/understood/);
  });
  it('refuses an in-repository baseline and a symlink to an external baseline', () => {
    const f = fixture(); const inside = join(f.cwd, 'baseline.yml'); writeFileSync(inside, '{}');
    vi.stubEnv('TAMPERWARD_POLICY_FLOOR', inside); expect(() => loadPolicy(f.cwd)).toThrow(/outside/);
    if (process.platform !== 'win32') {
      const link = join(f.cwd, '..', 'link.yml'); symlinkSync(f.file, link); vi.stubEnv('TAMPERWARD_POLICY_FLOOR', link); expect(() => loadPolicy(f.cwd)).toThrow(/regular/);
    }
  });
  it('preserves ordinary repository policy behavior when not opted in', () => {
    const f = fixture(); vi.stubEnv('TAMPERWARD_POLICY_FLOOR', undefined); vi.stubEnv('TAMPERWARD_POLICY_FLOOR_SHA256', undefined);
    f.repository({ rules: { 'test-skip': { enabled: false } } }); expect(loadPolicy(f.cwd).rules['test-skip'].enabled).toBe(false);
    expect(loadPolicy(f.cwd)).not.toHaveProperty('organizationFloor');
  });
});
