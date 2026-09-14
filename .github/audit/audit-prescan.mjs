// Prescan for the tamperward-audit ingestion workflow. Pure Node, no build:
// it hashes each candidate batch and diffs it against the ingestion ledger on
// the evidence branch to decide which batches are NEW, so an unrelated merge
// (nothing new) exits before the expensive build/validate/ingest steps.
//
// It also enforces batch immutability: a batch id that is already recorded in
// the ledger with a DIFFERENT content hash is a rewrite of evidence that was
// already ingested — fail closed rather than silently re-ingest or overwrite.
//
// Usage: node audit-prescan.mjs <candidatesDir> <ledgerPath> <outListPath>
//   candidatesDir  directory of candidate *.jsonl batch files
//   ledgerPath     ingested/batches.jsonl from the evidence branch (may be empty/absent)
//   outListPath    newline-separated absolute paths of the batches to ingest

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [candidatesDir, ledgerPath, outListPath] = process.argv.slice(2);
if (!candidatesDir || !ledgerPath || !outListPath) {
  console.error('usage: audit-prescan.mjs <candidatesDir> <ledgerPath> <outListPath>');
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** batch_id -> content_sha256 recorded on the evidence branch. */
const ingested = new Map();
if (existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (typeof entry.batch_id !== 'string' || typeof entry.content_sha256 !== 'string') {
      throw new Error('ledger entry is missing batch_id or content_sha256');
    }
    ingested.set(entry.batch_id, entry.content_sha256);
  }
}

const candidates = existsSync(candidatesDir)
  ? readdirSync(candidatesDir).filter((f) => f.endsWith('.jsonl')).sort()
  : [];

const fresh = [];
for (const file of candidates) {
  const path = join(candidatesDir, file);
  const bytes = readFileSync(path);
  // A batch with no non-whitespace content carries no events: not a real batch,
  // never recorded, so an empty or blank file is a clean skip rather than an
  // empty ledger entry.
  if (!/[^\s]/.test(bytes.toString('utf8'))) continue;
  const batchId = basename(file, '.jsonl');
  const hash = sha256(bytes);
  const prior = ingested.get(batchId);
  if (prior !== undefined) {
    if (prior !== hash) {
      throw new Error(
        `batch ${batchId} content changed after ingestion (immutable batches must never be rewritten): ` +
        `ledger ${prior}, present ${hash}`,
      );
    }
    continue; // already ingested, identical content — idempotent skip
  }
  fresh.push(path);
}

writeFileSync(outListPath, fresh.join('\n') + (fresh.length ? '\n' : ''));
console.error(`audit prescan: ${candidates.length} candidate(s), ${fresh.length} new to ingest.`);
