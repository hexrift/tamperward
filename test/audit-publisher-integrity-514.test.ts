import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const verifyScript = resolve(root, '.github', 'audit', 'audit-verify.mjs');
const publishScript = resolve(root, '.github', 'audit', 'audit-publish.mjs');
const schemaPath = resolve(root, 'schemas', 'audit-v1.schema.json');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-publish-'));
  dirs.push(dir);
  return dir;
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'sha256:' + 'a'.repeat(32),
    timestamp: '2026-09-15T00:00:00Z',
    surface: 'stop',
    agent: 'claude-code',
    rule: 'test-skip',
    severity: 'block',
    decision: 'deny',
    ...overrides,
  };
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('dependency-free audit schema validation (#514)', () => {
  it('enforces the schema allOf severity/decision relationship', () => {
    const dir = tempDir();
    const data = join(dir, 'events.jsonl');
    writeFileSync(data, JSON.stringify(event({ decision: 'warn' })) + '\n');

    const result = run(verifyScript, [schemaPath, data]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/decision/);
    expect(result.stderr).toMatch(/"deny"/);
  });

  it('fails closed on unsupported schema keywords at the root and nested levels', () => {
    const dir = tempDir();
    const data = join(dir, 'events.jsonl');
    writeFileSync(data, JSON.stringify(event()) + '\n');
    const original = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

    for (const [name, mutate] of [
      ['root', (schema: Record<string, unknown>) => { schema.oneOf = []; }],
      ['nested', (schema: Record<string, unknown>) => {
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        properties.rule.minLength = 1;
      }],
    ] as const) {
      const schema = structuredClone(original);
      mutate(schema);
      const path = join(dir, `${name}.schema.json`);
      writeFileSync(path, JSON.stringify(schema));

      const result = run(verifyScript, [path, data]);
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toMatch(/unsupported schema keyword/);
    }
  });
});

