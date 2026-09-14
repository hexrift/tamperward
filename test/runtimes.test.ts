// The runtime registry (src/runtimes.ts): detection of which agent runtime a
// repository hosts, and the honest steering-coverage wording onboarding shows.
// The contract under test: detection is marker-driven, priority-ordered, and
// never over-claims; the headline and caveat state the true reach of in-loop
// steering (Claude-only today) versus the agent-neutral layers.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWN_RUNTIMES,
  detectRuntimes,
  detectionHeadline,
  hasInLoopRuntime,
  neutralOnlyCaveat,
} from '../src/runtimes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(markers: Record<string, 'file' | 'dir'> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-runtimes-'));
  dirs.push(d);
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

describe('detectRuntimes', () => {
  it('detects nothing in a bare repository', () => {
    expect(detectRuntimes(repo())).toEqual([]);
  });

  it('detects Claude Code from .claude/settings.json and reports in-loop steering', () => {
    const found = detectRuntimes(repo({ '.claude/settings.json': 'file' }));
    expect(found.map((r) => r.id)).toEqual(['claude-code']);
    expect(found[0].steering).toBe('in-loop');
    expect(found[0].matchedMarker).toBe('.claude/settings.json');
  });

  it('detects Claude Code from a bare .claude directory too', () => {
    const found = detectRuntimes(repo({ '.claude': 'dir' }));
    expect(found.map((r) => r.id)).toEqual(['claude-code']);
  });

  it('detects Cursor and marks it neutral-only with adapter tracking', () => {
    const found = detectRuntimes(repo({ '.cursor': 'dir' }));
    expect(found.map((r) => r.id)).toEqual(['cursor']);
    expect(found[0].steering).toBe('neutral');
    expect(found[0].adapterTracking).toBe('#482');
  });

  it('detects Copilot from its instructions file, not a bare .github', () => {
    expect(detectRuntimes(repo({ '.github/workflows': 'dir' }))).toEqual([]);
    const found = detectRuntimes(repo({ '.github/copilot-instructions.md': 'file' }));
    expect(found.map((r) => r.id)).toEqual(['copilot']);
  });

  it('detects an AGENTS.md-aware agent from AGENTS.md', () => {
    const found = detectRuntimes(repo({ 'AGENTS.md': 'file' }));
    expect(found.map((r) => r.id)).toEqual(['codex']);
    expect(found[0].steering).toBe('neutral');
  });

  it('returns multiple runtimes in registry (priority) order, Claude first', () => {
    const found = detectRuntimes(repo({ '.cursor': 'dir', '.claude': 'dir', 'AGENTS.md': 'file' }));
    expect(found.map((r) => r.id)).toEqual(['claude-code', 'cursor', 'codex']);
  });

  it('does not count a dangling symlink marker as present', () => {
    const d = repo();
    symlinkSync(join(d, 'nowhere'), join(d, '.claude'));
    expect(detectRuntimes(d)).toEqual([]);
  });
});

describe('hasInLoopRuntime', () => {
  it('is true only when a shipped in-loop adapter runtime is present', () => {
    expect(hasInLoopRuntime(detectRuntimes(repo({ '.claude': 'dir' })))).toBe(true);
    expect(hasInLoopRuntime(detectRuntimes(repo({ '.cursor': 'dir' })))).toBe(false);
    expect(hasInLoopRuntime([])).toBe(false);
  });
});

describe('detectionHeadline', () => {
  it('states the neutral default when nothing is detected', () => {
    const h = detectionHeadline([]);
    expect(h).toContain('No agent runtime detected');
    expect(h).toContain('Claude Code in-loop steering');
    expect(h).toContain('any agent or human');
  });

  it('names a single detected runtime and its coverage', () => {
    expect(detectionHeadline(detectRuntimes(repo({ '.claude': 'dir' })))).toContain('Detected Claude Code');
    expect(detectionHeadline(detectRuntimes(repo({ '.cursor': 'dir' })))).toContain('Detected Cursor');
  });

  it('lists several detected runtimes with their coverage', () => {
    const h = detectionHeadline(detectRuntimes(repo({ '.claude': 'dir', '.cursor': 'dir' })));
    expect(h).toContain('2 agent runtimes');
    expect(h).toContain('Claude Code (in-loop)');
    expect(h).toContain('Cursor (neutral layers)');
  });
});

describe('neutralOnlyCaveat', () => {
  it('is null when Claude Code is present (in-loop already covers it)', () => {
    expect(neutralOnlyCaveat(detectRuntimes(repo({ '.claude': 'dir', '.cursor': 'dir' })))).toBeNull();
  });

  it('is null when nothing is detected (the headline already tells the truth)', () => {
    expect(neutralOnlyCaveat([])).toBeNull();
  });

  it('warns, for a neutral-only runtime, that in-loop is Claude-only and names the tracking issue', () => {
    const caveat = neutralOnlyCaveat(detectRuntimes(repo({ '.cursor': 'dir' })));
    expect(caveat).not.toBeNull();
    expect(caveat).toContain('Claude Code only');
    expect(caveat).toContain('Cursor');
    expect(caveat).toContain('pre-commit and CI');
    expect(caveat).toContain('#482');
  });
});

describe('KNOWN_RUNTIMES invariants', () => {
  it('has unique ids and non-empty markers, with Claude the only in-loop runtime today', () => {
    const ids = KNOWN_RUNTIMES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of KNOWN_RUNTIMES) expect(r.markers.length).toBeGreaterThan(0);
    expect(KNOWN_RUNTIMES.filter((r) => r.steering === 'in-loop').map((r) => r.id)).toEqual(['claude-code']);
  });

  it('tracks a native adapter issue for every neutral runtime', () => {
    for (const r of KNOWN_RUNTIMES.filter((r) => r.steering === 'neutral')) {
      expect(r.adapterTracking).toBeTruthy();
    }
  });
});
