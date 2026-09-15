// Which agent runtime(s) a repository hosts, and what TamperWard steering each gets.
//
// TamperWard's enforcement is layered, and the layers do not all reach every
// agent the same way:
//
//  - The AGENT-NEUTRAL layers — the pre-commit hook, the CI gate, and the
//    `tamperward run` envelope — protect ANY agent and ANY human, because they
//    judge the committed or candidate tree rather than intercepting a tool call.
//  - The IN-LOOP steering layer (PreToolUse deny + Stop sweep) is runtime-
//    specific: it needs an adapter that speaks the runtime's own hook wire. Today
//    only Claude Code has a shipped adapter (src/adapters/claude); the neutral
//    RuntimeAdapter contract (src/adapters/contract.ts, #482) is the seam a
//    second runtime plugs into.
//
// This registry lets `onboard`/`init` tell the operator WHICH runtime their
// repository is set up for and WHAT protection it actually gets today, instead of
// silently assuming Claude. It is detection and honest reporting ONLY: it writes
// nothing, adjudicates nothing, and opens no verdict path. Detection is a
// convenience for the setup narrative — never a security boundary, because the
// marker files it reads are candidate-controlled.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How far TamperWard's steering reaches for a given runtime TODAY.
 *
 *  - `in-loop`  — a shipped adapter delivers synchronous PreToolUse deny + the
 *                 end-of-turn sweep, on top of the neutral layers.
 *  - `neutral`  — no in-loop adapter yet; the runtime is protected by the
 *                 agent-neutral layers (pre-commit + CI + envelope) only. A
 *                 native adapter is tracked, not shipped.
 */
export type RuntimeSteering = 'in-loop' | 'neutral';

export interface RuntimeDescriptor {
  /** Stable id. Matches the shipped adapter name where one exists (`claude-code`). */
  id: string;
  /** Human-readable name for the onboarding narrative. */
  label: string;
  /**
   * Repository-relative paths whose presence signals this runtime is in use.
   * Any one match is enough. These are candidate-controlled hints for the setup
   * story, never a trust input. A marker must be a file TamperWard's own `init`
   * never writes — otherwise a repository would detect the runtime purely from
   * the wiring TamperWard installed for it (#526).
   */
  markers: readonly string[];
  /**
   * An optional second evidence pass for a runtime whose in-loop wiring TamperWard
   * itself installs (Claude Code). It looks past the generated hook file for real
   * use — e.g. a `.claude/settings.json` carrying configuration beyond the two
   * hooks `init` merges in. Returns the concrete marker to cite, or null. Run only
   * after `markers` miss, so a genuine marker still wins the narrative.
   */
  detectExtra?: (cwd: string) => string | null;
  /** How far in-loop steering reaches for this runtime today. */
  steering: RuntimeSteering;
  /** Issue tracking the native in-loop adapter, for a `neutral` runtime. */
  adapterTracking?: string;
  /** One line on what this runtime gets, shown after detection. */
  note: string;
}

/** Minimal object guard, kept local so this module stays dependency-light. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Whether a `hooks` block carries any entry TamperWard's `init` did not write.
 * `init` merges exactly its two hooks — a PreToolUse deny and a Stop sweep, each a
 * `tamperward` command. A hook command without `tamperward`, or a whole event init
 * never touches, is a human's own Claude hook and counts as genuine use. The match
 * is deliberately loose: detection is a narrative convenience, never a trust input.
 */
function hooksBeyondTamperward(hooks: unknown): boolean {
  if (!isRecord(hooks)) return hooks != null; // a non-object `hooks` is not what init writes
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) {
      if (entries != null) return true;
      continue;
    }
    for (const entry of entries) {
      const hs = isRecord(entry) ? entry.hooks : null;
      if (!Array.isArray(hs)) {
        if (hs != null) return true;
        continue;
      }
      for (const h of hs) {
        const cmd = isRecord(h) ? String(h.command ?? '') : '';
        if (!/tamperward/.test(cmd)) return true; // a hook init did not write
      }
    }
  }
  return false;
}

