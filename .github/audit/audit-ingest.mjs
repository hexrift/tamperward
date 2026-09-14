// Ingest step for the tamperward-audit workflow. Appends the events of each new
// batch to events/all.jsonl (deduplicated by event id, with the same conflicting-
// id guard the store has always enforced) and records one ledger entry per batch
// in ingested/batches.jsonl — {batch_id, source_sha, content_sha256, schema,
// ingested_at, event_count} — so repeated push runs are idempotent and the source
// commit and content hash of every ingested batch are auditable.
//
// Usage: node audit-ingest.mjs <newListPath> <eventsPath> <ledgerPath> <sourceSha>

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [newListPath, eventsPath, ledgerPath, sourceSha] = process.argv.slice(2);
if (!newListPath || !eventsPath || !ledgerPath || !sourceSha) {
  console.error('usage: audit-ingest.mjs <newListPath> <eventsPath> <ledgerPath> <sourceSha>');
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean) : []);

// Existing events, indexed by id, with the store's conflicting-content guard.
const existingEvents = readLines(eventsPath);
const byId = new Map();
for (const line of existingEvents) {
  const value = JSON.parse(line);
  if (typeof value.id !== 'string') throw new Error('stored audit event is missing id');
  const prior = byId.get(value.id);
  if (prior !== undefined && prior !== line) throw new Error('stored audit event id has conflicting content: ' + value.id);
  byId.set(value.id, line);
}

// Existing ledger, so a batch id is never recorded twice (prescan already
// filtered, but the ingest guards independently).
const existingLedger = readLines(ledgerPath);
const ledgerIds = new Set(existingLedger.map((line) => JSON.parse(line).batch_id));

const batches = readLines(newListPath);
const appendedEvents = [];
const appendedLedger = [];
for (const path of batches) {
  const bytes = readFileSync(path);
  const batchId = basename(path, '.jsonl');
  if (ledgerIds.has(batchId)) continue; // idempotent guard
  const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const value = JSON.parse(line);
    if (typeof value.id !== 'string') throw new Error('submitted audit event is missing id');
    const prior = byId.get(value.id);
    if (prior !== undefined && prior !== line) throw new Error('submitted audit event id conflicts with stored content: ' + value.id);
    if (prior === undefined) {
      byId.set(value.id, line);
      appendedEvents.push(line);
    }
  }
  ledgerIds.add(batchId);
  appendedLedger.push(JSON.stringify({
    batch_id: batchId,
    source_sha: sourceSha,
    content_sha256: sha256(bytes),
    schema: 'audit-v1',
    ingested_at: new Date().toISOString(),
    event_count: lines.length,
  }));
}

writeFileSync(eventsPath, [...existingEvents, ...appendedEvents].join('\n') + '\n');
writeFileSync(ledgerPath, [...existingLedger, ...appendedLedger].join('\n') + '\n');
console.error(`audit ingest: ${batches.length} batch(es), ${appendedEvents.length} new event(s), ${appendedLedger.length} ledger entr(ies).`);
