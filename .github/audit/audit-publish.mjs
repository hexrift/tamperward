// Complete write-authorized transition for the tamperward-audit branch.
// Runs with Node builtins only. The cloned evidence branch is the immutable
// prefix: every stored partition, the frozen v1 file and the ledger are only
// ever added to. Raw trusted candidates are validated and each becomes its own
// immutable partition file; the id and session shards its events hash into
// are updated; the fold state and both reports are derived locally. No
// replacement store or prepared derived artifact is accepted: derived state
// that does not agree with the ledger is rebuilt from the partitions.
//
// Usage: node audit-publish.mjs <schemaPath> <candidatesDir> <storeDir> <sourceSha>
//          [--rebuild] [--changed-paths <file>]
//   --rebuild        stream every stored partition and regenerate shards and state
//                    before ingesting (also what happens when the state is unusable)
//   --changed-paths  write the store-relative paths this run created, rewrote or
//                    deleted, one per line, for the caller to stage
// Exit 0: done (possibly nothing new). Exit 1: integrity refusal, nothing
// written. Exit 2: a hard limit exceeded or bad usage, nothing written.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAuditSchema, validateAuditJsonl } from './audit-verify.mjs';
import {
  LIMITS,
  LimitError,
  Shards,
  canonical,
  emptyState,
  ensureDirectory,
  foldEvent,
  parseState,
  partitionFileCount,
  paths,
  readLedger,
  readTextIfPresent,
  rebuild,
  refuseSymlink,
  renderSummary,
  sha256,
  stateIsConsistent,
  summaryFromState,
} from './audit-store.mjs';

const positional = [];
const options = { rebuild: false, changedPaths: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--rebuild') options.rebuild = true;
  else if (argv[i] === '--changed-paths') options.changedPaths = argv[++i];
  else positional.push(argv[i]);
}
const [schemaPath, candidatesDir, storeDir, sourceSha] = positional;
if (!schemaPath || !candidatesDir || !storeDir || !sourceSha || positional.length !== 4 || (options.changedPaths === undefined)) {
  console.error('usage: audit-publish.mjs <schemaPath> <candidatesDir> <storeDir> <sourceSha> [--rebuild] [--changed-paths <file>]');
  process.exit(2);
}

const nonblankLines = (raw) => raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

/** The ingestion instant: the clock, or the value a test pins through the environment. */
function ingestionInstant() {
  const pinned = process.env.TAMPERWARD_AUDIT_INGESTED_AT;
  if (pinned !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pinned) || !Number.isFinite(Date.parse(pinned))) {
      throw new Error('audit-publish: TAMPERWARD_AUDIT_INGESTED_AT must be an ISO-8601 UTC instant with milliseconds');
    }
    return pinned;
  }
  return new Date().toISOString();
}

