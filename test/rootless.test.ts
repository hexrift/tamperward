// #392: the suite must not fail opaquely when it runs as root. `tamperward run` refuses
// Linux root/euid 0 by design (same-UID lifecycle separation cannot trust any system
// interpreter path), so every test that needs the envelope to reach adjudication has to
// skip with a reason instead of failing on a bare exit-code mismatch. The identity is
// injected here so the contract is provable from an ordinary unprivileged run.

import { describe, expect, it } from 'vitest';
import { announceRootRun, currentIdentity, envelopeRefusal, rootRunNotice, rootless } from './rootless';

const linuxRoot = { platform: 'linux', euid: 0 } as const;

describe('envelopeRefusal: only Linux root/euid 0 is refused', () => {
  it('names the refusal for Linux euid 0', () => {
    expect(envelopeRefusal(linuxRoot)).toMatch(/root\/euid 0/);
    expect(envelopeRefusal(linuxRoot)).toMatch(/same-UID/);
  });

  it('is null for an unprivileged Linux user', () => {
    expect(envelopeRefusal({ platform: 'linux', euid: 1000 })).toBeNull();
  });

  it('is null off Linux even at euid 0 — those platforms carry their own guards', () => {
    expect(envelopeRefusal({ platform: 'darwin', euid: 0 })).toBeNull();
    expect(envelopeRefusal({ platform: 'win32', euid: null })).toBeNull();
  });

  it('currentIdentity reads the real process and `rootless` is derived from it', () => {
    const id = currentIdentity();
    expect(id.platform).toBe(process.platform);
    expect(id.euid).toBe(typeof process.geteuid === 'function' ? process.geteuid() : null);
    expect(rootless).toBe(envelopeRefusal(id) === null);
  });
});

describe('rootRunNotice: one actionable message at suite start', () => {
  it('says why the envelope refuses root and how to run the suite unprivileged', () => {
    const notice = rootRunNotice(linuxRoot);
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/running as root \(euid 0\)/);
    expect(notice).toMatch(/refuses (Linux )?root/);
    expect(notice).toMatch(/skipped, not failed/);
    expect(notice).toMatch(/unprivileged user/);
    expect(notice).toMatch(/CONTRIBUTING\.md/);
    expect(notice).toMatch(/sudo -u/);
  });

  it('is silent for every identity the envelope accepts', () => {
    expect(rootRunNotice({ platform: 'linux', euid: 1000 })).toBeNull();
    expect(rootRunNotice({ platform: 'darwin', euid: 0 })).toBeNull();
    expect(rootRunNotice({ platform: 'win32', euid: null })).toBeNull();
  });
});

describe('announceRootRun: the global-setup hook', () => {
  it('writes the notice exactly once, newline-terminated, and reports that it did', () => {
    const lines: string[] = [];
    expect(announceRootRun((s) => { lines.push(s); }, linuxRoot)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(lines[0]).toBe(`${rootRunNotice(linuxRoot)}\n`);
  });

  it('writes nothing for an unprivileged run, so CI output is unchanged', () => {
    const lines: string[] = [];
    expect(announceRootRun((s) => { lines.push(s); }, { platform: 'linux', euid: 1000 })).toBe(false);
    expect(lines).toEqual([]);
  });
});
