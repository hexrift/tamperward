// The tamperward-audit evidence store: immutable partitions, sharded indexes
// and an incrementally folded summary. Node builtins only — this module runs
// inside the write-authorized publish job, where no dependency code may execute.
//
// Layout (audit-store-v2; the v1 layout below is read forever, never rewritten):
//   events/all.jsonl              v1: every event ingested before partitioning (frozen)
//   events/YYYY/MM/<batch-id>.jsonl v2: the NEW events of one ingested batch, one file per
//                                 batch under the month it was ingested; never rewritten
//   ingested/batches.jsonl        the ledger: one entry per ingested batch (the manifest)
//   ids/<ab>.jsonl                event-id index, 256 shards by the id's first two hex
//                                 digits, sorted; {id, content_sha256} per line
//   sessions/<ab>.txt             distinct hashed session ids, 256 shards, sorted
//   summaries/state.json          the fold state the all-time summary derives from
//   summaries/all-time.json       stats-v1, derived from state.json
//   README.md                     the rendered summary
//
// Adding one batch touches: its own partition file, the shards its ids and
// sessions hash into, the ledger tail, and the three derived files. Nothing
// historical is copied or rewritten. A full rebuild (`--rebuild`, or whenever
// the derived state is missing or inconsistent with the ledger) streams every
// partition once with bounded memory and regenerates shards and state.

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const STORE_LAYOUT = 'audit-store-v2';
export const STATE_SCHEMA = 'audit-store-state-v1';

/** Hard limits. Exceeding one is an exit-2 refusal with the limit in the message. */
export const LIMITS = Object.freeze({
  maxLineBytes: 16 * 1024, // one event line
  maxBatchBytes: 16 * 1024 * 1024, // one candidate batch file
  maxBatchEvents: 50_000, // events in one candidate batch
  maxFilesPerPartition: 4096, // batch files under one events/YYYY/MM directory
});

export class LimitError extends Error {}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());

const ID_PATTERN = /^sha256:[0-9a-f]{32}$/;
const SESSION_PATTERN = /^sha256:[0-9a-f]{24}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INGESTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const RULE_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SURFACES = new Set(['pretooluse', 'stop']);

// ---- paths -------------------------------------------------------------------

export const paths = Object.freeze({
  legacyEvents: 'events/all.jsonl',
  ledger: 'ingested/batches.jsonl',
  state: 'summaries/state.json',
  summary: 'summaries/all-time.json',
  readme: 'README.md',
  partitionDir: (ingestedAt) => `events/${ingestedAt.slice(0, 4)}/${ingestedAt.slice(5, 7)}`,
  partition: (ingestedAt, batchId) => `${paths.partitionDir(ingestedAt)}/${batchId}.jsonl`,
  idShard: (id) => `ids/${id.slice(7, 9)}.jsonl`,
  sessionShard: (session) => `sessions/${session.slice(7, 9)}.txt`,
});

// ---- file helpers: symlinks are refused before anything is read or written ----

export function refuseSymlink(path, label) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`audit-publish: ${label} is not a regular file`);
}

export function ensureDirectory(path, label) {
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`audit-publish: ${label} is not a directory`);
  mkdirSync(path, { recursive: true });
}

export function readTextIfPresent(path, label) {
  refuseSymlink(path, label);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const nonblank = (raw) => raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

/**
 * Streams a JSONL file line by line with a fixed buffer: memory is bounded by
 * one line (at most maxLineBytes) plus the buffer, never by the file size.
 * Blank lines are skipped, a trailing CR is dropped, line numbers are 1-based.
 */
export function forEachLine(path, onLine, maxLineBytes = LIMITS.maxLineBytes) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = [];
    let pendingBytes = 0;
    let lineNumber = 0;
    const emit = (parts) => {
      lineNumber++;
      let line = parts.length === 1 ? parts[0].toString('utf8') : Buffer.concat(parts).toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line, lineNumber);
    };
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let start = 0;
      for (let i = 0; i < read; i++) {
        if (chunk[i] !== 0x0a) continue;
        const part = chunk.subarray(start, i);
        if (pendingBytes + part.length > maxLineBytes) {
          throw new LimitError(`${path} line ${lineNumber + 1} exceeds the ${maxLineBytes}-byte event line limit`);
        }
        emit(pending.length ? [...pending, part] : [part]);
        pending = [];
        pendingBytes = 0;
        start = i + 1;
      }
      if (start < read) {
        const rest = Buffer.from(chunk.subarray(start, read));
        pendingBytes += rest.length;
        if (pendingBytes > maxLineBytes) {
          throw new LimitError(`${path} line ${lineNumber + 1} exceeds the ${maxLineBytes}-byte event line limit`);
        }
        pending.push(rest);
      }
    }
    if (pending.length) emit(pending);
  } finally {
    closeSync(fd);
  }
}

