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

import { existsSync } from 'node:fs';
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
   * story, never a trust input.
   */
  markers: readonly string[];
  /** How far in-loop steering reaches for this runtime today. */
  steering: RuntimeSteering;
  /** Issue tracking the native in-loop adapter, for a `neutral` runtime. */
  adapterTracking?: string;
  /** One line on what this runtime gets, shown after detection. */
  note: string;
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
 * agent".
 */
export const KNOWN_RUNTIMES: readonly RuntimeDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    markers: ['.claude/settings.json', '.claude'],
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
    const matchedMarker = rt.markers.find((m) => {
      try {
        return existsSync(join(cwd, m));
      } catch {
        return false;
      }
    });
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
 * The honesty note printed when the repository uses a runtime WITHOUT a shipped
 * in-loop adapter and Claude Code is not among the detected runtimes. It states
 * plainly that the in-loop layer is Claude-only today, that the Claude hook
 * wiring `init` writes is inert under the other runtime (it activates only if
 * Claude Code runs here), and that the neutral layers are the live protection.
 * Returns null when there is nothing to caveat (Claude present, or nothing
 * detected — the neutral default already says the true thing).
 */
export function neutralOnlyCaveat(detected: readonly DetectedRuntime[]): string | null {
  if (detected.length === 0 || hasInLoopRuntime(detected)) return null;
  const names = detected.map((r) => r.label).join(', ');
  const tracking = [...new Set(detected.map((r) => r.adapterTracking).filter(Boolean))].join(', ');
  return (
    `In-loop steering (deny-before-execute) ships for Claude Code only today, so on ${names} your live protection is ` +
    `the agent-neutral layers: pre-commit and CI. The Claude hook wiring is still written and is inert unless Claude Code ` +
    `runs in this repository.${tracking ? ` A native in-loop adapter is tracked in ${tracking}.` : ''}`
  );
}