/**
 * Whether `.claude/settings.json` holds Claude configuration BEYOND the wiring
 * TamperWard's own `init` merges in (its two hooks plus `disableAllHooks: false`).
 * `init` writes this file for EVERY runtime, so its bare presence is not evidence a
 * human runs Claude Code here (#526). Any other top-level key, or a hook command
 * that is not TamperWard's, is real use. A non-empty file that is not the valid
 * JSON `init` writes is a human's own (if malformed) settings and counts as use; an
 * empty or unreadable file does not, so detection never over-claims.
 */
function claudeSettingsBeyondTamperward(cwd: string): boolean {
  const path = join(cwd, '.claude', 'settings.json');
  let raw: string;
  try {
    if (!existsSync(path)) return false;
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.trim().length > 0; // non-empty but not the JSON init writes: a human's file
  }
  if (!isRecord(parsed)) return raw.trim().length > 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'disableAllHooks') continue; // init declares exactly this key
    if (key === 'hooks') {
      if (hooksBeyondTamperward(value)) return true;
      continue;
    }
    return true; // any other top-level Claude setting (env, permissions, model, …)
  }
  return false;
}

/**
 * The runtimes TamperWard recognises. Order is priority order: when several
 * markers are present, the first listed is treated as the primary runtime for
 * headline messaging. Claude Code leads because it is the one with in-loop
 * steering today.
 *
 * `markers` deliberately favours runtime-specific files. `.github/` alone is not
 * a Copilot signal (almost every repository has one); the Copilot INSTRUCTIONS
 * file is. `AGENTS.md` is a cross-tool convention rather than proof of Codex, so
 * it is a weak signal listed last and never claims more than "an AGENTS.md-aware
 * agent". Claude Code is the one runtime TamperWard wires for, so its markers are
 * files `init` never writes and its generated hook file is judged by content, not
 * mere presence (#526) — otherwise every onboarded repository would report Claude.
 */
export const KNOWN_RUNTIMES: readonly RuntimeDescriptor[] = [
  {
    id: 'claude-code',
    // Markers are Claude Code files `init` never writes, so detection never mistakes
    // TamperWard's own generated `.claude/settings.json` for evidence a human runs
    // Claude here (#526). `detectExtra` looks at that generated file's CONTENT for
    // real use (configuration beyond the two hooks init merges in).
    label: 'Claude Code',
    markers: ['CLAUDE.md', '.claude/settings.local.json', '.claude/commands', '.claude/agents'],
    detectExtra: (cwd) => (claudeSettingsBeyondTamperward(cwd) ? '.claude/settings.json' : null),
    steering: 'in-loop',
    note: 'native in-loop steering (PreToolUse deny + Stop sweep) plus the agent-neutral layers.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    markers: ['.cursor', '.cursorrules'],
    steering: 'neutral',
    adapterTracking: '#482',
    note: 'agent-neutral layers (pre-commit + CI) today; a native in-loop adapter is tracked in #482.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    markers: ['.github/copilot-instructions.md', '.github/copilot'],
    steering: 'neutral',
    adapterTracking: '#482',
    note: 'agent-neutral layers (pre-commit + CI) today; a native in-loop adapter is tracked in #482.',
  },
  {
    id: 'codex',
    label: 'an AGENTS.md-aware agent (e.g. Codex)',
    markers: ['.codex', 'AGENTS.md'],
    steering: 'neutral',
    adapterTracking: '#482',
    note: 'agent-neutral layers (pre-commit + CI) today; a native in-loop adapter is tracked in #482.',
  },
] as const;

export interface DetectedRuntime extends RuntimeDescriptor {
  /** The first marker that matched, so the narrative can point at concrete evidence. */
  matchedMarker: string;
}

