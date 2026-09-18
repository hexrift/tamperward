// #548: the release workflow's forward-version guard treated every `npm view`
// failure as an absent dist-tag (`|| true`), so a transient/5xx/auth/malformed
// registry lookup silently skipped the anti-downgrade comparison. The guard is
// now a small helper with three distinct outcomes — present / absent / failure —
// that fails the release on a lookup failure after bounded retries.
//
// These tests mock the registry (an injected `runNpm`) and NEVER publish.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — untyped .mjs helper, imported for behaviour like the codex-probe tests
import { classifyView, queryTag, forwardDecision, main } from '../.github/scripts/forward-guard.mjs';

const ok = (v: string) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
const emptyOk = () => ({ status: 0, stdout: '', stderr: '' });
const npmErr = (code: string) => ({ status: 1, stdout: '', stderr: JSON.stringify({ error: { code } }) });

describe('#548 forward-version guard — classifyView', () => {
  it('a valid version on stdout is present', () => {
    expect(classifyView(ok('2.30.5'))).toEqual({ kind: 'present', version: '2.30.5' });
  });
  it('exit 0 with empty stdout is an absent tag', () => {
    expect(classifyView(emptyOk())).toEqual({ kind: 'absent' });
  });
  it('a structured E404 is an absent tag', () => {
    expect(classifyView(npmErr('E404'))).toEqual({ kind: 'absent' });
  });
  it.each(['ETIMEDOUT', 'E500', 'E503', 'E401', 'E403', 'ENEEDAUTH', 'ECONNRESET'])(
    'a %s error is a lookup failure, not an absent tag',
    (code) => {
      expect(classifyView(npmErr(code)).kind).toBe('failure');
    },
  );
  it('a non-semver payload on a zero exit is a failure, not accepted as a version', () => {
    expect(classifyView({ status: 0, stdout: '"not-a-version"', stderr: '' }).kind).toBe('failure');
  });
});

describe('#548 forward-version guard — queryTag retries', () => {
  it('retries a transient failure then returns the recovered value', () => {
    const seq = [npmErr('ETIMEDOUT'), npmErr('E503'), ok('2.30.5')];
    let i = 0;
    const runNpm = () => seq[i++];
    expect(queryTag('latest', runNpm, { retries: 3, sleep: () => {} })).toEqual({ kind: 'present', version: '2.30.5' });
    expect(i).toBe(3);
  });
  it('gives up as a failure after the retry budget', () => {
    const runNpm = () => npmErr('ETIMEDOUT');
    const r = queryTag('latest', runNpm, { retries: 2, sleep: () => {} });
    expect(r.kind).toBe('failure');
  });
  it('does not retry a confirmed absent tag', () => {
    let calls = 0;
    const runNpm = () => { calls++; return npmErr('E404'); };
    expect(queryTag('latest', runNpm, { retries: 3, sleep: () => {} })).toEqual({ kind: 'absent' });
    expect(calls).toBe(1);
  });
});

describe('#548 forward-version guard — forwardDecision', () => {
  it('a higher stable version passes over the current latest', () => {
    expect(forwardDecision('2.30.6', { kind: 'present', version: '2.30.5' }, { kind: 'absent' }).ok).toBe(true);
  });
  it('an equal or lower stable version is refused as a downgrade', () => {
    const d = forwardDecision('2.30.5', { kind: 'present', version: '2.30.5' }, { kind: 'absent' });
    expect(d.ok).toBe(false);
    expect(d.fatal).toBeFalsy();
  });
  it('an absent latest follows the initial-publication path (ok)', () => {
    expect(forwardDecision('1.0.0', { kind: 'absent' }, { kind: 'absent' }).ok).toBe(true);
  });
  it('a lookup FAILURE for latest is fatal — never treated as absent', () => {
    const d = forwardDecision('2.30.6', { kind: 'failure', detail: 'ETIMEDOUT' }, { kind: 'absent' });
    expect(d.ok).toBe(false);
    expect(d.fatal).toBe(true);
  });
  it('a prerelease is compared against both latest and next', () => {
    // higher than latest but not above the current next rc -> refused
    const d = forwardDecision('2.31.0-rc.1', { kind: 'present', version: '2.30.5' }, { kind: 'present', version: '2.31.0-rc.2' });
    expect(d.ok).toBe(false);
  });
  it('a prerelease with a failed next lookup is fatal', () => {
    const d = forwardDecision('2.31.0-rc.3', { kind: 'present', version: '2.30.5' }, { kind: 'failure', detail: 'E503' });
    expect(d.ok).toBe(false);
    expect(d.fatal).toBe(true);
  });
  it('a stable release is not blocked by the next tag', () => {
    // next carries a higher 3.0 rc; a 2.x stable is still allowed to ship.
    expect(forwardDecision('2.30.6', { kind: 'present', version: '2.30.5' }, { kind: 'present', version: '3.0.0-rc.1' }).ok).toBe(true);
  });
});

describe('#548 forward-version guard — main (no publish, injected registry)', () => {
  it('stops the release when the latest lookup keeps failing', () => {
    const runNpm = () => npmErr('ETIMEDOUT');
    const d = main('2.30.6', { runNpm, retries: 1, sleep: () => {} });
    expect(d.ok).toBe(false);
    expect(d.fatal).toBe(true);
  });
  it('only queries next for a prerelease', () => {
    const tags: string[] = [];
    const runNpm = (tag: string) => { tags.push(tag); return ok('2.30.5'); };
    main('2.30.6', { runNpm, retries: 0, sleep: () => {} });
    expect(tags).toEqual(['latest']);
    tags.length = 0;
    main('2.31.0-rc.1', { runNpm, retries: 0, sleep: () => {} });
    expect(tags).toEqual(['latest', 'next']);
  });
});
