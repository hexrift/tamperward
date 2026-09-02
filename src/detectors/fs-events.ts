// #15 transient-protected-mutation (events surface, WARN by default).
//
// Consumes the `tamperward watch` event log at the Stop sweep. The class: a
// protected file whose recorded content CHURNED during the turn but whose net
// state at Stop is unchanged — modified and restored, so neither the per-call
// drift check nor the turn diff can see it, while anything that consulted the
// suite mid-churn consulted a weakened version. Measured basis: one transient
// in 59 real trajectories (PHASE3.md-era observer logs), and it was exactly
// this pattern (skip -> npm test -> restore). Mode churn (chmod away and back)
// is the same rule's attribute variant — the other A.1 documented miss.
//
// WARN by default, deliberately: a Stop block already forces a restore, and a
// compliant restore would then read as churn — a block default would deadlock
// the honest path. Harnesses that own that semantics (taskbench) opt into
// TAMPERWARD_TRANSIENT=block. This is the one rule whose default severity an
// env var may raise and never lower.
//
// This detector runs on its own surface (events), not through the engine's
// Change stream — existing detectors branch file/command and must not start
// seeing a third kind.

import { readFileSync, statSync } from 'node:fs';
import { Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { isEnabled, makeFinding } from './finding';
import type { FsEvent } from '../cli/watch';

const RULE = 'transient-protected-mutation';

export interface EventBatch {
  events: FsEvent[];
  newOffset: number;
}

/** Read events appended since `offset` (byte offset into the JSONL log). */
export function readEvents(log: string, offset: number): EventBatch {
  let size = 0;
  try {
    size = statSync(log).size;
  } catch {
    return { events: [], newOffset: offset };
  }
  if (size <= offset) return { events: [], newOffset: offset >= 0 ? Math.min(offset, size) : 0 };
  const raw = readFileSync(log, 'utf8').slice(offset);
  const events: FsEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as FsEvent);
    } catch {
      /* torn write at the tail; it will re-read next time */
    }
  }
  return { events, newOffset: size };
}

/**
 * Judge the turn's events against its net diff. `persistentPaths` = protected
 * paths present in the turn diff (their changes are judged by the ordinary
 * detectors); `finalHash` resolves a path's content hash at Stop time.
 */
export function transientFindings(
  events: FsEvent[],
  persistentPaths: Set<string>,
  policy: Policy,
  finalHash: (path: string) => string | null,
): Finding[] {
  // This rule runs outside the engine, so the engine's enabled check never saw it.
  if (!isEnabled(RULE, policy)) return [];
  const byPath = new Map<string, FsEvent[]>();
  for (const e of events) {
    if (!isProtected(e.path, policy)) continue;
    const arr = byPath.get(e.path) ?? [];
    arr.push(e);
    byPath.set(e.path, arr);
  }

  const out: Finding[] = [];
  const strict = process.env.TAMPERWARD_TRANSIENT === 'block';
  for (const [path, evs] of byPath) {
    if (persistentPaths.has(path)) continue; // net change — the turn diff's rules own it

    const final = finalHash(path);
    const hashes = new Set(evs.map((e) => e.hash).filter((h): h is string => h != null));
    if (final != null) hashes.add(final);
    const contentChurn = hashes.size > 1;

    const modes = new Set(evs.map((e) => e.mode).filter((m): m is number => m != null));
    const modeChurn = modes.size > 1;

    if (!contentChurn && !modeChurn) continue; // mtime-only noise

    const what = contentChurn
      ? `content was modified and restored within the turn (${hashes.size} distinct states observed)`
      : `file mode changed during the turn (${[...modes].map((m) => (m & 0o7777).toString(8)).join(' → ')})`;
    const f = makeFinding(RULE, policy, {
      file: path,
      message: `Transient protected mutation: ${what}, leaving no net diff.`,
      evidence: evs
        .slice(0, 4)
        .map((e) => `${e.ts} ${e.hash ?? 'gone'}${e.mode != null ? `/${(e.mode & 0o7777).toString(8)}` : ''}`)
        .join(' | '),
      remediation:
        'Anything that ran against the mid-turn state ran against a weakened suite. Re-run the checks against the restored tree; if the mutation was an experiment, say so where a human will read it.',
      defaultSeverity: 'warn',
    });
    // TAMPERWARD_TRANSIENT=block may RAISE the severity (a harness owning restore
    // semantics opts in); it can never lower it, and policy cannot pre-empt the raise.
    if (strict && f.severity !== 'block') {
      f.severity = 'block';
      f.signoff.required = true;
    }
    out.push(f);
  }
  return out;
}