/**
 * Which known runtimes have a marker present under `cwd`, in registry (priority)
 * order. A marker that is a broken symlink or otherwise unreadable does not
 * count as present; `existsSync` follows symlinks and returns false for a
 * dangling one, which is the conservative answer for a hint that must never
 * over-claim. Detection is best-effort and non-fatal by construction.
 */
export function detectRuntimes(cwd: string): DetectedRuntime[] {
  const found: DetectedRuntime[] = [];
  for (const rt of KNOWN_RUNTIMES) {
    const marker = rt.markers.find((m) => {
      try {
        return existsSync(join(cwd, m));
      } catch {
        return false;
      }
    });
    // A genuine marker wins the narrative; only when none is present does the
    // content-aware second pass (Claude Code's generated-file check) run.
    const matchedMarker = marker ?? rt.detectExtra?.(cwd) ?? undefined;
    if (matchedMarker !== undefined) found.push({ ...rt, matchedMarker });
  }
  return found;
}

/** True iff at least one detected runtime has a shipped in-loop adapter. */
export function hasInLoopRuntime(detected: readonly DetectedRuntime[]): boolean {
  return detected.some((r) => r.steering === 'in-loop');
}

/**
 * The one-line headline for the detection step. Pure string assembly so the
 * onboarding renderer and any test share a single source of wording.
 *
 *  - nothing detected → the neutral truth: TamperWard wires Claude in-loop
 *    steering (the only adapter today) and the neutral layers that cover any agent.
 *  - a single runtime → name it and what it gets.
 *  - several → list them with their coverage, primary first.
 */
export function detectionHeadline(detected: readonly DetectedRuntime[]): string {
  if (detected.length === 0) {
    return 'No agent runtime detected. Wiring Claude Code in-loop steering plus the agent-neutral layers (pre-commit + CI) that protect any agent or human.';
  }
  if (detected.length === 1) {
    const r = detected[0];
    return `Detected ${r.label} — ${r.note}`;
  }
  const parts = detected.map((r) => `${r.label} (${r.steering === 'in-loop' ? 'in-loop' : 'neutral layers'})`);
  return `Detected ${detected.length} agent runtimes: ${parts.join(', ')}.`;
}

/**
 * The honesty note printed for every detected runtime that lacks a shipped in-loop
 * adapter. It states plainly that the in-loop layer is Claude-only today and that
 * the neutral layers (pre-commit + CI) are the live protection for those runtimes.
 * The note is preserved even when Claude Code is ALSO present (#526): a repository
 * that runs both Claude and, say, Cursor still needs to hear that its Cursor work
 * gets only the neutral layers. Only the trailing clause differs — when Claude is
 * not among the detected runtimes, it adds that the Claude hook wiring `init` still
 * writes is inert unless Claude Code runs here. Returns null when nothing is
 * detected, or when every detected runtime already has in-loop steering — the
 * headline already tells the truth there.
 */
export function neutralOnlyCaveat(detected: readonly DetectedRuntime[]): string | null {
  const neutral = detected.filter((r) => r.steering === 'neutral');
  if (neutral.length === 0) return null;
  const names = neutral.map((r) => r.label).join(', ');
  const tracking = [...new Set(neutral.map((r) => r.adapterTracking).filter(Boolean))].join(', ');
  const claudeAlso = hasInLoopRuntime(detected);
  const lead = claudeAlso
    ? `In-loop steering (deny-before-execute) ships for Claude Code only today: Claude Code here gets it, but on ${names} your live protection is `
    : `In-loop steering (deny-before-execute) ships for Claude Code only today, so on ${names} your live protection is `;
  const tail = claudeAlso
    ? ''
    : ' The Claude hook wiring is still written and is inert unless Claude Code runs in this repository.';
  return `${lead}the agent-neutral layers: pre-commit and CI.${tail}${tracking ? ` A native in-loop adapter is tracked in ${tracking}.` : ''}`;
}
