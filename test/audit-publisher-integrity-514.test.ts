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
  it('preserves published bytes, appends verified evidence, and recomputes derived files', () => {
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

    // The frozen v1 file keeps its published bytes; the batch becomes its own
    // immutable partition file named by the ledger (#518).
    expect(readFileSync(join(store, 'events', 'all.jsonl'), 'utf8')).toBe(oldEvents);

    const ledger = readFileSync(join(store, 'ingested', 'batches.jsonl'), 'utf8');
    expect(ledger.startsWith(oldLedger)).toBe(true);
    const appended = JSON.parse(ledger.slice(oldLedger.length).trim()) as Record<string, unknown> & { partition: string };
    expect(appended).toMatchObject({
      batch_id: 'reviewed-batch',
      source_sha: sourceSha,
      content_sha256: sha256(batch),
      schema: 'audit-v1',
      event_count: 1,
      stored_events: 1,
      stored_sha256: sha256(batch),
    });
    expect(appended.partition).toMatch(/^events\/\d{4}\/\d{2}\/reviewed-batch\.jsonl$/);
    expect(readFileSync(join(store, appended.partition), 'utf8')).toBe(batch);

    const summary = JSON.parse(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')) as Record<string, unknown>;
    expect(summary).toMatchObject({ events: 2, blocked: 1, warnings: 1, sessions: 0 });
    expect(summary).not.toHaveProperty('forged');
    const readme = readFileSync(join(store, 'README.md'), 'utf8');
    expect(readme).toContain('TamperWard audit stats');
    expect(readme).toContain('lint-suppression');
    expect(readme).not.toContain('arbitrary artifact content');
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
});