describe('privileged audit-store transition (#514)', () => {
  it('keeps the legacy prefix immutable, writes an immutable partition, and recomputes derived files', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(join(store, 'summaries'), { recursive: true });
    mkdirSync(candidates);

    const oldEvent = JSON.stringify(event());
    const oldEvents = oldEvent + '\n';
    const oldLedger = JSON.stringify({
      batch_id: 'old-reviewed-batch',
      source_sha: '1'.repeat(40),
      content_sha256: '2'.repeat(64),
      schema: 'audit-v1',
      ingested_at: '2026-09-14T00:00:00.000Z',
      event_count: 1,
    }) + '\n';
    writeFileSync(join(store, 'events', 'all.jsonl'), oldEvents);
    writeFileSync(join(store, 'ingested', 'batches.jsonl'), oldLedger);
    writeFileSync(join(store, 'summaries', 'all-time.json'), '{"forged":true}\n');
    writeFileSync(join(store, 'README.md'), 'arbitrary artifact content\n');

    const newEvent = JSON.stringify(event({
      id: 'sha256:' + 'b'.repeat(32),
      timestamp: '2026-09-15T00:01:00Z',
      surface: 'pretooluse',
      rule: 'lint-suppression',
      severity: 'warn',
      decision: 'warn',
    }));
    const batch = newEvent + '\n';
    writeFileSync(join(candidates, 'reviewed-batch.jsonl'), batch);

    const sourceSha = '3'.repeat(40);
    const result = run(publishScript, [schemaPath, candidates, store, sourceSha]);
    expect(result.status, result.stderr).toBe(0);

    // The legacy monolithic prefix is an immutable partition: byte-for-byte
    // unchanged, never appended to.
    expect(readFileSync(join(store, 'events', 'all.jsonl'), 'utf8')).toBe(oldEvents);

    const ledger = readFileSync(join(store, 'ingested', 'batches.jsonl'), 'utf8');
    expect(ledger.startsWith(oldLedger)).toBe(true);
    const appended = JSON.parse(ledger.slice(oldLedger.length).trim()) as Record<string, string>;
    expect(appended).toMatchObject({
      batch_id: 'reviewed-batch',
      source_sha: sourceSha,
      content_sha256: sha256(batch),
      schema: 'audit-v1',
      event_count: 1,
    });

    // The new batch lands in its own immutable partition keyed by ingest month.
    const month = appended.ingested_at.slice(0, 7).replace('-', '/');
    const partition = join(store, 'events', month, 'reviewed-batch.jsonl');
    expect(readFileSync(partition, 'utf8')).toBe(batch);

    // The id index is sharded by the first two hex characters of the id.
    expect(readFileSync(join(store, 'ids', 'aa.jsonl'), 'utf8')).toContain('sha256:' + 'a'.repeat(32));
    expect(readFileSync(join(store, 'ids', 'bb.jsonl'), 'utf8')).toContain('sha256:' + 'b'.repeat(32));

    const summary = JSON.parse(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')) as Record<string, unknown>;
    expect(summary).toMatchObject({ events: 2, blocked: 1, warnings: 1, sessions: 0 });
    expect(summary).not.toHaveProperty('forged');
    const readme = readFileSync(join(store, 'README.md'), 'utf8');
    expect(readme).toContain('TamperWard audit stats');
    expect(readme).toContain('lint-suppression');
    expect(readme).not.toContain('arbitrary artifact content');
  });

  it('adds a second batch without rewriting the first partition (immutable rollover)', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(join(store, 'summaries'), { recursive: true });
    mkdirSync(candidates);

    const first = JSON.stringify(event({ id: 'sha256:' + 'a'.repeat(32) })) + '\n';
    writeFileSync(join(candidates, 'batch-one.jsonl'), first);
    expect(run(publishScript, [schemaPath, candidates, store, '1'.repeat(40)]).status).toBe(0);

    const ledgerOne = readFileSync(join(store, 'ingested', 'batches.jsonl'), 'utf8');
    const monthOne = (JSON.parse(ledgerOne.trim()) as Record<string, string>).ingested_at.slice(0, 7).replace('-', '/');
    const partitionOne = join(store, 'events', monthOne, 'batch-one.jsonl');
    const partitionOneBytes = readFileSync(partitionOne, 'utf8');
    expect(partitionOneBytes).toBe(first);

    // Ingest a second, distinct batch.
    rmSync(join(candidates, 'batch-one.jsonl'));
    const second = JSON.stringify(event({ id: 'sha256:' + 'b'.repeat(32), rule: 'assertion-weakening', severity: 'warn', decision: 'warn' })) + '\n';
    writeFileSync(join(candidates, 'batch-two.jsonl'), second);
    expect(run(publishScript, [schemaPath, candidates, store, '2'.repeat(40)]).status).toBe(0);

    // The first partition file is untouched; the second lives in its own file.
    expect(readFileSync(partitionOne, 'utf8')).toBe(partitionOneBytes);
    const partitionTwo = join(store, 'events', monthOne, 'batch-two.jsonl');
    expect(readFileSync(partitionTwo, 'utf8')).toBe(second);
    const summary = JSON.parse(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')) as Record<string, unknown>;
    expect(summary).toMatchObject({ events: 2 });
  });

  it('refuses conflicting event ids without rewriting any store file', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(join(store, 'summaries'), { recursive: true });
    mkdirSync(candidates);

    const oldEvents = JSON.stringify(event()) + '\n';
    const oldLedger = '';
    const oldSummary = '{"sentinel":true}\n';
    const oldReadme = 'sentinel\n';
    writeFileSync(join(store, 'events', 'all.jsonl'), oldEvents);
    writeFileSync(join(store, 'ingested', 'batches.jsonl'), oldLedger);
    writeFileSync(join(store, 'summaries', 'all-time.json'), oldSummary);
    writeFileSync(join(store, 'README.md'), oldReadme);
    writeFileSync(join(candidates, 'reviewed-batch.jsonl'), JSON.stringify(event({ rule: 'different-content' })) + '\n');

    const result = run(publishScript, [schemaPath, candidates, store, '3'.repeat(40)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/conflicts with stored content/);
    expect(readFileSync(join(store, 'events', 'all.jsonl'), 'utf8')).toBe(oldEvents);
    expect(readFileSync(join(store, 'ingested', 'batches.jsonl'), 'utf8')).toBe(oldLedger);
    expect(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')).toBe(oldSummary);
    expect(readFileSync(join(store, 'README.md'), 'utf8')).toBe(oldReadme);
  });

  it('refuses a repeated batch id with replacement content', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(candidates);
    writeFileSync(join(store, 'events', 'all.jsonl'), '');
    writeFileSync(join(store, 'ingested', 'batches.jsonl'), JSON.stringify({
      batch_id: 'reviewed-batch',
      source_sha: '1'.repeat(40),
      content_sha256: '2'.repeat(64),
      schema: 'audit-v1',
      ingested_at: '2026-09-14T00:00:00.000Z',
      event_count: 1,
    }) + '\n');
    writeFileSync(join(candidates, 'reviewed-batch.jsonl'), JSON.stringify(event()) + '\n');

    const result = run(publishScript, [schemaPath, candidates, store, '3'.repeat(40)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/content changed after ingestion/);
  });

  it('refuses evidence-store symlinks before reading or writing through them', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    const outside = join(dir, 'outside.jsonl');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(join(store, 'summaries'), { recursive: true });
    mkdirSync(candidates);
    writeFileSync(outside, 'sentinel\n');
    symlinkSync(outside, join(store, 'events', 'all.jsonl'));

    const result = run(publishScript, [schemaPath, candidates, store, '3'.repeat(40)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/events\/all\.jsonl is not a regular file/);
    expect(readFileSync(outside, 'utf8')).toBe('sentinel\n');
  });

  it('reads a legacy monolithic store (events/all.jsonl, no partitions or index)', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(candidates);

    // A pre-partition store: two events in events/all.jsonl, no ids/ index and
    // no summaries/ directory at all.
    const legacyEvents =
      JSON.stringify(event({ id: 'sha256:' + 'a'.repeat(32) })) + '\n' +
      JSON.stringify(event({ id: 'sha256:' + 'c'.repeat(32), rule: 'guard-removal', severity: 'warn', decision: 'warn' })) + '\n';
    writeFileSync(join(store, 'events', 'all.jsonl'), legacyEvents);

    const batch = JSON.stringify(event({ id: 'sha256:' + 'b'.repeat(32), surface: 'pretooluse' })) + '\n';
    writeFileSync(join(candidates, 'new-batch.jsonl'), batch);

    const result = run(publishScript, [schemaPath, candidates, store, '4'.repeat(40)]);
    expect(result.status, result.stderr).toBe(0);

    // The legacy prefix is preserved and its events are counted in the summary
    // alongside the new partitioned batch: 2 legacy + 1 new = 3.
    expect(readFileSync(join(store, 'events', 'all.jsonl'), 'utf8')).toBe(legacyEvents);
    const summary = JSON.parse(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')) as Record<string, unknown>;
    expect(summary).toMatchObject({ events: 3, blocked: 2, warnings: 1 });

    // Migration indexed the legacy ids so a later same-id/different-content
    // candidate is still rejected across the shard boundary.
    rmSync(join(candidates, 'new-batch.jsonl'));
    writeFileSync(join(candidates, 'collide.jsonl'), JSON.stringify(event({ id: 'sha256:' + 'c'.repeat(32), rule: 'test-deletion' })) + '\n');
    const conflict = run(publishScript, [schemaPath, candidates, store, '5'.repeat(40)]);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toMatch(/conflicts with stored content/);
  });

  it('rejects an oversize batch with an actionable exit-2 diagnostic', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const candidates = join(dir, 'candidates');
    mkdirSync(join(store, 'events'), { recursive: true });
    mkdirSync(join(store, 'ingested'), { recursive: true });
    mkdirSync(candidates);

    // A single event line far over the 64 KiB line limit: an oversize line
    // padded with a huge (schema-invalid) field would also fail validation, so
    // exceed the limit with a valid-shaped but enormous line via a long rule?
    // Rules are length-capped, so instead exceed the whole-batch byte limit with
    // many valid events. Simpler and deterministic: one 70 KiB line.
    const giant = '{"schema_version":1,"id":"sha256:' + 'a'.repeat(32) + '","padding":"' + 'x'.repeat(70 * 1024) + '"}\n';
    writeFileSync(join(candidates, 'giant.jsonl'), giant);

    const result = run(publishScript, [schemaPath, candidates, store, '6'.repeat(40)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/exceeds the \d+-byte limit/);
  });
});
