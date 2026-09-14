import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_AUDIT_BRANCH,
  DEFAULT_AUDIT_ROOT,
  defaultAuditLog,
  readAuditLog,
  type AuditFindingEventV1,
} from '../audit';
import { githubRequest, requireGitHubOk } from './audit-github';

export interface AuditPublishOpts {
  cwd?: string;
  log?: string;
  github?: string;
  branch?: string;
  path?: string;
}

function mapping(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function encoded(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/');
}

function tokenAvailable(): boolean {
  return Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
}

function githubFileText(body: unknown, context: string): string {
  const value = mapping(body);
  if (!value || value.encoding !== 'base64' || typeof value.content !== 'string') {
    throw new Error(context + ': GitHub did not return base64 file content');
  }
  return Buffer.from(value.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function assertSameBundle(body: unknown, expected: string, context: string): void {
  const actual = githubFileText(body, context);
  if (actual !== expected) {
    throw new Error(context + ': an audit bundle with the same event-id range already exists with different content');
  }
}

function ensureAuditBranch(cwd: string, repo: string, branch: string): void {
  const endpoint = `repos/${repo}/git/ref/heads/${encoded(branch)}`;
  const existing = githubRequest(cwd, 'GET', endpoint);
  if (existing.status >= 200 && existing.status < 300) return;
  if (existing.status !== 404) {
    requireGitHubOk(existing, 'inspect GitHub audit branch');
    return;
  }

  const meta = mapping(requireGitHubOk(githubRequest(cwd, 'GET', `repos/${repo}`), 'read GitHub repository'));
  const defaultBranch = typeof meta?.default_branch === 'string' ? meta.default_branch : '';
  if (!defaultBranch) throw new Error('GitHub repository did not report a default branch');

  const base = mapping(requireGitHubOk(
    githubRequest(cwd, 'GET', `repos/${repo}/git/ref/heads/${encoded(defaultBranch)}`),
    'read GitHub default-branch ref',
  ));
  const object = mapping(base?.object);
  const sha = typeof object?.sha === 'string' ? object.sha : '';
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error('GitHub default-branch ref did not contain a commit SHA');

  requireGitHubOk(
    githubRequest(cwd, 'POST', `repos/${repo}/git/refs`, {
      ref: 'refs/heads/' + branch,
      sha,
    }),
    'create GitHub audit branch',
  );
}

function unpublished(events: AuditFindingEventV1[], cursorPath: string): AuditFindingEventV1[] {
  if (!existsSync(cursorPath)) return events;
  const cursor = readFileSync(cursorPath, 'utf8').trim();
  if (!cursor) return events;
  const index = events.findIndex((event) => event.id === cursor);
  return index < 0 ? events : events.slice(index + 1);
}

const MAX_EVENTS_PER_BUNDLE = 500;

function groupsByMonth(events: AuditFindingEventV1[]): Map<string, AuditFindingEventV1[]> {
  const groups = new Map<string, AuditFindingEventV1[]>();
  for (const event of events) {
    const month = event.recorded_at.slice(0, 7);
    const bucket = groups.get(month) ?? [];
    bucket.push(event);
    groups.set(month, bucket);
  }
  return groups;
}

export function publishAudit(opts: AuditPublishOpts): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  try {
    const repo = opts.github ?? '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error('audit publish requires --github OWNER/REPO');
    }
    if (!tokenAvailable()) {
      throw new Error('audit publish needs GH_TOKEN or GITHUB_TOKEN with Contents write access');
    }

    const branch = opts.branch ?? DEFAULT_AUDIT_BRANCH;
    if (!branch || /[\x00-\x20]/.test(branch)) throw new Error('--branch is not a valid Git ref');
    const root = (opts.path ?? DEFAULT_AUDIT_ROOT).replace(/^\/+|\/+$/g, '');
    if (!root || root.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error('--path must be a repository-relative directory');
    }

    const log = opts.log ? resolve(cwd, opts.log) : defaultAuditLog(cwd);
    const cursor = log + '.publish-cursor';
    const all = readAuditLog(log);
    const pending = unpublished(all, cursor);
    if (pending.length === 0) {
      process.stdout.write('tamperward audit: nothing new to publish\n');
      return 0;
    }

    ensureAuditBranch(cwd, repo, branch);
    let published = 0;

    for (const [month, events] of groupsByMonth(pending)) {
      for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_BUNDLE) {
        const bundle = events.slice(offset, offset + MAX_EVENTS_PER_BUNDLE);
        const first = bundle[0];
        const last = bundle.at(-1) ?? first;
        const name = `${first.id}--${last.id}.jsonl`;
        const path = `${root}/${month}/${name}`;
        const endpoint = `repos/${repo}/contents/${encoded(path)}`;
        const data = bundle.map((event) => JSON.stringify(event)).join('\n') + '\n';
        const query = '?ref=' + encodeURIComponent(branch);
        const check = githubRequest(cwd, 'GET', endpoint + query);
        if (check.status === 404) {
          const created = githubRequest(cwd, 'PUT', endpoint, {
            message: `audit: publish ${bundle.length} TamperWard finding event(s)`,
            content: Buffer.from(data, 'utf8').toString('base64'),
            branch,
          });
          if (created.status < 200 || created.status >= 300) {
            // Another trusted publisher may have won the same create race. That
            // is idempotent only when the object it created is exactly our bundle.
            if (created.status === 409 || created.status === 422) {
              const raced = githubRequest(cwd, 'GET', endpoint + query);
              if (raced.status >= 200 && raced.status < 300) {
                assertSameBundle(raced.body, data, 'verify raced GitHub audit bundle');
              } else {
                requireGitHubOk(created, 'publish GitHub audit bundle');
              }
            } else {
              requireGitHubOk(created, 'publish GitHub audit bundle');
            }
          }
        } else {
          assertSameBundle(requireGitHubOk(check, 'check GitHub audit bundle'), data, 'check GitHub audit bundle');
        }
        published += bundle.length;
      }
    }

    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('refusing to follow a symlink at the local audit publish cursor');
    }
    const lastPublished = pending.at(-1);
    if (!lastPublished) throw new Error('internal audit publish cursor error');
    writeFileSync(cursor, lastPublished.id + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(
      `tamperward audit: published ${published} finding event(s) to ${repo}#${branch}/${root}\n`,
    );
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write('tamperward audit: ' + message.replace(/\s+/g, ' ').trim() + '\n');
    return 2;
  }
}

export function runAuditCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== 'publish') {
    process.stderr.write('tamperward audit: expected subcommand "publish"\n');
    return 2;
  }
  const opts: AuditPublishOpts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--cwd') opts.cwd = rest[++i];
    else if (arg === '--log') opts.log = rest[++i];
    else if (arg === '--github') opts.github = rest[++i];
    else if (arg === '--branch') opts.branch = rest[++i];
    else if (arg === '--path') opts.path = rest[++i];
  }
  return publishAudit(opts);
}
