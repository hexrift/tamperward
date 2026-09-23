// Complete write-authorized transition for the tamperward-audit branch.
// Runs with Node builtins only. The cloned evidence branch is the immutable
// prefix; raw trusted candidates are validated and appended, and both reports
// are derived locally. No replacement store or derived artifact is accepted.
//
// Storage layout (audit-store v2, back-compatible with v1):
//   events/all.jsonl            LEGACY monolithic prefix. Read as an immutable
//                               partition; NEVER appended to or rewritten.
//   events/YYYY/MM/<id>.jsonl   One immutable file per ingested batch. Written
//                               once, keyed by ingest month, never rewritten.
//   ingested/batches.jsonl      Append-only manifest (unchanged v1 schema).
//   ids/<pp>.jsonl              Sharded event-id index (pp = first two hex of
//                               the id). Conflict detection reads and rewrites
//                               only the shards a batch touches, never one giant
//                               map over all history. Built once from the legacy
//                               events/all.jsonl on first v2 run (migration).
//   summaries/all-time.json     Derived summary, recomputed by a bounded
//   README.md                   streaming pass over the immutable partitions.
//
// Adding one batch therefore appends O(batch) event bytes, touches only the
// affected id shards, and never copies or rewrites a historical event file.
//
// Usage: node audit-publish.mjs <schemaPath> <candidatesDir> <storeDir> <sourceSha>

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAuditSchema, validateAuditJsonl, validateAuditValue } from './audit-verify.mjs';

// Explicit, actionable limits. Exceeding any of them is an operational error,
// not a validation error, so it exits 2 with a clear diagnostic (a malformed
// event still exits 1). These bound peak memory and per-run work regardless of
// how large the retained history grows.
const MAX_EVENT_LINE_BYTES = 64 * 1024; // one audit event line
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // one reviewed/dispatch batch file
const MAX_BATCH_EVENTS = 50_000; // events in one batch
const MAX_FILES_PER_PARTITION = 10_000; // *.jsonl files under one events/YYYY/MM

class LimitError extends Error {}

const [schemaPath, candidatesDir, storeDir, sourceSha] = process.argv.slice(2);
if (!schemaPath || !candidatesDir || !storeDir || !sourceSha) {
  console.error('usage: audit-publish.mjs <schemaPath> <candidatesDir> <storeDir> <sourceSha>');
  process.exit(2);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const nonblankLines = (raw) => raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

function ensureDirectory(path, label) {
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`audit-publish: ${label} is not a directory`);
  mkdirSync(path, { recursive: true });
}

function readStoreFile(path, label) {
  if (!existsSync(path)) return '';
  if (!lstatSync(path).isFile()) throw new Error(`audit-publish: ${label} is not a regular file`);
  return readFileSync(path, 'utf8');
}

function assertWritableFile(path, label) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`audit-publish: ${label} is not a regular file`);
}

function append(prefix, additions) {
  if (additions.length === 0) return prefix;
  return prefix + (prefix.length > 0 && !prefix.endsWith('\n') ? '\n' : '') + additions.join('\n') + '\n';
}

// Bounded-memory line reader: 64 KiB chunks and a rolling partial-line buffer
// that is never allowed to exceed MAX_EVENT_LINE_BYTES. Yields each complete
// non-blank line with its 1-based line number. Used to stream immutable
// partitions and to migrate the legacy store without loading a whole file.
function forEachLine(path, onLine) {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = '';
    let lineNumber = 0;
    let bytes;
    const flush = (line) => {
      lineNumber++;
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_EVENT_LINE_BYTES) {
        throw new LimitError(`audit-publish: event line ${lineNumber} in ${path} exceeds the ${MAX_EVENT_LINE_BYTES}-byte limit`);
      }
      if (trimmed.trim()) onLine(trimmed, lineNumber);
    };
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      pending += chunk.toString('utf8', 0, bytes);
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        flush(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_EVENT_LINE_BYTES) {
        throw new LimitError(`audit-publish: event line ${lineNumber + 1} in ${path} exceeds the ${MAX_EVENT_LINE_BYTES}-byte limit`);
      }
    }
    if (pending.length) flush(pending);
  } finally {
    closeSync(fd);
  }
}