// ---- the ledger -----------------------------------------------------------------

const LEDGER_REQUIRED = ['batch_id', 'source_sha', 'content_sha256', 'schema', 'ingested_at', 'event_count'];
const LEDGER_V2 = ['partition', 'stored_events', 'stored_sha256'];
const LEDGER_ALLOWED = new Set([...LEDGER_REQUIRED, ...LEDGER_V2]);

/**
 * Parses the ledger. A v1 entry (no `partition`) describes a batch whose
 * events live in events/all.jsonl; a v2 entry names its own partition file
 * and records how many event lines it holds and their hash.
 */
export function readLedger(raw) {
  const entries = [];
  const byId = new Map();
  nonblank(raw).forEach((line, index) => {
    const where = `audit-publish: ledger line ${index + 1}`;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`${where} is not valid JSON`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${where} is not a JSON object`);
    const unknown = Object.keys(entry).find((key) => !LEDGER_ALLOWED.has(key));
    if (unknown) throw new Error(`${where} has unsupported field "${unknown}"`);
    if (LEDGER_REQUIRED.some((key) => !(key in entry))) throw new Error(`${where} is missing a required field`);
    if (typeof entry.batch_id !== 'string' || !BATCH_ID_PATTERN.test(entry.batch_id)) throw new Error(`${where} has an invalid batch_id`);
    if (typeof entry.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(entry.source_sha)) throw new Error(`${where} has an invalid source_sha`);
    if (typeof entry.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.content_sha256)) throw new Error(`${where} has an invalid content_sha256`);
    if (entry.schema !== 'audit-v1') throw new Error(`${where} has an invalid schema`);
    if (typeof entry.ingested_at !== 'string' || !INGESTED_AT_PATTERN.test(entry.ingested_at) || !Number.isFinite(Date.parse(entry.ingested_at))) {
      throw new Error(`${where} has an invalid ingested_at`);
    }
    if (!Number.isSafeInteger(entry.event_count) || entry.event_count <= 0) throw new Error(`${where} has an invalid event_count`);
    const v2 = LEDGER_V2.filter((key) => key in entry);
    if (v2.length !== 0 && v2.length !== LEDGER_V2.length) throw new Error(`${where} has an incomplete partition record`);
    if (v2.length) {
      if (entry.partition !== paths.partition(entry.ingested_at, entry.batch_id)) throw new Error(`${where} names a partition that does not match its batch`);
      if (!Number.isSafeInteger(entry.stored_events) || entry.stored_events < 0 || entry.stored_events > entry.event_count) {
        throw new Error(`${where} has an invalid stored_events`);
      }
      if (typeof entry.stored_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.stored_sha256)) throw new Error(`${where} has an invalid stored_sha256`);
    }
    if (byId.has(entry.batch_id)) throw new Error(`audit-publish: duplicate ledger batch_id ${entry.batch_id}`);
    byId.set(entry.batch_id, entry);
    entries.push(entry);
  });
  return { entries, byId };
}

// ---- fold state and the derived summary -----------------------------------------

export function emptyState() {
  return {
    schema: STATE_SCHEMA,
    events: 0,
    blocked: 0,
    warnings: 0,
    sessions: 0,
    first: null,
    last: null,
    by_rule: {},
    by_surface: {},
    legacy_events: 0,
    legacy_bytes: 0,
  };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function validBound(bound) {
  if (bound === null) return true;
  return isObject(bound) && Object.keys(bound).length === 2 && typeof bound.timestamp === 'string' && TIMESTAMP_PATTERN.test(bound.timestamp)
    && Number.isFinite(Date.parse(bound.timestamp)) && typeof bound.id === 'string' && ID_PATTERN.test(bound.id);
}

/** Structural validation of summaries/state.json; returns null when unusable. */
export function parseState(raw) {
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(state) || state.schema !== STATE_SCHEMA) return null;
  const expected = Object.keys(emptyState());
  if (Object.keys(state).length !== expected.length || expected.some((key) => !(key in state))) return null;
  for (const key of ['events', 'blocked', 'warnings', 'sessions', 'legacy_events', 'legacy_bytes']) if (!isCount(state[key])) return null;
  if (!validBound(state.first) || !validBound(state.last)) return null;
  if ((state.first === null) !== (state.events === 0) || (state.last === null) !== (state.events === 0)) return null;
  if (state.blocked + state.warnings !== state.events) return null;
  if (!isObject(state.by_rule) || !isObject(state.by_surface)) return null;
  let ruleEvents = 0;
  for (const [rule, counts] of Object.entries(state.by_rule)) {
    if (!RULE_PATTERN.test(rule) || !isObject(counts) || Object.keys(counts).length !== 3) return null;
    if (!isCount(counts.events) || !isCount(counts.blocked) || !isCount(counts.warnings) || counts.events < 1) return null;
    if (counts.blocked + counts.warnings !== counts.events) return null;
    ruleEvents += counts.events;
  }
  let surfaceEvents = 0;
  for (const [surface, count] of Object.entries(state.by_surface)) {
    if (!SURFACES.has(surface) || !isCount(count) || count < 1) return null;
    surfaceEvents += count;
  }
  if (ruleEvents !== state.events || surfaceEvents !== state.events) return null;
  return state;
}

const before = (a, b) => a.ms < b.ms || (a.ms === b.ms && a.id.localeCompare(b.id) < 0);

/** Folds one validated event into the state. `newSession` says whether its session hash is new to the store. */
export function foldEvent(state, event, newSession) {
  state.events++;
  if (event.severity === 'block') state.blocked++;
  else state.warnings++;
  const bucket = state.by_rule[event.rule] ?? { events: 0, blocked: 0, warnings: 0 };
  bucket.events++;
  if (event.severity === 'block') bucket.blocked++;
  else bucket.warnings++;
  state.by_rule[event.rule] = bucket;
  state.by_surface[event.surface] = (state.by_surface[event.surface] ?? 0) + 1;
  if (newSession) state.sessions++;
  const bound = { ms: Date.parse(event.timestamp), id: event.id };
  if (state.first === null || before(bound, { ms: Date.parse(state.first.timestamp), id: state.first.id })) {
    state.first = { timestamp: event.timestamp, id: event.id };
  }
  if (state.last === null || before({ ms: Date.parse(state.last.timestamp), id: state.last.id }, bound)) {
    state.last = { timestamp: event.timestamp, id: event.id };
  }
}

/** The stats-v1 document derived from the fold state. */
export function summaryFromState(state) {
  return {
    schema_version: 1,
    events: state.events,
    blocked: state.blocked,
    warnings: state.warnings,
    sessions: state.sessions,
    first_event: state.first === null ? null : state.first.timestamp,
    last_event: state.last === null ? null : state.last.timestamp,
    by_rule: Object.entries(state.by_rule).map(([rule, counts]) => ({ rule, ...counts }))
      .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule)),
    by_surface: Object.entries(state.by_surface).map(([surface, events]) => ({ surface, events }))
      .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface)),
    interpretation: 'finding-is-not-proof-of-intent',
  };
}

export function renderSummary(summary) {
  const out = [
    'TamperWard audit stats',
    '',
    `Events      ${summary.events}`,
    `Blocked     ${summary.blocked}`,
    `Warnings    ${summary.warnings}`,
    `Sessions    ${summary.sessions}`,
  ];
  if (summary.first_event && summary.last_event) out.push(`First       ${summary.first_event}`, `Last        ${summary.last_event}`);
  if (summary.by_rule.length) {
    out.push('', 'By rule');
    const width = Math.max(...summary.by_rule.map((row) => row.rule.length));
    for (const row of summary.by_rule) out.push(`  ${row.rule.padEnd(width)}  ${row.events}`);
  }
  if (summary.by_surface.length) {
    out.push('', 'By surface');
    const width = Math.max(...summary.by_surface.map((row) => row.surface.length));
    for (const row of summary.by_surface) out.push(`  ${row.surface.padEnd(width)}  ${row.events}`);
  }
  out.push('', 'Note: an integrity finding is a signal, not proof of agent intent; legitimate refactors can trigger findings.');
  return out.join('\n') + '\n';
}

// ---- shards --------------------------------------------------------------------

/** Parses an id shard: sorted `{id, content_sha256}` lines. */
export function readIdShard(raw, label) {
  const map = new Map();
  nonblank(raw).forEach((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`audit-publish: ${label} line ${index + 1} is not valid JSON`);
    }
    if (!isObject(entry) || Object.keys(entry).length !== 2 || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)
      || typeof entry.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.content_sha256)) {
      throw new Error(`audit-publish: ${label} line ${index + 1} is not an id index entry`);
    }
    if (map.has(entry.id)) throw new Error(`audit-publish: ${label} repeats id ${entry.id}`);
    map.set(entry.id, entry.content_sha256);
  });
  return map;
}

export function writeIdShard(map) {
  return [...map.keys()].sort().map((id) => JSON.stringify({ id, content_sha256: map.get(id) }) + '\n').join('');
}

export function readSessionShard(raw, label) {
  const set = new Set();
  nonblank(raw).forEach((line, index) => {
    if (!SESSION_PATTERN.test(line)) throw new Error(`audit-publish: ${label} line ${index + 1} is not a session hash`);
    if (set.has(line)) throw new Error(`audit-publish: ${label} repeats session ${line}`);
    set.add(line);
  });
  return set;
}

export function writeSessionShard(set) {
  return [...set].sort().map((session) => session + '\n').join('');
}

/**
 * Lazily loaded shards: a shard is read from the store the first time an id
 * or session hashes into it, so a run touches only the shards its batch needs.
 */
export class Shards {
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.ids = new Map(); // shard path -> Map(id -> content hash)
    this.sessions = new Map(); // shard path -> Set(session)
    this.touched = new Set();
  }

  idShard(id) {
    const rel = paths.idShard(id);
    if (!this.ids.has(rel)) this.ids.set(rel, readIdShard(readTextIfPresent(join(this.storeDir, rel), rel), rel));
    return this.ids.get(rel);
  }

  sessionShard(session) {
    const rel = paths.sessionShard(session);
    if (!this.sessions.has(rel)) this.sessions.set(rel, readSessionShard(readTextIfPresent(join(this.storeDir, rel), rel), rel));
    return this.sessions.get(rel);
  }

  /** Records a new id; returns false when the id is already indexed with identical content. Throws on a conflict. */
  addId(id, contentSha256, where) {
    const shard = this.idShard(id);
    const prior = shard.get(id);
    if (prior !== undefined) {
      if (prior !== contentSha256) throw new Error(`audit-publish: candidate event id conflicts with stored content: ${id}${where ? ` (${where})` : ''}`);
      return false;
    }
    shard.set(id, contentSha256);
    this.touched.add(paths.idShard(id));
    return true;
  }

  /** Records a session hash; returns true when it was not yet known to the store. */
  addSession(session) {
    const shard = this.sessionShard(session);
    if (shard.has(session)) return false;
    shard.add(session);
    this.touched.add(paths.sessionShard(session));
    return true;
  }

  /** The touched shards as {relativePath, content}. */
  changes() {
    const out = [];
    for (const rel of [...this.touched].sort()) {
      out.push({ rel, content: rel.startsWith('ids/') ? writeIdShard(this.ids.get(rel)) : writeSessionShard(this.sessions.get(rel)) });
    }
    return out;
  }
}

// ---- full rebuild ------------------------------------------------------------------

/**
 * Streams every stored event once (the frozen v1 file, then each v2 partition
 * in ledger order), validating each against the schema, and regenerates the
 * id and session shards and the fold state. Memory is bounded by one line plus
 * the largest shard: ids and sessions are first spooled into 256 temporary
 * shard files each, then each shard is sorted and checked on its own.
 */
export function rebuild(storeDir, ledger, validateEvent, tmpDir) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(join(tmpDir, 'ids'), { recursive: true });
  mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  const spool = new Map(); // rel -> fd
  const spoolTo = (rel, line) => {
    let fd = spool.get(rel);
    if (fd === undefined) {
      fd = openSync(join(tmpDir, rel), 'a');
      spool.set(rel, fd);
    }
    writeFileSync(fd, line + '\n');
  };
  const state = emptyState();
  const sources = [];
  const legacyPath = join(storeDir, paths.legacyEvents);
  refuseSymlink(legacyPath, paths.legacyEvents);
  if (existsSync(legacyPath)) sources.push({ rel: paths.legacyEvents, legacy: true });
  for (const entry of ledger.entries) if (entry.partition) sources.push({ rel: entry.partition, legacy: false, entry });

  try {
    for (const source of sources) {
      const path = join(storeDir, source.rel);
      refuseSymlink(path, source.rel);
      if (!existsSync(path)) {
        throw new Error(`audit-publish: ledger names a missing partition ${source.rel} — a rebuild streams every partition, so it needs a full checkout (dispatch the workflow with rebuild=true)`);
      }
      let count = 0;
      const hash = createHash('sha256');
      forEachLine(path, (line, lineNumber) => {
        const event = validateEvent(line, `${source.rel} line ${lineNumber}`);
        count++;
        // Sessions are folded per shard below, so the state's session count is
        // added once every distinct hash is known.
        foldEvent(state, event, false);
        spoolTo(paths.idShard(event.id), `${event.id} ${sha256(canonical(event))}`);
        if (event.session) spoolTo(paths.sessionShard(event.session), event.session);
      });
      if (source.legacy) {
        state.legacy_events = count;
        state.legacy_bytes = statSync(path).size;
      } else {
        // A partition holds exactly the lines its ledger entry recorded.
        if (count !== source.entry.stored_events) {
          throw new Error(`audit-publish: partition ${source.rel} holds ${count} event(s) but its ledger entry recorded ${source.entry.stored_events}`);
        }
        hash.update(readFileSync(path));
        if (hash.digest('hex') !== source.entry.stored_sha256) throw new Error(`audit-publish: partition ${source.rel} does not match its ledger hash`);
      }
    }
  } finally {
    for (const fd of spool.values()) closeSync(fd);
  }

  const shards = [];
  for (const kind of ['ids', 'sessions']) {
    for (const file of readdirSync(join(tmpDir, kind)).sort()) {
      const rel = `${kind}/${file}`;
      if (kind === 'ids') {
        const map = new Map();
        forEachLine(join(tmpDir, rel), (line) => {
          const [id, contentSha256] = line.split(' ');
          const prior = map.get(id);
          if (prior !== undefined && prior !== contentSha256) throw new Error(`audit-publish: stored audit event id has two contents: ${id}`);
          if (prior !== undefined) throw new Error(`audit-publish: duplicate stored audit event id: ${id}`);
          map.set(id, contentSha256);
        });
        shards.push({ rel, content: writeIdShard(map) });
      } else {
        const set = new Set();
        forEachLine(join(tmpDir, rel), (line) => set.add(line));
        state.sessions += set.size;
        shards.push({ rel, content: writeSessionShard(set) });
      }
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  return { state, shards };
}

/**
 * Whether the derived state on disk can be folded forward: it must parse,
 * agree with the ledger on how many events every v2 partition holds, and
 * describe the frozen v1 file at its current size. Anything else rebuilds.
 */
export function stateIsConsistent(storeDir, state, ledger) {
  if (state === null) return false;
  let stored = 0;
  for (const entry of ledger.entries) if (entry.partition) stored += entry.stored_events;
  const legacyPath = join(storeDir, paths.legacyEvents);
  refuseSymlink(legacyPath, paths.legacyEvents);
  const legacyBytes = existsSync(legacyPath) ? statSync(legacyPath).size : 0;
  if (state.legacy_bytes !== legacyBytes) return false;
  if (legacyBytes === 0 && state.legacy_events !== 0) return false;
  return state.events === state.legacy_events + stored;
}

/** Number of batch files the ledger already places under one partition directory. */
export function partitionFileCount(ledger, partitionDir) {
  let count = 0;
  for (const entry of ledger.entries) if (entry.partition && dirname(entry.partition) === partitionDir) count++;
  return count;
}
