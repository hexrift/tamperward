// Reproducible, provenance-checked research bundles (#481).
// The archive contains records and derived readouts, never workspaces or locks.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MACHINE_SCHEMA_VERSION } from '../machine-output';
import { ResearchError } from './adapter';
import { readPairFiles } from './ledger-files';
import { portablePairRecordFrom, type PairRecord } from './record';
import { renderResearchReport } from './report';
import { summarizeRecords } from './summarize';

const BLOCK = 512;
const BUNDLE_VERSION = 1;

/** The entries a bundle may hold besides `ledger/pairs/<name>.json`: anything else
 *  in an archive is refused by the validator, so "valid" means "holds nothing but
 *  the evidence it claims to" (#663). */
const TOP_LEVEL_ENTRIES = new Set(['summary.json', 'report.txt', 'provenance.json', 'manifest.json']);
const PAIR_ENTRY_RE = /^ledger\/pairs\/[^/]+\.json$/;

interface Entry { name: string; bytes: Buffer }

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarEntry(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const safe = name.replace(/^\/+/, '').slice(0, 99);
  header.write(safe, 0, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(bytes.length, 12), 124, 'ascii');
  // Fixed mtime keeps the archive bytes reproducible for the same records and
  // provenance; wall-clock creation time is not research evidence.
  header.write(octal(0, 12), 136, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, b) => sum + b, 0);
  header.write(octal(checksum, 8), 148, 'ascii');
  const padding = Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([header, bytes, padding]);
}

function makeTar(entries: Entry[]): Buffer {
  return Buffer.concat([...entries.map((e) => tarEntry(e.name, e.bytes)), Buffer.alloc(BLOCK * 2, 0)]);
}

function parseTar(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + BLOCK <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!name || name.startsWith('/') || name.split('/').includes('..') || !Number.isSafeInteger(size) || size < 0) {
      throw new ResearchError('research bundle contains an unsafe or malformed archive entry');
    }
    const start = offset + BLOCK;
    const end = start + size;
    if (end > bytes.length) throw new ResearchError('research bundle is truncated');
    if (files.has(name)) throw new ResearchError(`research bundle contains a duplicate archive entry ${name}`);
    files.set(name, Buffer.from(bytes.subarray(start, end)));
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/** The pair records a bundle carries, read once through the hardened ledger
 *  reader (#663): only a regular file placed directly in pairs/ is read, every
 *  record is proved to carry nothing outside the v1 pair contract, and the
 *  archive holds the canonical serialization of the proved record rather than
 *  the file's raw bytes, so a duplicate key or stray bytes cannot travel either. */
