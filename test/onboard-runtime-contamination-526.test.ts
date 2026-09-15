// #526: onboarding wrote `.claude/settings.json` for every runtime, and detection
// then counted that self-written file as Claude usage — so a Cursor-only repository
// reported "Claude Code (in-loop), Cursor (neutral)" on the next run and the neutral
// caveat vanished. This spans the real cycle the bug lived in: detect → canonical
// init → detect, against the file `init` actually writes (not a handcrafted marker).

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit } from '../src/cli/init';
import { detectRuntimes, neutralOnlyCaveat } from '../src/runtimes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(markers: Record<string, 'file' | 'dir'>): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-onboard-526-'));
  dirs.push(d);
  mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  for (const [rel, kind] of Object.entries(markers)) {
    const p = join(d, rel);
    if (kind === 'dir') mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, '');
    }
  }
  return d;
}

// The canonical onboarding writes: applies every planInit action, including the
// `.claude/settings.json` hook merge.
const onboard = (d: string): void => {
  for (const a of planInit(d)) a.apply?.();
};
const ids = (d: string): string[] => detectRuntimes(d).map((r) => r.id);

describe('onboarding does not contaminate runtime detection (#526)', () => {
  const neutralCases: Array<[string, string, Record<string, 'file' | 'dir'>]> = [
    ['Cursor', 'cursor', { '.cursor': 'dir' }],
    ['an AGENTS.md agent', 'codex', { 'AGENTS.md': 'file' }],
    ['Copilot', 'copilot', { '.github/copilot-instructions.md': 'file' }],
  ];

  for (const [label, id, markers] of neutralCases) {
    it(`a ${label}-only repo stays ${label}-only across two onboarding passes`, () => {
      const d = repo(markers);

      // 1. Before onboarding: exactly the one neutral runtime, with its caveat.
      expect(ids(d)).toEqual([id]);
      expect(neutralOnlyCaveat(detectRuntimes(d))).not.toBeNull();

      // 2. Canonical onboarding writes .claude/settings.json for every runtime.
      onboard(d);
      expect(existsSync(join(d, '.claude/settings.json'))).toBe(true);

      // 3. Detect again: no phantom Claude Code runtime, caveat preserved.
      expect(ids(d)).toEqual([id]);
      const caveat = neutralOnlyCaveat(detectRuntimes(d));
      expect(caveat).not.toBeNull();
      expect(caveat).toContain('inert unless Claude Code');

      // 4. A second onboarding pass (detection now runs against files already
      //    written by the first) still invents nothing.
      onboard(d);
      expect(ids(d)).toEqual([id]);
    });
  }

  it('a genuine Claude + Cursor repo reports both and keeps the Cursor coverage note', () => {
    const d = repo({ '.cursor': 'dir', 'CLAUDE.md': 'file' });
    expect(ids(d)).toEqual(['claude-code', 'cursor']);

    onboard(d);
    expect(ids(d)).toEqual(['claude-code', 'cursor']);

    const caveat = neutralOnlyCaveat(detectRuntimes(d));
    expect(caveat).not.toBeNull();
    expect(caveat).toContain('Cursor');
    // Claude Code genuinely runs here, so the "hooks are inert" clause must not show.
    expect(caveat).not.toContain('inert unless Claude Code');
  });
});
