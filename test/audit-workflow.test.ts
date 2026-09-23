import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(__dirname, '..');
const workflowText = readFileSync(resolve(root, '.github', 'workflows', 'tamperward-audit.yml'), 'utf8');
const workflow = parse(workflowText) as {
  on: Record<string, unknown>;
  permissions?: { contents?: string };
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    permissions?: { contents?: string };
    steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};
const prescan = readFileSync(resolve(root, '.github', 'audit', 'audit-prescan.mjs'), 'utf8');
const verify = readFileSync(resolve(root, '.github', 'audit', 'audit-verify.mjs'), 'utf8');
const publish = readFileSync(resolve(root, '.github', 'audit', 'audit-publish.mjs'), 'utf8');

const stepsOf = (job: string): Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> =>
  workflow.jobs[job]?.steps ?? [];
const runText = (job: string): string => stepsOf(job).map((s) => s.run ?? '').join('\n');

describe('GitHub audit store workflow', () => {
  it('is human-curated, main-gated, and never triggered by an untrusted fork PR', () => {
    // Two curated entry points; workflow_dispatch stays first.
    expect(workflowText).toMatch(/^on:\n\s+workflow_dispatch:/m);
    expect(Object.keys(workflow.on)).toContain('workflow_dispatch');
    // A fork PR must NEVER run the workflow that writes the evidence branch.
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    // Post-merge push, scoped to main.
    expect((workflow.on.push as { branches?: string[] }).branches).toEqual(['main']);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it('uses no runner/steps/needs context in a workflow-level env (would fail to start)', () => {
    // A workflow-level `env` may only reference github / vars / inputs contexts.
    // `${{ runner.* }}` (or steps/needs/job/matrix) there is an invalid-context
    // startup failure — GitHub rejects the file before any job runs. This guards
    // the regression that broke every tamperward-audit run.
    const topEnv = (parse(workflowText) as { env?: Record<string, unknown> }).env;
    const serialized = JSON.stringify(topEnv ?? {});
    for (const ctx of ['runner.', 'steps.', 'needs.', 'job.', 'matrix.', 'strategy.']) {
      expect(serialized, `workflow-level env must not use \${{ ${ctx}* }}`).not.toContain(ctx);
    }
  });

  it('isolates the write credential in a publish job that runs no candidate code', () => {
    // Least privilege by default; only the publish job may write.
    expect(workflow.permissions?.contents).toBe('read');
    expect(workflow.jobs.prepare.permissions?.contents).toBe('read');
    expect(workflow.jobs.publish.permissions?.contents).toBe('write');
    expect(workflow.jobs.publish.needs).toContain('prepare');

    // The privileged writer runs NO npm ci and NO build — no candidate/dependency
    // code executes while the write token is available.
    const publish = runText('publish');
    expect(publish).not.toMatch(/npm ci/);
    expect(publish).not.toMatch(/npm run build/);

    // Neither checkout persists the git credential into later steps.
    for (const job of ['prepare', 'publish']) {
      const checkout = stepsOf(job).find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
      expect(checkout, `${job} checks out the repo`).toBeTruthy();
      expect(checkout?.with?.['persist-credentials']).toBe(false);
    }
  });

  it('revalidates before writing, and writes only the evidence branch', () => {
    // prepare validates each new batch with the strict CLI parser.
    expect(runText('prepare')).toMatch(/stats --file/);
    // publish validates dependency-free against the committed schema and derives
    // the store before the push.
    const publish = runText('publish');
    expect(publish).toContain('audit-publish.mjs');
    expect(publish).toContain('HEAD:refs/heads/tamperward-audit');
    expect(publish).not.toMatch(/HEAD:refs\/heads\/main\b/);
    // Never commit the privacy-unsafe deny log here.
    expect(workflowText).toContain('never TAMPERWARD_DENYLOG');
  });

  it('uses a per-run dispatch identity while retaining source SHA provenance', () => {
    expect(workflowText.match(/dispatch-\$\{GITHUB_RUN_ID\}\.jsonl/g)).toHaveLength(2);
    expect(workflowText).not.toContain('dispatch-${GITHUB_SHA}.jsonl');
    expect(runText('publish')).toContain('"${GITHUB_SHA}"');

    const dir = mkdtempSync(resolve(root, '.tw-audit-dispatch-'));
    const candidates = resolve(dir, 'candidates');
    const ledger = resolve(dir, 'batches.jsonl');
    const output = resolve(dir, 'new-batches.txt');
    mkdirSync(candidates);
    const batchA = '{"schema_version":1,"id":"a"}\n';
    const batchB = '{"schema_version":1,"id":"b"}\n';
    const writeBatch = (id: string, content: string): void =>
      writeFileSync(resolve(candidates, `dispatch-${id}.jsonl`), content);
    const runPrescan = (): void => {
      execFileSync(process.execPath, [
        resolve(root, '.github', 'audit', 'audit-prescan.mjs'),
        candidates,
        ledger,
        output,
      ], { encoding: 'utf8', stdio: 'pipe' });
    };
    try {
      writeBatch('100', batchA);
      writeBatch('101', batchB);
      runPrescan();
      expect(readFileSync(output, 'utf8').split(/\r?\n/).filter(Boolean)).toHaveLength(2);

      const hashA = createHash('sha256').update(batchA).digest('hex');
      writeFileSync(ledger, JSON.stringify({ batch_id: 'dispatch-100', content_sha256: hashA }) + '\n');
      runPrescan();
      expect(readFileSync(output, 'utf8')).toContain('dispatch-101.jsonl');
      expect(readFileSync(output, 'utf8')).not.toContain('dispatch-100.jsonl');

      writeBatch('100', batchA + '{"schema_version":1,"id":"changed"}\n');
      expect(runPrescan).toThrow(/immutable batches must never be rewritten/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ingests only new, immutable batches and rejects conflicting or rewritten evidence', () => {
    // Idempotency + immutability: a batch id already recorded with a different
    // content hash is a rewrite of ingested evidence and fails closed.
    expect(prescan).toContain('immutable batches must never be rewritten');
    expect(prescan).toContain('content_sha256');
    // The privileged transition owns the event-id conflict guard, provenance,
    // append-only prefix and derived reports. It receives raw candidates, not a
    // replacement store produced by a dependency-running job.
    expect(publish).toContain('candidate event id conflicts with stored content');
    expect(publish).toContain('content_sha256');
    expect(publish).toContain('source_sha');
    expect(publish).toContain('summarize(allEvents)');
    expect(runText('publish')).toContain('audit-publish.mjs');
    expect(stepsOf('publish').some((s) => (s.uses ?? '').startsWith('actions/download-artifact@'))).toBe(false);
    // The dependency-free verifier validates against the committed schema and
    // refuses to pass a schema keyword it does not understand, recursively.
    expect(verify).toContain('unsupported schema keyword');
  });
});