function readLedger(raw) {
  const allowed = new Set(['batch_id', 'source_sha', 'content_sha256', 'schema', 'ingested_at', 'event_count']);
  const entries = [];
  const byId = new Map();
  nonblankLines(raw).forEach((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`audit-publish: ledger line ${index + 1} is not valid JSON`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`audit-publish: ledger line ${index + 1} is not a JSON object`);
    }
    const unknown = Object.keys(entry).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`audit-publish: ledger line ${index + 1} has unsupported field "${unknown}"`);
    if (Object.keys(entry).length !== allowed.size || [...allowed].some((key) => !(key in entry))) {
      throw new Error(`audit-publish: ledger line ${index + 1} is missing a required field`);
    }
    if (typeof entry.batch_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(entry.batch_id)) {
      throw new Error(`audit-publish: ledger line ${index + 1} has an invalid batch_id`);
    }
    if (typeof entry.source_sha !== 'string' || !/^[0-9a-f]{40}$/.test(entry.source_sha)) {
      throw new Error(`audit-publish: ledger line ${index + 1} has an invalid source_sha`);
    }
    if (typeof entry.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.content_sha256)) {
      throw new Error(`audit-publish: ledger line ${index + 1} has an invalid content_sha256`);
    }
    if (entry.schema !== 'audit-v1') throw new Error(`audit-publish: ledger line ${index + 1} has an invalid schema`);
    if (typeof entry.ingested_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.ingested_at) || !Number.isFinite(Date.parse(entry.ingested_at))) {
      throw new Error(`audit-publish: ledger line ${index + 1} has an invalid ingested_at`);
    }
    if (!Number.isSafeInteger(entry.event_count) || entry.event_count <= 0) {
      throw new Error(`audit-publish: ledger line ${index + 1} has an invalid event_count`);
    }
    if (byId.has(entry.batch_id)) throw new Error(`audit-publish: duplicate ledger batch_id ${entry.batch_id}`);
    byId.set(entry.batch_id, entry);
    entries.push(entry);
  });
  return { entries, byId };
}

// Total order over events matching the CLI aggregator: chronological by instant,
// then by id. Min/max under this order reproduce the first/last summary bounds
// without materialising or sorting the full event array.
function compareOrder(a, b) {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id);
}

// Single-pass summary aggregator: holds only counts, the per-rule/per-surface
// maps, the distinct-session set and the extremal events. Byte-identical to the
// CLI's AuditAggregator output by construction.
function createAggregator() {
  const rules = new Map();
  const surfaces = new Map();
  const sessions = new Set();
  let events = 0, blocked = 0, warnings = 0, first = null, last = null;
  return {
    add(event) {
      events++;
      if (event.severity === 'block') blocked++;
      else warnings++;
      const bucket = rules.get(event.rule) ?? { events: 0, blocked: 0, warnings: 0 };
      bucket.events++;
      if (event.severity === 'block') bucket.blocked++;
      else bucket.warnings++;
      rules.set(event.rule, bucket);
      surfaces.set(event.surface, (surfaces.get(event.surface) ?? 0) + 1);
      if (event.session) sessions.add(event.session);
      if (first === null || compareOrder(event, first) < 0) first = event;
      if (last === null || compareOrder(event, last) > 0) last = event;
    },
    finish() {
      return {
        schema_version: 1,
        events,
        blocked,
        warnings,
        sessions: sessions.size,
        first_event: first?.timestamp ?? null,
        last_event: last?.timestamp ?? null,
        by_rule: [...rules.entries()].map(([rule, counts]) => ({ rule, ...counts }))
          .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule)),
        by_surface: [...surfaces.entries()].map(([surface, count]) => ({ surface, events: count }))
          .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface)),
        interpretation: 'finding-is-not-proof-of-intent',
      };
    },
  };
}

