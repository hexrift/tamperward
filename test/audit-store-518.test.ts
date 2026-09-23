// The partitioned evidence store (#518): one immutable file per ingested batch,
// sharded id/session indexes updated only where a batch touches them, and a
// fold state that derives the all-time summary without re-reading history.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseAuditJsonl, summarizeAudit } from '../src/cli/audit';

const root = resolve(__dirname, '..');
const publishScript = resolve(root, '.github', 'audit', 'audit-publish.mjs');
const schemaPath = resolve(root, 'schemas', 'audit-v1.schema.json');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-store-'));
  dirs.push(dir);
  return dir;
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

type Event = Record<string, unknown>;

function event(n: number, overrides: Event = {}): Event {
  return {
    schema_version: 1,
    id: 'sha256:' + hex(n, 32),
    timestamp: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:00:00Z`,
    surface: n % 3 === 0 ? 'stop' : 'pretooluse',
    agent: 'claude-code',
    rule: ['test-skip', 'test-deletion', 'lint-suppression'][n % 3],
    severity: n % 2 === 0 ? 'block' : 'warn',
    decision: n % 2 === 0 ? 'deny' : 'warn',
    session: 'sha256:' + hex(n % 7, 24),
    ...overrides,
  };
}

const lines = (events: Event[]): string => events.map((e) => JSON.stringify(e) + '\n').join('');

function publish(
  store: string,
  candidates: string,
  opts: { sourceSha?: string; ingestedAt?: string; rebuild?: boolean; changed?: string } = {},
) {
  const args = [publishScript, schemaPath, candidates, store, opts.sourceSha ?? '3'.repeat(40)];
  if (opts.rebuild) args.push('--rebuild');
  if (opts.changed) args.push('--changed-paths', opts.changed);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, TAMPERWARD_AUDIT_INGESTED_AT: opts.ingestedAt ?? '2026-09-23T12:00:00.000Z' },
  });
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dir, path), readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

/** A store as the pre-#518 publisher left it: one frozen file, a v1 ledger entry, derived files. */
function legacyStore(): { store: string; stored: Event[] } {
  const store = join(tempDir(), 'store');
  for (const dir of ['events', 'ingested', 'summaries']) mkdirSync(join(store, dir), { recursive: true });
  const stored = [event(1), event(2), event(3)];
  writeFileSync(join(store, 'events', 'all.jsonl'), lines(stored));
  writeFileSync(join(store, 'ingested', 'batches.jsonl'), JSON.stringify({
    batch_id: 'legacy-batch',
    source_sha: '1'.repeat(40),
    content_sha256: '2'.repeat(64),
    schema: 'audit-v1',
    ingested_at: '2026-09-14T00:00:00.000Z',
    event_count: 3,
  }) + '\n');
  writeFileSync(join(store, 'summaries', 'all-time.json'), '{"forged":true}\n');
  writeFileSync(join(store, 'README.md'), 'arbitrary artifact content\n');
  return { store, stored };
}

function candidates(batches: Record<string, string>): string {
  const dir = join(tempDir(), 'candidates');
  mkdirSync(dir);
  for (const [id, content] of Object.entries(batches)) writeFileSync(join(dir, `${id}.jsonl`), content);
  return dir;
}

const summaryOf = (store: string) => JSON.parse(readFileSync(join(store, 'summaries', 'all-time.json'), 'utf8')) as Record<string, unknown>;
const ledgerOf = (store: string) => readFileSync(join(store, 'ingested', 'batches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown> & { partition?: string });

describe('partitioned evidence store (#518)', () => {
  it('migrates a v1 store in place: the frozen file is untouched, the batch becomes a partition, shards and state are derived', () => {
    const { store, stored } = legacyStore();
    const frozen = readFileSync(join(store, 'events', 'all.jsonl'), 'utf8');
    const fresh = event(4);
    const batch = lines([event(2), fresh]); // event 2 is already stored with identical content
    const changed = join(tempDir(), 'changed.txt');
    const result = publish(store, candidates({ 'batch-a': batch }), { changed });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('derived state rebuilt from the partitions');

    expect(readFileSync(join(store, 'events', 'all.jsonl'), 'utf8')).toBe(frozen);
    const [legacy, entry] = ledgerOf(store);
    expect(legacy).not.toHaveProperty('partition');
    expect(entry).toMatchObject({
      batch_id: 'batch-a',
      event_count: 2,
      stored_events: 1,
      partition: 'events/2026/09/batch-a.jsonl',
      content_sha256: sha256(batch),
      stored_sha256: sha256(lines([fresh])),
    });
    expect(readFileSync(join(store, entry.partition!), 'utf8')).toBe(lines([fresh]));

    const summary = summaryOf(store);
    expect(summary).toEqual(summarizeAudit(parseAuditJsonl(lines([...stored, fresh]))));
    expect(summary).not.toHaveProperty('forged');
    expect(readFileSync(join(store, 'README.md'), 'utf8')).toContain('TamperWard audit stats');

    const state = JSON.parse(readFileSync(join(store, 'summaries', 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(state).toMatchObject({ schema: 'audit-store-state-v1', events: 4, legacy_events: 3, legacy_bytes: statSync(join(store, 'events', 'all.jsonl')).size });

    for (const e of [...stored, fresh]) {
      const id = e.id as string;
      const shard = readFileSync(join(store, 'ids', `${id.slice(7, 9)}.jsonl`), 'utf8');
      expect(shard).toContain(`"id":"${id}"`);
      const session = e.session as string;
      expect(readFileSync(join(store, 'sessions', `${session.slice(7, 9)}.txt`), 'utf8')).toContain(session + '\n');
    }
    const written = readFileSync(changed, 'utf8').trim().split('\n');
    expect(written).toContain('events/2026/09/batch-a.jsonl');
    expect(written).toContain('ingested/batches.jsonl');
    expect(written).toContain('summaries/state.json');
    expect(written).toContain('summaries/all-time.json');
    expect(written).toContain('README.md');
    expect(written).not.toContain('events/all.jsonl');
  });

  it('is idempotent: the same candidates again change nothing and stage nothing', () => {
    const { store } = legacyStore();
    const batches = { 'batch-a': lines([event(4)]) };
    expect(publish(store, candidates(batches)).status).toBe(0);
    const before = snapshot(store);
    const changed = join(tempDir(), 'changed.txt');
    const result = publish(store, candidates(batches), { changed });
    expect(result.status, result.stderr).toBe(0);
    expect(changedBetween(before, snapshot(store))).toEqual([]);
    expect(readFileSync(changed, 'utf8')).toBe('');
  });

  it('adds a batch without rewriting history: a new month starts a new partition and only touched shards change', () => {
    const { store } = legacyStore();
    expect(publish(store, candidates({ 'batch-a': lines([event(4)]) })).status).toBe(0);
    const before = snapshot(store);
    const later = [event(5), event(6)];
    const result = publish(store, candidates({ 'batch-b': lines(later) }), { ingestedAt: '2026-10-02T08:30:00.000Z' });
    expect(result.status, result.stderr).toBe(0);
    const after = snapshot(store);

    const changed = changedBetween(before, after);
    expect(changed).toContain('events/2026/10/batch-b.jsonl');
    expect(after.get('events/2026/10/batch-b.jsonl')).toBe(lines(later));
    for (const rel of ['events/all.jsonl', 'events/2026/09/batch-a.jsonl']) expect(after.get(rel)).toBe(before.get(rel));
    expect(after.get('ingested/batches.jsonl')!.startsWith(before.get('ingested/batches.jsonl')!)).toBe(true);
    const allowed = new Set([
      'events/2026/10/batch-b.jsonl',
      'ingested/batches.jsonl',
      'summaries/state.json',
      'summaries/all-time.json',
      'README.md',
      ...later.map((e) => `ids/${(e.id as string).slice(7, 9)}.jsonl`),
      ...later.map((e) => `sessions/${(e.session as string).slice(7, 9)}.txt`),
    ]);
    for (const rel of changed) expect(allowed.has(rel), `unexpected change to ${rel}`).toBe(true);
    // Every shard is sorted, so its content is independent of ingestion order.
    for (const rel of changed.filter((r) => r.startsWith('ids/'))) {
      const ids = after.get(rel)!.trim().split('\n').map((l) => (JSON.parse(l) as { id: string }).id);
      expect(ids).toEqual([...ids].sort());
    }
    expect(summaryOf(store)).toEqual(summarizeAudit(parseAuditJsonl(lines([event(1), event(2), event(3), event(4), ...later]))));
  });

  it('folds incrementally to exactly what a full rebuild streams from the partitions', () => {
    const { store } = legacyStore();
    expect(publish(store, candidates({ 'batch-a': lines([event(4), event(5)]) })).status).toBe(0);
    expect(publish(store, candidates({ 'batch-b': lines([event(6), event(5)]) }), { ingestedAt: '2026-11-01T00:00:00.000Z' }).status).toBe(0);
    const rebuilt = join(tempDir(), 'rebuilt');
    cpSync(store, rebuilt, { recursive: true });
    const result = publish(rebuilt, candidates({}), { rebuild: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('derived state rebuilt from the partitions');
    expect(changedBetween(snapshot(store), snapshot(rebuilt))).toEqual([]);
  });

  it('refuses a conflicting event id and a rewritten batch without writing anything', () => {
    const { store } = legacyStore();
    expect(publish(store, candidates({ 'batch-a': lines([event(4)]) })).status).toBe(0);
    const before = snapshot(store);

    const conflict = publish(store, candidates({ 'batch-c': lines([event(2, { rule: 'different-content' })]) }));
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toMatch(/candidate event id conflicts with stored content/);
    expect(changedBetween(before, snapshot(store))).toEqual([]);

    const rewritten = publish(store, candidates({ 'batch-a': lines([event(4), event(7)]) }));
    expect(rewritten.status).toBe(1);
    expect(rewritten.stderr).toMatch(/content changed after ingestion/);
    expect(changedBetween(before, snapshot(store))).toEqual([]);
  });

  it('a rebuild fails closed when a partition no longer matches its ledger entry', () => {
    const { store } = legacyStore();
    expect(publish(store, candidates({ 'batch-a': lines([event(4)]) })).status).toBe(0);
    const partition = join(store, 'events', '2026', '09', 'batch-a.jsonl');
    writeFileSync(partition, readFileSync(partition, 'utf8') + JSON.stringify(event(8)) + '\n');
    const result = publish(store, candidates({}), { rebuild: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/partition events\/2026\/09\/batch-a\.jsonl holds 2 event\(s\) but its ledger entry recorded 1/);
  });

  it('records a batch whose events are all already stored, so it is never re-examined', () => {
    const { store } = legacyStore();
    const result = publish(store, candidates({ 'dupes': lines([event(1), event(3)]) }));
    expect(result.status, result.stderr).toBe(0);
    const entry = ledgerOf(store).find((e) => e.batch_id === 'dupes')!;
    expect(entry).toMatchObject({ event_count: 2, stored_events: 0, stored_sha256: sha256('') });
    expect(readFileSync(join(store, entry.partition!), 'utf8')).toBe('');
    expect(summaryOf(store)).toMatchObject({ events: 3 });
  });

  it('enforces the hard limits at exit 2 with the limit in the message', () => {
    const { store } = legacyStore();
    const before = snapshot(store);

    const longLine = publish(store, candidates({ 'long': JSON.stringify(event(9, { rule: 'a'.repeat(17 * 1024) })) + '\n' }));
    expect(longLine.status).toBe(2);
    expect(longLine.stderr).toMatch(/event line limit is 16384 bytes/);

    const many = Array.from({ length: 50_001 }, (_, i) => event(100 + i));
    const tooMany = publish(store, candidates({ 'many': lines(many) }));
    expect(tooMany.status).toBe(2);
    expect(tooMany.stderr).toMatch(/holds 50001 events; the batch limit is 50000/);
    expect(changedBetween(before, snapshot(store))).toEqual([]);
  });

  it('refuses a partition that already holds the maximum number of batch files', () => {
    const store = join(tempDir(), 'store');
    for (const dir of ['events', 'ingested', 'summaries', 'ids', 'sessions']) mkdirSync(join(store, dir), { recursive: true });
    const ledger = Array.from({ length: 4096 }, (_, i) => JSON.stringify({
      batch_id: `b${i}`,
      source_sha: '1'.repeat(40),
      content_sha256: '2'.repeat(64),
      schema: 'audit-v1',
      ingested_at: '2026-09-01T00:00:00.000Z',
      event_count: 1,
      partition: `events/2026/09/b${i}.jsonl`,
      stored_events: 0,
      stored_sha256: sha256(''),
    }) + '\n').join('');
    writeFileSync(join(store, 'ingested', 'batches.jsonl'), ledger);
    const state = { schema: 'audit-store-state-v1', events: 0, blocked: 0, warnings: 0, sessions: 0, first: null, last: null, by_rule: {}, by_surface: {}, legacy_events: 0, legacy_bytes: 0 };
    writeFileSync(join(store, 'summaries', 'state.json'), JSON.stringify(state) + '\n');
    const result = publish(store, candidates({ 'one-more': lines([event(1)]) }), { ingestedAt: '2026-09-30T23:59:59.000Z' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/already holds 4096 batch files; the limit is 4096 per month/);
    expect(existsSync(join(store, 'events', '2026', '09', 'one-more.jsonl'))).toBe(false);
  });

  it('a rebuild removes shard files the partitions no longer account for and judges later events against the rebuilt truth', () => {
    const { store } = legacyStore();
    expect(publish(store, candidates({ 'batch-a': lines([event(4)]) })).status).toBe(0);
    // Entries no partition holds, as a corrupted or forged index would leave
    // behind, in prefixes no stored event uses. One prefix receives a real event
    // in the same run; the other stays empty.
    const ghostId = 'sha256:ff' + 'a'.repeat(30);
    const ghostSession = 'sha256:ff' + 'b'.repeat(22);
    const staleHash = 'c'.repeat(64);
    writeFileSync(join(store, 'ids', 'ff.jsonl'), JSON.stringify({ id: ghostId, content_sha256: staleHash }) + '\n');
    writeFileSync(join(store, 'sessions', 'ff.txt'), ghostSession + '\n');
    writeFileSync(join(store, 'ids', 'fe.jsonl'), JSON.stringify({ id: 'sha256:fe' + 'a'.repeat(30), content_sha256: staleHash }) + '\n');
    writeFileSync(join(store, 'sessions', 'fe.txt'), 'sha256:fe' + 'b'.repeat(22) + '\n');

    // Without the rebuild the ghost id would be a phantom conflict and the ghost
    // session an uncounted duplicate.
    const changed = join(tempDir(), 'changed.txt');
    const real = event(5, { id: ghostId, session: ghostSession });
    const result = publish(store, candidates({ 'batch-b': lines([real]) }), { rebuild: true, changed });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('4 stale shard file(s) removed');

    const written = readFileSync(changed, 'utf8').trim().split('\n');
    for (const rel of ['ids/ff.jsonl', 'sessions/ff.txt', 'ids/fe.jsonl', 'sessions/fe.txt']) expect(written).toContain(rel);
    expect(existsSync(join(store, 'ids', 'fe.jsonl'))).toBe(false);
    expect(existsSync(join(store, 'sessions', 'fe.txt'))).toBe(false);
    const ffIds = readFileSync(join(store, 'ids', 'ff.jsonl'), 'utf8').trim().split('\n');
    expect(ffIds).toHaveLength(1);
    expect(ffIds[0]).toContain(`"id":"${ghostId}"`);
    expect(ffIds[0]).not.toContain(staleHash);
    expect(readFileSync(join(store, 'sessions', 'ff.txt'), 'utf8')).toBe(ghostSession + '\n');
    const entry = ledgerOf(store).find((e) => e.batch_id === 'batch-b')!;
    expect(entry).toMatchObject({ event_count: 1, stored_events: 1 });
    expect(summaryOf(store)).toEqual(summarizeAudit(parseAuditJsonl(lines([event(1), event(2), event(3), event(4), real]))));

    // The rebuilt store is consistent: the next run folds forward and changes nothing.
    const before = snapshot(store);
    const again = publish(store, candidates({ 'batch-b': lines([real]) }));
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toContain('rebuilt');
    expect(changedBetween(before, snapshot(store))).toEqual([]);
  });

  it('handles a large synthetic history: a 20,000-event batch, then a rebuild that reproduces it', () => {
    const { store } = legacyStore();
    // Real event ids are hashes, so they spread over all 256 shards.
    const many = Array.from({ length: 20_000 }, (_, i) => event(1000 + i, { id: 'sha256:' + sha256(`event-${i}`).slice(0, 32) }));
    const result = publish(store, candidates({ 'big': lines(many) }));
    expect(result.status, result.stderr).toBe(0);
    expect(summaryOf(store)).toMatchObject({ events: 20_003 });
    const rebuilt = join(tempDir(), 'rebuilt');
    cpSync(store, rebuilt, { recursive: true });
    expect(publish(rebuilt, candidates({}), { rebuild: true }).status).toBe(0);
    expect(changedBetween(snapshot(store), snapshot(rebuilt))).toEqual([]);
    // Every shard is a bounded slice of the index, not one giant map on disk.
    const shardSizes = readdirSync(join(store, 'ids')).map((f) => statSync(join(store, 'ids', f)).size);
    expect(shardSizes.length).toBe(256);
    expect(Math.max(...shardSizes)).toBeLessThan(20 * 1024);
  });
});