try {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('audit-publish: source SHA must be 40 lowercase hexadecimal characters');
  const schema = loadAuditSchema(schemaPath);
  const validateEvent = (line, where) => validateAuditJsonl(schema, line, where)[0];

  ensureDirectory(storeDir, 'store');
  ensureDirectory(candidatesDir, 'candidates');
  for (const dir of ['events', 'ingested', 'summaries', 'ids', 'sessions']) ensureDirectory(join(storeDir, dir), `${dir} directory`);
  const ledgerPath = join(storeDir, paths.ledger);
  const statePath = join(storeDir, paths.state);
  const summaryPath = join(storeDir, paths.summary);
  const readmePath = join(storeDir, paths.readme);
  for (const [path, label] of [[ledgerPath, paths.ledger], [statePath, paths.state], [summaryPath, paths.summary], [readmePath, paths.readme]]) {
    refuseSymlink(path, label);
  }

  const existingLedgerRaw = readTextIfPresent(ledgerPath, paths.ledger);
  const ledger = readLedger(existingLedgerRaw);

  // ---- derived state: fold forward when it agrees with the ledger, else rebuild.
  let state = options.rebuild ? null : parseState(readTextIfPresent(statePath, paths.state));
  let rebuiltShards = [];
  let staleShards = [];
  let rebuilt = false;
  if (options.rebuild || !stateIsConsistent(storeDir, state, ledger)) {
    const hasEvents = existsSync(join(storeDir, paths.legacyEvents)) || ledger.entries.some((entry) => entry.partition);
    if (hasEvents || options.rebuild) {
      const tmp = join(tmpdir(), `tamperward-audit-rebuild-${process.pid}`);
      ({ state, shards: rebuiltShards, removed: staleShards } = rebuild(storeDir, ledger, validateEvent, tmp));
      rebuilt = true;
    } else {
      state = emptyState();
    }
  }
  const shards = new Shards(storeDir);
  // A rebuild replaces every shard: seed the lazy loader from the regenerated
  // content so ingestion below never reads a stale shard from disk. A shard the
  // partitions no longer account for is seeded empty here and deleted in the
  // write phase, so a candidate that hashes into it is judged against the
  // rebuilt truth, never against the stale file.
  for (const rel of staleShards) {
    if (rel.startsWith('ids/')) shards.ids.set(rel, new Map());
    else shards.sessions.set(rel, new Set());
  }
  for (const shard of rebuiltShards) {
    if (shard.rel.startsWith('ids/')) {
      const map = new Map();
      for (const line of nonblankLines(shard.content)) {
        const entry = JSON.parse(line);
        map.set(entry.id, entry.content_sha256);
      }
      shards.ids.set(shard.rel, map);
    } else {
      shards.sessions.set(shard.rel, new Set(nonblankLines(shard.content)));
    }
    shards.touched.add(shard.rel);
  }

  // ---- candidates: validate everything before anything is written.
  const candidateFiles = existsSync(candidatesDir)
    ? readdirSync(candidatesDir).filter((file) => file.endsWith('.jsonl')).sort()
    : [];
  const ingestedAt = ingestionInstant();
  const partitionDir = paths.partitionDir(ingestedAt);
  let partitionFiles = partitionFileCount(ledger, partitionDir);
  const newPartitions = [];
  const appendedLedger = [];
  let newEvents = 0;

  for (const file of candidateFiles) {
    const path = join(candidatesDir, file);
    if (!lstatSync(path).isFile()) throw new Error(`audit-publish: candidate is not a regular file: ${file}`);
    const batchId = basename(file, '.jsonl');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(batchId)) throw new Error(`audit-publish: invalid candidate batch id: ${batchId}`);
    const size = statSync(path).size;
    if (size > LIMITS.maxBatchBytes) {
      throw new LimitError(`audit-publish: candidate ${file} is ${size} bytes; the batch limit is ${LIMITS.maxBatchBytes} bytes — split it into smaller batches`);
    }
    const batch = readFileSync(path);
    const raw = batch.toString('utf8');
    if (!raw.trim()) continue;
    const contentSha256 = sha256(batch);
    const prior = ledger.byId.get(batchId);
    if (prior) {
      if (prior.content_sha256 !== contentSha256) throw new Error(`audit-publish: batch ${batchId} content changed after ingestion`);
      continue; // already ingested with identical content: idempotent skip
    }

    const candidateLines = nonblankLines(raw);
    if (candidateLines.length > LIMITS.maxBatchEvents) {
      throw new LimitError(`audit-publish: candidate ${file} holds ${candidateLines.length} events; the batch limit is ${LIMITS.maxBatchEvents} — split it into smaller batches`);
    }
    for (const [index, line] of candidateLines.entries()) {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > LIMITS.maxLineBytes) {
        throw new LimitError(`audit-publish: candidate ${file} event ${index + 1} is ${bytes} bytes; the event line limit is ${LIMITS.maxLineBytes} bytes`);
      }
    }
    if (partitionFiles >= LIMITS.maxFilesPerPartition) {
      throw new LimitError(`audit-publish: partition ${partitionDir} already holds ${partitionFiles} batch files; the limit is ${LIMITS.maxFilesPerPartition} per month — ingest after the month rolls over or raise the limit deliberately`);
    }

    const candidateEvents = validateAuditJsonl(schema, raw, `candidate ${file}`);
    const storedLines = [];
    for (const [index, candidate] of candidateEvents.entries()) {
      if (!shards.addId(candidate.id, sha256(canonical(candidate)), `candidate ${file} event ${index + 1}`)) continue;
      const newSession = candidate.session ? shards.addSession(candidate.session) : false;
      foldEvent(state, candidate, newSession);
      storedLines.push(candidateLines[index]);
      newEvents++;
    }
    const stored = storedLines.length ? storedLines.join('\n') + '\n' : '';
    const partition = paths.partition(ingestedAt, batchId);
    newPartitions.push({ rel: partition, content: stored });
    partitionFiles++;
    const entry = {
      batch_id: batchId,
      source_sha: sourceSha,
      content_sha256: contentSha256,
      schema: 'audit-v1',
      ingested_at: ingestedAt,
      event_count: candidateEvents.length,
      partition,
      stored_events: storedLines.length,
      stored_sha256: sha256(stored),
    };
    ledger.byId.set(batchId, entry);
    ledger.entries.push(entry);
    appendedLedger.push(entry);
  }

  // ---- write phase: only new files, touched shards, the ledger tail and the derived files.
  const changed = [];
  const write = (rel, content) => {
    const path = join(storeDir, rel);
    refuseSymlink(path, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
    writeFileSync(path, content);
    changed.push(rel);
  };
  for (const rel of staleShards) {
    const path = join(storeDir, rel);
    refuseSymlink(path, rel);
    rmSync(path, { force: true });
    changed.push(rel);
  }
  for (const partition of newPartitions) {
    if (existsSync(join(storeDir, partition.rel))) throw new Error(`audit-publish: partition ${partition.rel} already exists`);
    write(partition.rel, partition.content);
  }
  for (const shard of shards.changes()) write(shard.rel, shard.content);
  if (appendedLedger.length) {
    const separator = existingLedgerRaw.length > 0 && !existingLedgerRaw.endsWith('\n') ? '\n' : '';
    write(paths.ledger, existingLedgerRaw + separator + appendedLedger.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  const summary = summaryFromState(state);
  write(paths.state, JSON.stringify(state) + '\n');
  write(paths.summary, JSON.stringify(summary) + '\n');
  write(paths.readme, renderSummary(summary));
  if (options.changedPaths) writeFileSync(options.changedPaths, changed.map((rel) => rel + '\n').join(''));
  console.error(
    `audit-publish: ${candidateFiles.length} candidate(s), ${appendedLedger.length} new batch(es), ${newEvents} new event(s), ` +
    `${ledger.entries.length} total batch(es), ${state.events} stored event(s)${rebuilt ? ', derived state rebuilt from the partitions' : ''}` +
    (staleShards.length ? `, ${staleShards.length} stale shard file(s) removed` : ''),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof LimitError ? 2 : 1;
}