function render(summary) {
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

// --- Event id sharding -----------------------------------------------------
// A shard holds `id -> canonical(event)` for every id whose hex begins with the
// shard's two-character prefix. Conflict detection loads only the shards a batch
// touches, so it never builds one map over all history.
function shardOf(id) {
  return id.slice('sha256:'.length, 'sha256:'.length + 2);
}
function shardPath(store, shard) {
  return join(store, 'ids', `${shard}.jsonl`);
}
function loadShard(store, shard) {
  const path = shardPath(store, shard);
  const map = new Map();
  if (!existsSync(path)) return map;
  if (!lstatSync(path).isFile()) throw new Error(`audit-publish: ids/${shard}.jsonl is not a regular file`);
  for (const line of nonblankLines(readFileSync(path, 'utf8'))) {
    const entry = JSON.parse(line);
    if (typeof entry.id !== 'string' || typeof entry.content !== 'string') {
      throw new Error(`audit-publish: malformed id-index entry in ids/${shard}.jsonl`);
    }
    map.set(entry.id, entry.content);
  }
  return map;
}
function writeShard(store, shard, map) {
  const lines = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, content]) => JSON.stringify({ id, content }));
  writeFileSync(shardPath(store, shard), lines.join('\n') + (lines.length ? '\n' : ''));
}

// Enumerate every immutable event partition in deterministic order: the legacy
// events/all.jsonl first, then events/YYYY/MM/*.jsonl sorted by path.
function partitionFiles(store) {
  const eventsDir = join(store, 'events');
  const files = [];
  const legacy = join(eventsDir, 'all.jsonl');
  if (existsSync(legacy)) {
    if (!lstatSync(legacy).isFile()) throw new Error('audit-publish: events/all.jsonl is not a regular file');
    files.push(legacy);
  }
  const years = existsSync(eventsDir)
    ? readdirSync(eventsDir).filter((name) => /^\d{4}$/.test(name)).sort()
    : [];
  for (const year of years) {
    const yearDir = join(eventsDir, year);
    if (!lstatSync(yearDir).isDirectory()) continue;
    for (const month of readdirSync(yearDir).filter((name) => /^\d{2}$/.test(name)).sort()) {
      const monthDir = join(yearDir, month);
      if (!lstatSync(monthDir).isDirectory()) continue;
      for (const file of readdirSync(monthDir).filter((name) => name.endsWith('.jsonl')).sort()) {
        const path = join(monthDir, file);
        if (!lstatSync(path).isFile()) throw new Error(`audit-publish: ${join('events', year, month, file)} is not a regular file`);
        files.push(path);
      }
    }
  }
  return files;
}

// Stream every stored event (bounded memory) and hand each to `onEvent`.
function forEachStoredEvent(store, schema, onEvent) {
  for (const path of partitionFiles(store)) {
    forEachLine(path, (line, lineNumber) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`audit-publish: stored event line ${lineNumber} in ${path} is not valid JSON`);
      }
      validateAuditValue(schema, value, `stored event line ${lineNumber} in ${path}`);
      onEvent(value);
    });
  }
}

// One-time migration: index the legacy events/all.jsonl into id shards so that
// cross-source conflict detection is complete before any v2 ingest. Idempotent
// — it rewrites each affected shard from the full legacy set, so a re-run after
// a partial failure converges. Marked done with an ids/.all-jsonl-indexed
// sentinel so steady-state runs never rescan the monolithic prefix.
function migrateLegacyIds(store) {
  const sentinel = join(store, 'ids', '.all-jsonl-indexed');
  const legacy = join(store, 'events', 'all.jsonl');
  if (existsSync(sentinel)) return;
  // A non-regular events/all.jsonl (symlink, fifo, directory) is a tampered
  // store: fail closed before reading or writing through it, whether or not
  // there are candidates to ingest.
  if (existsSync(legacy) && !lstatSync(legacy).isFile()) {
    throw new Error('audit-publish: events/all.jsonl is not a regular file');
  }
  if (!existsSync(legacy) || !readFileSync(legacy, 'utf8').trim()) {
    writeFileSync(sentinel, 'legacy events/all.jsonl indexed into id shards\n');
    return;
  }
  const shards = new Map();
  forEachLine(legacy, (line, lineNumber) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`audit-publish: legacy event line ${lineNumber} is not valid JSON`);
    }
    if (typeof value.id !== 'string' || !/^sha256:[0-9a-f]{32}$/.test(value.id)) {
      throw new Error(`audit-publish: legacy event line ${lineNumber} has an invalid id`);
    }
    const shard = shardOf(value.id);
    const map = shards.get(shard) ?? loadShard(store, shard);
    shards.set(shard, map);
    const encoded = canonical(value);
    const prior = map.get(value.id);
    if (prior !== undefined && prior !== encoded) {
      throw new Error(`audit-publish: legacy event id conflicts with stored content: ${value.id}`);
    }
    map.set(value.id, encoded);
  });
  for (const [shard, map] of shards) writeShard(store, shard, map);
  writeFileSync(sentinel, 'legacy events/all.jsonl indexed into id shards\n');
}

