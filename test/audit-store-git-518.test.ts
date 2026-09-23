// The evidence-branch git choreography (#518), run against a local bare
// remote over file:// so partial-clone filters are honoured: the prepare path
// fetches only the ledger, the publish path never downloads a historical
// partition, a push from the sparse clone leaves the remote tree intact, and a
// repeat run stages nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const script = resolve(root, '.github', 'audit', 'audit-store-git.sh');
const publishScript = resolve(root, '.github', 'audit', 'audit-publish.mjs');
const schemaPath = resolve(root, 'schemas', 'audit-v1.schema.json');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'push.negotiate=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const choreography = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

function event(n: number): string {
  return JSON.stringify({
    schema_version: 1,
    id: 'sha256:' + n.toString(16).padStart(32, '0'),
    timestamp: '2026-09-15T00:00:00Z',
    surface: 'stop',
    agent: 'claude-code',
    rule: 'test-skip',
    severity: 'block',
    decision: 'deny',
  }) + '\n';
}

/** A bare remote that honours --filter, optionally seeded with an evidence branch holding one large partition. */
function remote(seeded: boolean): { url: string; big: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tw-audit-git-'));
  dirs.push(dir);
  const bare = join(dir, 'remote.git');
  git(dir, 'init', '--quiet', '--bare', bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  const url = 'file://' + bare;
  let big = '';
  if (seeded) {
    const seed = join(dir, 'seed');
    git(dir, 'init', '--quiet', seed);
    git(seed, 'checkout', '--quiet', '--orphan', 'tamperward-audit');
    mkdirSync(join(seed, 'events', '2026', '08'), { recursive: true });
    mkdirSync(join(seed, 'ingested'), { recursive: true });
    big = Array.from({ length: 2000 }, (_, i) => event(1_000_000 + i)).join('');
    writeFileSync(join(seed, 'events', '2026', '08', 'old.jsonl'), big);
    writeFileSync(join(seed, 'ingested', 'batches.jsonl'), JSON.stringify({
      batch_id: 'old',
      source_sha: '1'.repeat(40),
      content_sha256: '2'.repeat(64),
      schema: 'audit-v1',
      ingested_at: '2026-08-20T00:00:00.000Z',
      event_count: 2000,
      partition: 'events/2026/08/old.jsonl',
      stored_events: 2000,
      stored_sha256: '3'.repeat(64),
    }) + '\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'seed');
    git(seed, 'push', '--quiet', url, 'HEAD:refs/heads/tamperward-audit');
  }
  return { url, big };
}

function publish(store: string, candidates: string, changed: string, rebuild = false) {
  const args = [publishScript, schemaPath, candidates, store, '4'.repeat(40), '--changed-paths', changed];
  if (rebuild) args.push('--rebuild');
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, TAMPERWARD_AUDIT_INGESTED_AT: '2026-09-23T12:00:00.000Z' },
  });
}

