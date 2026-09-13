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

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { Finding, Policy } from '../types';
import { isProtected } from '../policy';
import { isEnabled, makeFinding } from './finding';
import type { FsEvent } from '../cli/watch';

const RULE = 'transient-protected-mutation';

export const MAX_EVENT_READ_BYTES = 4 * 1024 * 1024;
/** Maximum observer bytes one authority decision will classify in aggregate. */
export const MAX_EVENT_SWEEP_BYTES = 16 * 1024 * 1024;

export interface EventReadIo {
  read(
    fd: number,
    buffer: Buffer,
    bufferOffset: number,
    length: number,
    position: number,
  ): number;
}

const DEFAULT_EVENT_READ_IO: EventReadIo = {
  read: (fd, buffer, bufferOffset, length, position) =>
    readSync(fd, buffer, bufferOffset, length, position),
};

export type EventDrainIssue =
  | 'malformed-record'
  | 'oversized-record'
  | 'incomplete-record'
  | 'aggregate-limit'
  | 'read-stalled';

export interface EventDrain {
  events: FsEvent[];
  /** Cursor after the last fully classified record. Commit only when complete=true. */
  newOffset: number;
  bytesRead: number;
  batches: number;
  malformedLines: number;
  complete: boolean;
  issue?: EventDrainIssue;
}

export interface EventBatch {
  events: FsEvent[];
  /** Byte offset immediately after the last complete JSONL record consumed. */
  newOffset: number;
  /** Physical bytes read from the log for this batch (testable I/O cost). */
  bytesRead: number;
  /** True when the current log had more bytes than this bounded read consumed. */
  limitReached: boolean;
  /** Complete newline-terminated records that were not valid JSON. */
  malformedLines: number;
  /** True when bytes after newOffset do not yet form a complete newline record. */
  incompleteTail: boolean;
}

/**
 * Read events appended since `offset` using a positioned fd read.
 *
 * Cursor safety is byte-based, not string-based: only complete newline-terminated
 * records advance the cursor. A torn final write is therefore replayed on the next
 * call after the watcher completes it.
 */
export function readEvents(
  log: string,
  offset: number,
  maxBytes = MAX_EVENT_READ_BYTES,
  io: EventReadIo = DEFAULT_EVENT_READ_IO,
): EventBatch {
  let size = 0;
  try {
    size = statSync(log).size;
  } catch {
    return {
      events: [],
      newOffset: Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0),
      bytesRead: 0,
      limitReached: false,
      malformedLines: 0,
      incompleteTail: false,
    };
  }

  let start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  // Rotation/truncation: an old cursor beyond EOF cannot describe this file.
  if (start > size) start = 0;
  if (size <= start) {
    return {
      events: [],
      newOffset: start,
      bytesRead: 0,
      limitReached: false,
      malformedLines: 0,
      incompleteTail: false,
    };
  }

  const cap = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.max(1, Math.floor(maxBytes))
    : MAX_EVENT_READ_BYTES;
  const available = size - start;
  const requested = Math.min(available, cap);
  const buffer = Buffer.allocUnsafe(requested);
  const fd = openSync(log, 'r');
  let bytesRead = 0;
  try {
    bytesRead = io.read(fd, buffer, 0, requested, start);
  } finally {
    closeSync(fd);
  }

  if (bytesRead <= 0) {
    return {
      events: [],
      newOffset: start,
      bytesRead: 0,
      limitReached: available > 0,
      malformedLines: 0,
      incompleteTail: available > 0,
    };
  }

  const chunk = buffer.subarray(0, bytesRead);
  const lastNewline = chunk.lastIndexOf(0x0a);
  const limitReached = start + bytesRead < size;
  if (lastNewline < 0) {
    return {
      events: [],
      newOffset: start,
      bytesRead,
      limitReached,
      malformedLines: 0,
      incompleteTail: true,
    };
  }

  const events: FsEvent[] = [];
  let malformedLines = 0;
  const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as FsEvent);
    } catch {
      malformedLines++;
    }
  }

  const newOffset = start + lastNewline + 1;
  return {
    events,
    newOffset,
    bytesRead,
    limitReached,
    malformedLines,
    incompleteTail: newOffset < start + bytesRead,
  };
}

/**
 * Drain observer telemetry in bounded positioned reads.
 *
 * A single read is capped at MAX_EVENT_READ_BYTES; one authority decision is
 * capped at MAX_EVENT_SWEEP_BYTES. We only report complete=true when every byte
 * present at the time of the drain was represented by newline-terminated,
 * parseable JSONL records. Consumers may commit newOffset only in that case.
 *
 * This avoids both failure modes #313 exposed:
 * - O(total-history) reads on every Stop; and
 * - bounded-prefix false greens where later telemetry stayed unclassified.
 */
export function drainEvents(
  log: string,
  offset: number,
  maxTotalBytes = MAX_EVENT_SWEEP_BYTES,
  io: EventReadIo = DEFAULT_EVENT_READ_IO,
): EventDrain {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const aggregateCap =
    Number.isFinite(maxTotalBytes) && maxTotalBytes > 0
      ? Math.max(1, Math.floor(maxTotalBytes))
      : MAX_EVENT_SWEEP_BYTES;

  const events: FsEvent[] = [];
  let cursor = start;
  let bytesRead = 0;
  let batches = 0;
  let malformedLines = 0;

  while (bytesRead < aggregateCap) {
    const remainingBudget = aggregateCap - bytesRead;
    const batch = readEvents(
      log,
      cursor,
      Math.min(MAX_EVENT_READ_BYTES, remainingBudget),
      io,
    );
    batches++;
    bytesRead += batch.bytesRead;
    malformedLines += batch.malformedLines;
    events.push(...batch.events);

    if (batch.malformedLines > 0) {
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: false,
        issue: 'malformed-record',
      };
    }

    if (batch.bytesRead === 0) {
      if (batch.limitReached || batch.incompleteTail) {
        return {
          events,
          newOffset: cursor,
          bytesRead,
          batches,
          malformedLines,
          complete: false,
          issue: 'read-stalled',
        };
      }
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: true,
      };
    }

    // No complete newline in a full bounded chunk means the current record
    // itself exceeds the per-read ceiling. Do not scan/allocate the whole line.
    if (batch.limitReached && batch.newOffset === cursor) {
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: false,
        issue: 'oversized-record',
      };
    }

    // EOF with a partial record: retain it from its beginning for the next turn.
    if (!batch.limitReached && batch.incompleteTail) {
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: false,
        issue: 'incomplete-record',
      };
    }

    cursor = batch.newOffset;

    if (!batch.limitReached) {
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: true,
      };
    }

    if (bytesRead >= aggregateCap) {
      return {
        events,
        newOffset: cursor,
        bytesRead,
        batches,
        malformedLines,
        complete: false,
        issue: 'aggregate-limit',
      };
    }
  }

  return {
    events,
    newOffset: cursor,
    bytesRead,
    batches,
    malformedLines,
    complete: false,
    issue: 'aggregate-limit',
  };
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
