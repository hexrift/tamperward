// Complete write-authorized transition for the tamperward-audit branch.
// Runs with Node builtins only. The cloned evidence branch is the immutable
// prefix; raw trusted candidates are validated and appended, and both reports
// are derived locally. No replacement store or derived artifact is accepted.
//
// Usage: node audit-publish.mjs <schemaPath> <candidatesDir> <storeDir> <sourceSha>

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAuditSchema, validateAuditJsonl } from './audit-verify.mjs';

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

function summarize(events) {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const rules = new Map();
  const surfaces = new Map();
  const sessions = new Set();
  for (const event of ordered) {
    const bucket = rules.get(event.rule) ?? { events: 0, blocked: 0, warnings: 0 };
    bucket.events++;
    if (event.severity === 'block') bucket.blocked++;
    else bucket.warnings++;
    rules.set(event.rule, bucket);
    surfaces.set(event.surface, (surfaces.get(event.surface) ?? 0) + 1);
    if (event.session) sessions.add(event.session);
  }
  return {
    schema_version: 1,
    events: ordered.length,
    blocked: ordered.filter((event) => event.severity === 'block').length,
    warnings: ordered.filter((event) => event.severity === 'warn').length,
    sessions: sessions.size,
    first_event: ordered[0]?.timestamp ?? null,
    last_event: ordered.at(-1)?.timestamp ?? null,
    by_rule: [...rules.entries()].map(([rule, counts]) => ({ rule, ...counts }))
      .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule)),
    by_surface: [...surfaces.entries()].map(([surface, count]) => ({ surface, events: count }))
      .sort((a, b) => b.events - a.events || a.surface.localeCompare(b.surface)),
    interpretation: 'finding-is-not-proof-of-intent',
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

try {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('audit-publish: source SHA must be 40 lowercase hexadecimal characters');
  const schema = loadAuditSchema(schemaPath);
  const eventsPath = join(storeDir, 'events', 'all.jsonl');
  const ledgerPath = join(storeDir, 'ingested', 'batches.jsonl');
  const summaryPath = join(storeDir, 'summaries', 'all-time.json');
  const readmePath = join(storeDir, 'README.md');
  ensureDirectory(storeDir, 'store');
  ensureDirectory(candidatesDir, 'candidates');
  ensureDirectory(join(storeDir, 'events'), 'events directory');
  ensureDirectory(join(storeDir, 'ingested'), 'ingested directory');
  ensureDirectory(join(storeDir, 'summaries'), 'summaries directory');
  const existingEventsRaw = readStoreFile(eventsPath, 'events/all.jsonl');
  const existingLedgerRaw = readStoreFile(ledgerPath, 'ingested/batches.jsonl');
  const existingEvents = validateAuditJsonl(schema, existingEventsRaw, 'stored event');
  const { entries: existingLedger, byId: ledgerById } = readLedger(existingLedgerRaw);
  const eventById = new Map();
  for (const event of existingEvents) {
    if (eventById.has(event.id)) throw new Error(`audit-publish: duplicate stored audit event id: ${event.id}`);
    eventById.set(event.id, canonical(event));
  }

  const candidateFiles = existsSync(candidatesDir)
    ? readdirSync(candidatesDir).filter((file) => file.endsWith('.jsonl')).sort()
    : [];
  const appendedEventLines = [];
  const appendedEvents = [];
  const appendedLedger = [];
  const ingestedAt = new Date().toISOString();

  for (const file of candidateFiles) {
    const path = join(candidatesDir, file);
    if (!lstatSync(path).isFile()) throw new Error(`audit-publish: candidate is not a regular file: ${file}`);
    const batchId = basename(file, '.jsonl');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(batchId)) throw new Error(`audit-publish: invalid candidate batch id: ${batchId}`);
    const batch = readFileSync(path);
    const raw = batch.toString('utf8');
    if (!raw.trim()) continue;
    const contentSha256 = sha256(batch);
    const prior = ledgerById.get(batchId);
    if (prior) {
      if (prior.content_sha256 !== contentSha256) throw new Error(`audit-publish: batch ${batchId} content changed after ingestion`);
      continue;
    }

    const candidateEvents = validateAuditJsonl(schema, raw, `candidate ${file}`);
    const candidateLines = nonblankLines(raw);
    for (const [index, candidate] of candidateEvents.entries()) {
      const encoded = canonical(candidate);
      const priorEvent = eventById.get(candidate.id);
      if (priorEvent !== undefined && priorEvent !== encoded) {
        throw new Error(`audit-publish: candidate event id conflicts with stored content: ${candidate.id}`);
      }
      if (priorEvent === undefined) {
        eventById.set(candidate.id, encoded);
        appendedEvents.push(candidate);
        appendedEventLines.push(candidateLines[index]);
      }
    }
    const entry = {
      batch_id: batchId,
      source_sha: sourceSha,
      content_sha256: contentSha256,
      schema: 'audit-v1',
      ingested_at: ingestedAt,
      event_count: candidateEvents.length,
    };
    ledgerById.set(batchId, entry);
    appendedLedger.push(entry);
  }

  const allEvents = [...existingEvents, ...appendedEvents];
  const allLedger = [...existingLedger, ...appendedLedger];
  const eventsOutput = append(existingEventsRaw, appendedEventLines);
  const ledgerOutput = append(existingLedgerRaw, appendedLedger.map((entry) => JSON.stringify(entry)));
  const summary = summarize(allEvents);

  assertWritableFile(eventsPath, 'events/all.jsonl');
  assertWritableFile(ledgerPath, 'ingested/batches.jsonl');
  assertWritableFile(summaryPath, 'summaries/all-time.json');
  assertWritableFile(readmePath, 'README.md');
  writeFileSync(eventsPath, eventsOutput);
  writeFileSync(ledgerPath, ledgerOutput);
  writeFileSync(summaryPath, JSON.stringify(summary) + '\n');
  writeFileSync(readmePath, render(summary));
  console.error(`audit-publish: ${candidateFiles.length} candidate(s), ${appendedEvents.length} new event(s), ${allLedger.length} total batch(es)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