function packagedRecords(ledger: string): { records: PairRecord[]; entries: Entry[] } {
  const files = readPairFiles(ledger);
  if (files.length === 0) throw new ResearchError(`ledger ${ledger} holds no pair records`);
  const records: PairRecord[] = [];
  const entries: Entry[] = [];
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(f.bytes.toString('utf8'));
    } catch (e) {
      throw new ResearchError(`ledger record ${f.path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const record = portablePairRecordFrom(raw, f.path);
    records.push(record);
    entries.push({ name: `ledger/pairs/${f.name}`, bytes: jsonBytes(record) });
  }
  return { records, entries };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export interface ResearchBundleOpts {
  ledger: string;
  out?: string;
  manifest?: string;
  validate?: string;
}

export function validateResearchBundle(path: string): { records: number; manifest_sha256: string } {
  let files: Map<string, Buffer>;
  try { files = parseTar(gunzipSync(readFileSync(resolve(path)))); }
  catch (e) { throw new ResearchError(`cannot read research bundle ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  for (const name of files.keys()) {
    if (!TOP_LEVEL_ENTRIES.has(name) && !PAIR_ENTRY_RE.test(name)) {
      throw new ResearchError(`research bundle carries an entry that is not evidence: ${name}`);
    }
  }
  const provenance = files.get('provenance.json');
  const summaryBytes = files.get('summary.json');
  const report = files.get('report.txt');
  if (!provenance || !summaryBytes || !report) throw new ResearchError('research bundle is missing provenance.json, summary.json or report.txt');
  let p: Record<string, unknown>;
  let summary: unknown;
  try { p = JSON.parse(provenance.toString('utf8')); summary = JSON.parse(summaryBytes.toString('utf8')); }
  catch { throw new ResearchError('research bundle contains invalid JSON'); }
  if (p.bundle_schema_version !== BUNDLE_VERSION || p.schema_version !== MACHINE_SCHEMA_VERSION) {
    throw new ResearchError('research bundle schema version is unsupported');
  }
  const manifest = files.get('manifest.json');
  if (p.manifest_included !== Boolean(manifest) || p.prompts_included !== Boolean(manifest)) {
    throw new ResearchError('research bundle manifest inclusion metadata is inconsistent');
  }
  if (manifest && createHash('sha256').update(manifest).digest('hex') !== p.manifest_sha256) {
    throw new ResearchError('research bundle manifest does not match its recorded sha256');
  }
  const parsedSummary = summary as Record<string, unknown>;
  if (parsedSummary.document !== 'summary' || parsedSummary.command !== 'research') throw new ResearchError('research bundle summary is not a research summary');
  const records: PairRecord[] = [];
  for (const [name, bytes] of files) {
    if (!PAIR_ENTRY_RE.test(name)) continue;
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new ResearchError(`invalid JSON in ${name}`); }
    const record = portablePairRecordFrom(raw, name);
    // The archive must hold exactly the canonical serialization of the record it
    // proves: no duplicate key, no stray whitespace, nothing the reader ignores.
    if (!bytes.equals(jsonBytes(record))) throw new ResearchError(`${name} is not the canonical serialization of its pair record`);
    records.push(record);
  }
  if (records.length === 0) throw new ResearchError('research bundle contains no pair records');
  const derived = summarizeRecords(records);
  if (JSON.stringify(derived) !== JSON.stringify(summary)) throw new ResearchError('research bundle summary does not match its pair records');
  if (report.toString('utf8') !== renderResearchReport(derived)) throw new ResearchError('research bundle report does not match its summary');
  if (p.manifest_sha256 !== parsedSummary.manifest_sha256) throw new ResearchError('research bundle manifest hash disagrees with summary');
  if (!p.protocol || p.protocol !== 'research-bundle-v1') throw new ResearchError('research bundle protocol is missing or unsupported');
  return { records: records.length, manifest_sha256: String(p.manifest_sha256) };
}

export function createResearchBundle(opts: ResearchBundleOpts): string {
  if (!opts.ledger) throw new ResearchError('research bundle requires --ledger');
  if (!opts.out) throw new ResearchError('research bundle requires --out');
  const ledger = resolve(opts.ledger);
  const { records, entries } = packagedRecords(ledger);
  const summary = summarizeRecords(records);
  if (opts.manifest) {
    const manifest = readFileSync(resolve(opts.manifest));
    const sha = createHash('sha256').update(manifest).digest('hex');
    if (sha !== summary.manifest_sha256) throw new ResearchError(`manifest sha256 ${sha} does not match ledger ${summary.manifest_sha256}`);
    entries.push({ name: 'manifest.json', bytes: manifest });
  }
  const provenance = {
    bundle_schema_version: BUNDLE_VERSION,
    protocol: 'research-bundle-v1',
    schema_version: MACHINE_SCHEMA_VERSION,
    manifest_sha256: summary.manifest_sha256,
    adapter: summary.adapter,
    model: summary.model,
    tamperward_version: summary.tamperward_version,
    agent_argv: summary.agent_argv,
    agent_budget: summary.agent_budget,
    records: entries.filter((e) => e.name.startsWith('ledger/pairs/')).length,
    manifest_included: Boolean(opts.manifest),
    prompts_included: Boolean(opts.manifest),
  };
  entries.push({ name: 'summary.json', bytes: jsonBytes(summary) });
  entries.push({ name: 'report.txt', bytes: Buffer.from(renderResearchReport(summary), 'utf8') });
  entries.push({ name: 'provenance.json', bytes: jsonBytes(provenance) });
  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, gzipSync(makeTar(entries)), { flag: 'wx', mode: 0o600 });
  return out;
}

export function runResearchBundle(opts: ResearchBundleOpts): number {
  try {
    if (opts.validate) {
      const result = validateResearchBundle(opts.validate);
      process.stdout.write(`tamperward research bundle: valid (${result.records} records, manifest ${result.manifest_sha256})\n`);
      return 0;
    }
    const out = createResearchBundle(opts);
    process.stdout.write(`tamperward research bundle: wrote ${out}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ResearchError || e instanceof Error) {
      process.stderr.write(`tamperward research: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
