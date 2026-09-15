// The runtime registry (src/runtimes.ts): detection of which agent runtime a
// repository hosts, and the honest steering-coverage wording onboarding shows.
// The contract under test: detection is marker-driven, priority-ordered, and
// never over-claims; crucially, TamperWard's own generated `.claude/settings.json`
// is NOT by itself evidence a human runs Claude here (#526); the headline and
// caveat state the true reach of in-loop steering (Claude-only today) versus the
// agent-neutral layers, and the caveat is preserved for a neutral runtime even
// when Claude Code is also present.

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

type Marker = 'file' | 'dir' | { content: string };
function repo(markers: Record<string, Marker> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-runtimes-'));
  dirs.push(d);
  for (const [rel, kind] of Object.entries(markers)) {
    const p = join(d, rel);
    if (kind === 'dir') mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, typeof kind === 'object' ? kind.content : '');
    }
  }
  return d;
}

// A `.claude/settings.json` exactly as `init` writes it: only its two hooks and the
// `disableAllHooks: false` declaration. Its presence must NOT establish Claude use.
const TW_ONLY_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'npx --yes tamperward@2.29.12 hook claude' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'npx --yes tamperward@2.29.12 sweep claude' }] }],
  },
  disableAllHooks: false,
});

describe('detectRuntimes', () => {
  it('detects nothing in a bare repository', () => {
    expect(detectRuntimes(repo())).toEqual([]);
  });

  it('detects Claude Code from a genuine settings.json (config beyond TamperWard hooks)', () => {
    const found = detectRuntimes(repo({ '.claude/settings.json': { content: JSON.stringify({ model: 'opus' }) } }));
    expect(found.map((r) => r.id)).toEqual(['claude-code']);
    expect(found[0].steering).toBe('in-loop');
    expect(found[0].matchedMarker).toBe('.claude/settings.json');
  });

  it('detects Claude Code from a settings.json carrying a non-TamperWard hook', () => {
    const settings = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    const found = detectRuntimes(repo({ '.claude/settings.json': { content: JSON.stringify(settings) } }));
    expect(found.map((r) => r.id)).toEqual(['claude-code']);
  });

  it('detects Claude Code from CLAUDE.md and from .claude/commands', () => {
    expect(detectRuntimes(repo({ 'CLAUDE.md': 'file' })).map((r) => r.id)).toEqual(['claude-code']);
    expect(detectRuntimes(repo({ '.claude/commands': 'dir' })).map((r) => r.id)).toEqual(['claude-code']);
  });

  it('does NOT invent Claude Code from a TamperWard-only settings.json (#526)', () => {
    expect(detectRuntimes(repo({ '.claude/settings.json': { content: TW_ONLY_SETTINGS } }))).toEqual([]);
  });

  it('does NOT invent Claude Code from a bare .claude directory (#526)', () => {
    // `init` creates `.claude/` to hold the settings it writes; a bare directory is
    // not evidence a human runs Claude here.
    expect(detectRuntimes(repo({ '.claude': 'dir' }))).toEqual([]);
    expect(detectRuntimes(repo({ '.claude/settings.json': 'file' }))).toEqual([]); // empty file
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
    const found = detectRuntimes(repo({ '.cursor': 'dir', 'CLAUDE.md': 'file', 'AGENTS.md': 'file' }));
    expect(found.map((r) => r.id)).toEqual(['claude-code', 'cursor', 'codex']);
  });

  it('a genuine marker wins over the generated-file check for the cited evidence', () => {
    const found = detectRuntimes(repo({ 'CLAUDE.md': 'file', '.claude/settings.json': { content: JSON.stringify({ model: 'opus' }) } }));
    expect(found.map((r) => r.id)).toEqual(['claude-code']);
    expect(found[0].matchedMarker).toBe('CLAUDE.md');
  });

  it('does not count a dangling symlink marker as present', () => {
    const d = repo();
    symlinkSync(join(d, 'nowhere'), join(d, 'CLAUDE.md'));
    expect(detectRuntimes(d)).toEqual([]);
  });
});

describe('hasInLoopRuntime', () => {
  it('is true only when a shipped in-loop adapter runtime is present', () => {
    expect(hasInLoopRuntime(detectRuntimes(repo({ 'CLAUDE.md': 'file' })))).toBe(true);
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
    expect(detectionHeadline(detectRuntimes(repo({ 'CLAUDE.md': 'file' })))).toContain('Detected Claude Code');
    expect(detectionHeadline(detectRuntimes(repo({ '.cursor': 'dir' })))).toContain('Detected Cursor');
  });

  it('lists several detected runtimes with their coverage', () => {
    const h = detectionHeadline(detectRuntimes(repo({ 'CLAUDE.md': 'file', '.cursor': 'dir' })));
    expect(h).toContain('2 agent runtimes');
    expect(h).toContain('Claude Code (in-loop)');
    expect(h).toContain('Cursor (neutral layers)');
  });
});

describe('neutralOnlyCaveat', () => {
  it('warns, for a neutral-only runtime, that in-loop is Claude-only and names the tracking issue', () => {
    const caveat = neutralOnlyCaveat(detectRuntimes(repo({ '.cursor': 'dir' })));
    expect(caveat).not.toBeNull();
    expect(caveat).toContain('Claude Code only');
    expect(caveat).toContain('Cursor');
    expect(caveat).toContain('pre-commit and CI');
    expect(caveat).toContain('#482');
    expect(caveat).toContain('inert unless Claude Code');
  });

  it('preserves the neutral-runtime coverage note even when Claude Code is also present (#526)', () => {
    const caveat = neutralOnlyCaveat(detectRuntimes(repo({ 'CLAUDE.md': 'file', '.cursor': 'dir' })));
    expect(caveat).not.toBeNull();
    expect(caveat).toContain('Claude Code only');
    expect(caveat).toContain('Cursor');
    expect(caveat).toContain('pre-commit and CI');
    // Claude genuinely runs here, so the "hooks are inert" clause must NOT appear.
    expect(caveat).not.toContain('inert unless Claude Code');
  });

  it('is null when nothing is detected (the headline already tells the truth)', () => {
    expect(neutralOnlyCaveat([])).toBeNull();
  });

  it('is null when only an in-loop runtime is detected', () => {
    expect(neutralOnlyCaveat(detectRuntimes(repo({ 'CLAUDE.md': 'file' })))).toBeNull();
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

  it('never uses a file `init` writes as a Claude marker — else onboarding self-detects (#526)', () => {
    const claude = KNOWN_RUNTIMES.find((r) => r.id === 'claude-code');
    expect(claude).toBeDefined();
    // `.claude/settings.json` and a bare `.claude` are what `init` creates; they must
    // reach detection only through the content-aware `detectExtra`, never as markers.
    expect(claude?.markers).not.toContain('.claude/settings.json');
    expect(claude?.markers).not.toContain('.claude');
    expect(typeof claude?.detectExtra).toBe('function');
  });
});
