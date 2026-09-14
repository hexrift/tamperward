import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'tamperward-audit.yml'), 'utf8');

describe('GitHub audit store workflow', () => {
  it('is explicit-only and the main-branch copy is the writer', () => {
    expect(workflow).toMatch(/^on:\n\s+workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s+(?:pull_request|pull_request_target|push):/m);
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