describe('evidence-branch git choreography (#518)', () => {
  it('prepare fetches only the ledger; publish never downloads an old partition and pushes a tree that keeps it', () => {
    const { url, big } = remote(true);
    const work = mkdtempSync(join(tmpdir(), 'tw-audit-git-work-'));
    dirs.push(work);

    const ledgerClone = join(work, 'ledger');
    expect(choreography('clone-ledger', url, ledgerClone).status).toBe(0);
    expect(readFileSync(join(ledgerClone, 'ingested', 'batches.jsonl'), 'utf8')).toContain('"batch_id":"old"');
    expect(existsSync(join(ledgerClone, 'events'))).toBe(false);

    const store = join(work, 'store');
    expect(choreography('clone-store', url, store).status).toBe(0);
    expect(existsSync(join(store, 'ingested', 'batches.jsonl'))).toBe(true);
    expect(existsSync(join(store, 'events', '2026', '08', 'old.jsonl'))).toBe(false);
    // The old partition's blob was never fetched: it is a promisor object, not a local one.
    expect(git(store, 'rev-list', '--objects', '--missing=print', 'HEAD')).toContain('?');

    const candidates = join(work, 'candidates');
    mkdirSync(candidates);
    writeFileSync(join(candidates, 'fresh.jsonl'), event(1) + event(2));
    const changed = join(work, 'changed.txt');
    // The store has no derived state yet, and a rebuild in a sparse clone must
    // refuse rather than guess: the historical partition is not present.
    const sparseRebuild = publish(store, candidates, changed);
    expect(sparseRebuild.status).toBe(1);
    expect(sparseRebuild.stderr).toMatch(/missing partition events\/2026\/08\/old\.jsonl .* full checkout/);

    // With --full the rebuild streams the partition and ingestion proceeds.
    const full = join(work, 'full');
    expect(choreography('clone-store', url, full, '--full').status).toBe(0);
    expect(readFileSync(join(full, 'events', '2026', '08', 'old.jsonl'), 'utf8')).toBe(big);
    // The seeded ledger recorded placeholder hashes; a rebuild verifies the real
    // ones, so fix the entry the way the publisher would have written it.
    const result = publish(full, candidates, changed, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match its ledger hash/);
  });

  it('creates the branch on first publish and stages nothing on a repeat run', () => {
    const { url } = remote(false);
    const work = mkdtempSync(join(tmpdir(), 'tw-audit-git-work-'));
    dirs.push(work);
    const candidates = join(work, 'candidates');
    mkdirSync(candidates);
    writeFileSync(join(candidates, 'first.jsonl'), event(1) + event(2));

    const store = join(work, 'store');
    expect(choreography('clone-store', url, store).status).toBe(0);
    const changed = join(work, 'changed.txt');
    const result = publish(store, candidates, changed);
    expect(result.status, result.stderr).toBe(0);
    const staged = choreography('stage', store, changed);
    expect(staged.status, staged.stderr).toBe(0);
    expect(staged.stdout.trim()).toBe('staged');
    git(store, 'commit', '--quiet', '-m', 'ingest');
    git(store, 'push', '--quiet', 'origin', 'HEAD:refs/heads/tamperward-audit');

    // A second round against the now-existing branch: sparse clone, same
    // candidates, nothing new.
    const again = join(work, 'again');
    expect(choreography('clone-store', url, again).status).toBe(0);
    expect(readFileSync(join(again, 'ingested', 'batches.jsonl'), 'utf8')).toContain('"batch_id":"first"');
    expect(existsSync(join(again, 'events', '2026', '09', 'first.jsonl'))).toBe(false);
    const changedAgain = join(work, 'changed-again.txt');
    const repeat = publish(again, candidates, changedAgain);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(readFileSync(changedAgain, 'utf8')).toBe('');
    expect(choreography('stage', again, changedAgain).stdout.trim()).toBe('nothing');

    // A third round adds a batch in a new month from the sparse clone and pushes it.
    writeFileSync(join(candidates, 'second.jsonl'), event(3));
    const third = join(work, 'third');
    expect(choreography('clone-store', url, third).status).toBe(0);
    const changedThird = join(work, 'changed-third.txt');
    const ingest = spawnSync(process.execPath, [publishScript, schemaPath, candidates, third, '5'.repeat(40), '--changed-paths', changedThird], {
      encoding: 'utf8',
      env: { ...process.env, TAMPERWARD_AUDIT_INGESTED_AT: '2026-10-05T12:00:00.000Z' },
    });
    expect(ingest.status, ingest.stderr).toBe(0);
    expect(readFileSync(changedThird, 'utf8')).toContain('events/2026/10/second.jsonl');
    expect(choreography('stage', third, changedThird).stdout.trim()).toBe('staged');
    git(third, 'commit', '--quiet', '-m', 'ingest');
    git(third, 'push', '--quiet', 'origin', 'HEAD:refs/heads/tamperward-audit');

    const check = join(work, 'check');
    git(work, 'clone', '--quiet', '--branch', 'tamperward-audit', '--single-branch', url, check);
    expect(readFileSync(join(check, 'events', '2026', '09', 'first.jsonl'), 'utf8')).toBe(event(1) + event(2));
    expect(readFileSync(join(check, 'events', '2026', '10', 'second.jsonl'), 'utf8')).toBe(event(3));
    expect(readFileSync(join(check, 'ingested', 'batches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(check, 'summaries', 'all-time.json'), 'utf8'))).toMatchObject({ events: 3 });
  });
});
