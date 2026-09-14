import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const workflow = readFileSync(resolve(root, '.github', 'workflows', 'tamperward-audit.yml'), 'utf8');
const prescan = readFileSync(resolve(root, '.github', 'audit', 'audit-prescan.mjs'), 'utf8');
const ingest = readFileSync(resolve(root, '.github', 'audit', 'audit-ingest.mjs'), 'utf8');

describe('GitHub audit store workflow', () => {
  it('is human-curated, main-gated, and the main-branch copy is the writer', () => {
    // Two curated entry points, both running only from the trusted main copy: an
    // operator dispatch, and a post-merge push that ingests reviewed, immutable
    // batch files. workflow_dispatch stays the first trigger.
    expect(workflow).toMatch(/^on:\n\s+workflow_dispatch:/m);
    // The push trigger is post-merge only, scoped to the main branch. A fork PR
    // must NEVER run the workflow that writes the evidence branch, so
    // pull_request / pull_request_target remain forbidden — those are the triggers
    // that would execute with write permission over untrusted head code.
    expect(workflow).not.toMatch(/^\s+pull_request(?:_target)?:/m);
    expect(workflow).toMatch(/^\s+push:\n\s+branches:\s*\[main\]/m);
    // The job guard is the second, independent gate: only the copy committed on
    // main runs, for a dispatch and a post-merge push alike.
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/permissions:\n\s+contents: write/);
  });

  it('revalidates every new batch before touching the evidence branch', () => {
    // The prescan decides what is new without a build; the CLI re-validates each
    // new batch against the strict audit-v1 parser BEFORE the evidence worktree
    // is created and written.
    const validate = workflow.indexOf('stats --file');
    const worktree = workflow.indexOf('git worktree add');
    expect(validate).toBeGreaterThan(-1);
    expect(worktree).toBeGreaterThan(validate);
    expect(workflow).toContain('never TAMPERWARD_DENYLOG');
  });

  it('ingests only new, immutable batches and rejects conflicting or rewritten evidence', () => {
    // The push writes only the dedicated evidence branch, never main.
    expect(workflow).toContain('HEAD:refs/heads/tamperward-audit');
    expect(workflow).not.toMatch(/git push origin HEAD:refs\/heads\/main/);
    // Idempotency + immutability: a batch id already recorded with a different
    // content hash is a rewrite of ingested evidence and fails closed.
    expect(prescan).toContain('immutable batches must never be rewritten');
    expect(prescan).toContain('content_sha256');
    // The event-id conflict guard the store has always enforced now lives in the
    // ingest script and records each batch's provenance in the ledger.
    expect(ingest).toContain('submitted audit event id conflicts with stored content');
    expect(ingest).toContain('content_sha256');
    expect(ingest).toContain('source_sha');
  });
});
