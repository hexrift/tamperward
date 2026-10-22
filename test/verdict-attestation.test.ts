import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseVerdictBinding, signVerdict, verifyVerdict, type VerdictBinding } from '../src/verdict-attestation';
import { guardedMain } from '../src/cli/main';

const now = Date.parse('2026-10-22T08:00:00.000Z');
const binding: VerdictBinding = { head: 'a'.repeat(40), base: 'b'.repeat(40), gate_version: '2.45.0', policy_hash: 'c'.repeat(64), verdict: 'VERIFIED', audience: 'hexrift/tamperward:merge', nonce: 'ci-run-42/attempt-1' };
const payload = () => ({ schema_version: 1, ...binding, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString() });
function keys() {
  return generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
}
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true }); });
describe('externally trusted verdict statements (#780)', () => {
  it('round-trips a fully bound statement deterministically across property order', () => {
    const key = keys();
    const signed = signVerdict(payload(), key.privateKey, now);
    const reordered = Object.fromEntries(Object.entries(payload()).reverse());
    expect(signVerdict(reordered, key.privateKey, now)).toEqual(signed);
    expect(verifyVerdict(signed, key.publicKey, binding, now)).toEqual(payload());
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(join(__dirname, '../schemas/signed-verdict-v1.schema.json'), 'utf8')));
    expect(validate(signed), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each(Object.keys(binding))('rejects a changed %s in the expected scope or signed payload', field => {
    const key = keys(), signed = signVerdict(payload(), key.privateKey, now);
    const replacement = field === 'head' ? 'd'.repeat(40) : field === 'base' ? 'e'.repeat(40) : field === 'policy_hash' ? 'f'.repeat(64) : field === 'gate_version' ? '2.45.1' : field === 'verdict' ? 'SUITE_RED' : 'different';
    expect(() => verifyVerdict(signed, key.publicKey, { ...binding, [field]: replacement }, now)).toThrow(/binding mismatch/);
    expect(() => verifyVerdict({ ...signed, statement: { ...signed.statement, [field]: replacement } }, key.publicKey, binding, now)).toThrow(/signature/);
  });
  it('rejects the wrong key, signature tampering and unsigned receipts', () => {
    const key = keys(), other = keys(), signed = signVerdict(payload(), key.privateKey, now);
    expect(() => verifyVerdict(signed, other.publicKey, binding, now)).toThrow(/untrusted/);
    expect(() => verifyVerdict({ ...signed, signature: 'A'.repeat(86) }, key.publicKey, binding, now)).toThrow(/signature/);
    expect(() => verifyVerdict(payload(), key.publicKey, binding, now)).toThrow();
    expect(() => verifyVerdict({ ...signed, algorithm: 'none' }, key.publicKey, binding, now)).toThrow();
    expect(() => verifyVerdict({ ...signed, signature: signed.signature + '=' }, key.publicKey, binding, now)).toThrow();
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(() => signVerdict(payload(), ec.privateKey, now)).toThrow(/Ed25519/);
  });
  it('fails closed on expiry, future issuance, invalid lifetime and timestamp tampering', () => {
    const key = keys(), signed = signVerdict(payload(), key.privateKey, now);
    expect(() => verifyVerdict(signed, key.publicKey, binding, now + 600_000)).toThrow(/validity/);
    expect(() => verifyVerdict(signed, key.publicKey, binding, now - 120_000)).toThrow(/validity/);
    expect(() => signVerdict({ ...payload(), expires_at: new Date(now + 86_400_001).toISOString() }, key.privateKey, now)).toThrow(/validity/);
    expect(() => verifyVerdict({ ...signed, statement: { ...signed.statement, expires_at: new Date(now + 600_001).toISOString() } }, key.publicKey, binding, now)).toThrow(/signature/);
  });
  it('requires every expected binding and rejects unknown fields rather than ignoring them', () => {
    const key = keys(), signed = signVerdict(payload(), key.privateKey, now);
    for (const field of Object.keys(binding)) {
      const expected: Record<string, unknown> = { ...binding }; delete expected[field];
      expect(() => verifyVerdict(signed, key.publicKey, expected, now)).toThrow();
    }
    expect(() => parseVerdictBinding({ ...binding, expires_at: payload().expires_at })).toThrow();
    expect(() => signVerdict({ ...payload(), authority: true }, key.privateKey, now)).toThrow();
    expect(() => verifyVerdict({ ...signed, extra: 'ignored?' }, key.publicKey, binding, now)).toThrow();
  });
  it('the CLI refuses missing signatures, claims or expected bindings, and never overwrites evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-attest-')); dirs.push(dir);
    const key = keys(), p = { ...payload(), issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() };
    const file = (name: string) => join(dir, name);
    writeFileSync(file('payload.json'), JSON.stringify(p)); writeFileSync(file('expected.json'), JSON.stringify(binding));
    writeFileSync(file('private.pem'), key.privateKey, { mode: 0o600 }); writeFileSync(file('public.pem'), key.publicKey);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true); vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const sign = ['attestation', 'sign', '--payload', file('payload.json'), '--key', file('private.pem'), '--out', file('statement.json')];
    expect(guardedMain(sign)).toBe(0);
    const bytes = readFileSync(file('statement.json'), 'utf8');
    expect(guardedMain(sign)).toBe(2); expect(readFileSync(file('statement.json'), 'utf8')).toBe(bytes);
    const verify = ['attestation', 'verify', '--statement', file('statement.json'), '--key', file('public.pem'), '--expect', file('expected.json')];
    expect(guardedMain(verify)).toBe(0);
    expect(guardedMain(verify.slice(0, -2))).toBe(2);
    expect(guardedMain([...verify, '--key', file('public.pem')])).toBe(2);
    writeFileSync(file('statement.json'), JSON.stringify(p)); expect(guardedMain(verify)).toBe(2);
    writeFileSync(file('statement.json'), 'x'.repeat(65537)); expect(guardedMain(verify)).toBe(2);
  });
});