function monthOf(isoTimestamp) {
  return { year: isoTimestamp.slice(0, 4), month: isoTimestamp.slice(5, 7) };
}

try {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('audit-publish: source SHA must be 40 lowercase hexadecimal characters');
  const schema = loadAuditSchema(schemaPath);
  const ledgerPath = join(storeDir, 'ingested', 'batches.jsonl');
  const summaryPath = join(storeDir, 'summaries', 'all-time.json');
  const readmePath = join(storeDir, 'README.md');
  ensureDirectory(storeDir, 'store');
  ensureDirectory(candidatesDir, 'candidates');
  ensureDirectory(join(storeDir, 'events'), 'events directory');
  ensureDirectory(join(storeDir, 'ingested'), 'ingested directory');
  ensureDirectory(join(storeDir, 'summaries'), 'summaries directory');
  ensureDirectory(join(storeDir, 'ids'), 'ids directory');

  // Migrate the legacy monolithic prefix into id shards so conflict detection
  // sees the complete history through the shards, not one giant map.
  migrateLegacyIds(storeDir);

  const existingLedgerRaw = readStoreFile(ledgerPath, 'ingested/batches.jsonl');
  const { entries: existingLedger, byId: ledgerById } = readLedger(existingLedgerRaw);

  const candidateFiles = existsSync(candidatesDir)
    ? readdirSync(candidatesDir).filter((file) => file.endsWith('.jsonl')).sort()
    : [];
  const ingestedAt = new Date().toISOString();

  // --- Phase 1: validate everything. No store file is written until every
  // candidate has passed schema, limit and id-conflict checks, so a rejected
  // batch never leaves a partial or rewritten store behind. ------------------
  const touchedShards = new Map(); // shard -> Map(id -> canonical)
  const loadTouched = (shard) => {
    let map = touchedShards.get(shard);
    if (!map) {
      map = loadShard(storeDir, shard);
      touchedShards.set(shard, map);
    }
    return map;
  };
  const partitionCounts = new Map(); // "YYYY/MM" -> current *.jsonl count
  const plannedWrites = []; // { path, contents } immutable partition files
  const appendedLedger = [];

  for (const file of candidateFiles) {
    const path = join(candidatesDir, file);
    if (!lstatSync(path).isFile()) throw new Error(`audit-publish: candidate is not a regular file: ${file}`);
    const batchId = basename(file, '.jsonl');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(batchId)) throw new Error(`audit-publish: invalid candidate batch id: ${batchId}`);
    const batch = readFileSync(path);
    if (batch.length > MAX_BATCH_BYTES) {
      throw new LimitError(`audit-publish: batch ${batchId} is ${batch.length} bytes, over the ${MAX_BATCH_BYTES}-byte limit`);
    }
    const raw = batch.toString('utf8');
    if (!raw.trim()) continue;
    for (const line of raw.split(/\r?\n/)) {
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
        throw new LimitError(`audit-publish: an event line in batch ${batchId} exceeds the ${MAX_EVENT_LINE_BYTES}-byte limit`);
      }
    }
    const contentSha256 = sha256(batch);
    const prior = ledgerById.get(batchId);
    if (prior) {
      if (prior.content_sha256 !== contentSha256) throw new Error(`audit-publish: batch ${batchId} content changed after ingestion`);
      continue; // already ingested, identical content — idempotent skip
    }

    const candidateEvents = validateAuditJsonl(schema, raw, `candidate ${file}`);
    if (candidateEvents.length > MAX_BATCH_EVENTS) {
      throw new LimitError(`audit-publish: batch ${batchId} has ${candidateEvents.length} events, over the ${MAX_BATCH_EVENTS}-event limit`);
    }
    const candidateLines = nonblankLines(raw);
    const keptLines = [];
    for (const [index, candidate] of candidateEvents.entries()) {
      const encoded = canonical(candidate);
      const shard = loadTouched(shardOf(candidate.id));
      const priorEvent = shard.get(candidate.id);
      if (priorEvent !== undefined && priorEvent !== encoded) {
        throw new Error(`audit-publish: candidate event id conflicts with stored content: ${candidate.id}`);
      }
      if (priorEvent === undefined) {
        shard.set(candidate.id, encoded);
        keptLines.push(candidateLines[index]);
      }
    }

    // Immutable partition file for this batch, keyed by ingest month.
    const { year, month } = monthOf(ingestedAt);
    const partitionRel = join(year, month);
    const partitionDir = join(storeDir, 'events', year, month);
    const partitionFile = join(partitionDir, `${batchId}.jsonl`);
    if (existsSync(partitionFile)) {
      throw new Error(`audit-publish: partition file already exists for un-ledgered batch ${batchId}`);
    }
    const currentCount = partitionCounts.get(partitionRel)
      ?? (existsSync(partitionDir) ? readdirSync(partitionDir).filter((n) => n.endsWith('.jsonl')).length : 0);
    if (currentCount + 1 > MAX_FILES_PER_PARTITION) {
      throw new LimitError(`audit-publish: partition ${partitionRel} would exceed ${MAX_FILES_PER_PARTITION} files`);
    }
    partitionCounts.set(partitionRel, currentCount + 1);
    if (keptLines.length > 0) {
      plannedWrites.push({ dir: partitionDir, path: partitionFile, contents: keptLines.join('\n') + '\n' });
    }
    appendedLedger.push({
      batch_id: batchId,
      source_sha: sourceSha,
      content_sha256: contentSha256,
      schema: 'audit-v1',
      ingested_at: ingestedAt,
      event_count: candidateEvents.length,
    });
    ledgerById.set(batchId, appendedLedger.at(-1));
  }

  if (appendedLedger.length === 0) {
    console.error(`audit-publish: ${candidateFiles.length} candidate(s), 0 new batch(es); nothing to append`);
    process.exit(0);
  }

  // --- Phase 2: write immutable data, then derive reports by streaming every
  // partition (bounded memory). Historical event files are never rewritten. ---
  for (const write of plannedWrites) {
    ensureDirectory(write.dir, 'partition directory');
    assertWritableFile(write.path, 'partition file');
    writeFileSync(write.path, write.contents);
  }
  const ledgerOutput = append(existingLedgerRaw, appendedLedger.map((entry) => JSON.stringify(entry)));
  assertWritableFile(ledgerPath, 'ingested/batches.jsonl');
  writeFileSync(ledgerPath, ledgerOutput);
  for (const [shard, map] of touchedShards) {
    assertWritableFile(shardPath(storeDir, shard), `ids/${shard}.jsonl`);
    writeShard(storeDir, shard, map);
  }

  const aggregator = createAggregator();
  forEachStoredEvent(storeDir, schema, (event) => aggregator.add(event));
  const summary = aggregator.finish();

  assertWritableFile(summaryPath, 'summaries/all-time.json');
  assertWritableFile(readmePath, 'README.md');
  writeFileSync(summaryPath, JSON.stringify(summary) + '\n');
  writeFileSync(readmePath, render(summary));
  console.error(`audit-publish: ${candidateFiles.length} candidate(s), ${appendedLedger.length} new batch(es), ${existingLedger.length + appendedLedger.length} total batch(es), ${summary.events} event(s)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof LimitError ? 2 : 1;
}
