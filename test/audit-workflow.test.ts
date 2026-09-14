import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'tamperward-audit.yml'), 'utf8');

describe('GitHub audit store workflow', () => {
  it('is human-curated, main-gated, and the main-branch copy is the writer', () => {
    // Two curated entry points, both running only from the trusted main copy: an
    // operator dispatch, and a post-merge push that ingests the reviewed
    // audit/pending.jsonl. workflow_dispatch stays the first trigger.
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

  it('revalidates the privacy-safe batch before touching the evidence branch', () => {
    const validate = workflow.indexOf('stats --file');
    const worktree = workflow.indexOf('git worktree add');
    expect(validate).toBeGreaterThan(-1);
    expect(worktree).toBeGreaterThan(validate);
    expect(workflow).toContain('never TAMPERWARD_DENYLOG');
  });

  it('writes only the dedicated audit branch and rejects conflicting ids', () => {
    expect(workflow).toContain('HEAD:refs/heads/tamperward-audit');
    expect(workflow).toContain('submitted audit event id conflicts with stored content');
    expect(workflow).not.toMatch(/git push origin HEAD:refs\/heads\/main/);
  });
});
