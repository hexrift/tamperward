import { resolve } from 'node:path';
import {
  DEFAULT_AUDIT_BRANCH,
  DEFAULT_AUDIT_ROOT,
  defaultAuditLog,
  parseAuditJsonl,
  readAuditLog,
  summarizeAudit,
  type AuditFindingEventV1,
  type AuditSummary,
} from '../audit';
import { githubRequest, requireGitHubOk } from './audit-github';

export interface StatsOpts {
  cwd?: string;
  log?: string;
  github?: string;
  branch?: string;
  path?: string;
  since?: string;
  json?: boolean;
}

export interface StatsDocumentV1 {
  schema_version: 1;
  source: {
    kind: 'local' | 'github';
    repo?: string;
    branch?: string;
  };
  since: string;
  summary: AuditSummary;
}

interface ContentItem {
  type?: unknown;
  name?: unknown;
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
}

function mapping(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function items(value: unknown): ContentItem[] {
  return Array.isArray(value) ? value.filter((v): v is ContentItem => mapping(v) !== null) : [];
}

function encoded(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/');
}

function parseSince(value: string | undefined, now = Date.now()): { label: string; cutoff: number | null } {
  if (!value || value === 'all') return { label: 'all time', cutoff: null };
  const m = /^(\d+)(h|d|w)$/i.exec(value);
  if (!m) throw new Error('--since needs a duration such as 24h, 30d, 12w, or "all"');
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('--since needs a positive duration');
  const unit = m[2].toLowerCase();
  const ms = n * (unit === 'h' ? 60 * 60 * 1000 : unit === 'd' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
  return { label: value.toLowerCase(), cutoff: now - ms };
}

function filterSince(events: AuditFindingEventV1[], cutoff: number | null): AuditFindingEventV1[] {
  if (cutoff === null) return events;
  return events.filter((event) => Date.parse(event.recorded_at) >= cutoff);
}

function decodeContent(body: unknown, context: string): string {
  const value = mapping(body);
  if (!value || value.encoding !== 'base64' || typeof value.content !== 'string') {
    throw new Error(context + ': GitHub did not return base64 file content');
  }
  return Buffer.from(value.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function monthFloor(cutoff: number | null): string | null {
  if (cutoff === null) return null;
  return new Date(cutoff).toISOString().slice(0, 7);
}

export function loadGitHubAudit(
  cwd: string,
  repo: string,
  branch = DEFAULT_AUDIT_BRANCH,
  root = DEFAULT_AUDIT_ROOT,
  cutoff: number | null = null,
): AuditFindingEventV1[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('--github needs OWNER/REPO');
  }
  if (!branch || /[\x00-\x20]/.test(branch)) throw new Error('--branch is not a valid Git ref');
  const query = '?ref=' + encodeURIComponent(branch);
  const top = githubRequest(cwd, 'GET', `repos/${repo}/contents/${encoded(root)}${query}`);
  if (top.status === 404) return [];
  const topBody = requireGitHubOk(top, 'read GitHub audit root');
  const floor = monthFloor(cutoff);
  const files: string[] = [];

  for (const entry of items(topBody)) {
    if (entry.type === 'file' && typeof entry.path === 'string' && entry.path.endsWith('.jsonl')) {
      files.push(entry.path);
      continue;
    }
    if (entry.type !== 'dir' || typeof entry.path !== 'string' || typeof entry.name !== 'string') continue;
    if (floor && /^\d{4}-\d{2}$/.test(entry.name) && entry.name < floor) continue;
    const listing = githubRequest(cwd, 'GET', `repos/${repo}/contents/${encoded(entry.path)}${query}`);
    if (listing.status === 404) continue;
    for (const child of items(requireGitHubOk(listing, 'read GitHub audit month'))) {
      if (child.type === 'file' && typeof child.path === 'string' && child.path.endsWith('.jsonl')) files.push(child.path);
    }
  }

  const events: AuditFindingEventV1[] = [];
  for (const path of files.sort()) {
    const file = githubRequest(cwd, 'GET', `repos/${repo}/contents/${encoded(path)}${query}`);
    if (file.status === 404) continue;
    events.push(...parseAuditJsonl(decodeContent(requireGitHubOk(file, 'read GitHub audit file'), path)));
  }
  return filterSince(events, cutoff);
}

function renderCountRows(values: Record<string, number>, empty = 'none'): string[] {
  const rows = Object.entries(values).filter(([, count]) => count > 0);
  if (rows.length === 0) return ['  ' + empty];
  const width = Math.max(...rows.map(([name]) => name.length), 4);
  return rows.map(([name, count]) => `  ${name.padEnd(width)}  ${String(count).padStart(5)}`);
}

export function renderStats(summary: AuditSummary, label: string, source: string): string {
  const out = [
    `TamperWard audit stats — ${label}`,
    source,
    '',
    `Integrity findings        ${String(summary.findings).padStart(8)}`,
    `Blocked                   ${String(summary.blocked).padStart(8)}`,
    `Warnings                  ${String(summary.warnings).padStart(8)}`,
    `Sessions with findings    ${String(summary.sessions_with_findings).padStart(8)}`,
    '',
    'By rule',
    ...renderCountRows(summary.by_rule),
    '',
    'By surface',
    ...renderCountRows({
      PreToolUse: summary.by_source.pretooluse,
      'Stop sweep': summary.by_source.stop,
    }),
  ];
  if (summary.findings === 0) {
    out.push('', 'No audit findings are recorded for this window.');
  } else {
    out.push('', `First  ${summary.first_recorded_at}`, `Last   ${summary.last_recorded_at}`);
  }
  out.push('', 'These are integrity findings, not claims about agent intent.');
  return out.join('\n') + '\n';
}

export function runStats(opts: StatsOpts = {}): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  try {
    const window = parseSince(opts.since);
    let events: AuditFindingEventV1[];
    let source: StatsDocumentV1['source'];
    let sourceText: string;

    if (opts.github) {
      const branch = opts.branch ?? DEFAULT_AUDIT_BRANCH;
      const root = (opts.path ?? DEFAULT_AUDIT_ROOT).replace(/^\/+|\/+$/g, '');
      if (!root || root.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error('--path must be a repository-relative directory');
      }
      events = loadGitHubAudit(cwd, opts.github, branch, root, window.cutoff);
      source = { kind: 'github', repo: opts.github, branch };
      sourceText = `GitHub: ${opts.github}#${branch}`;
    } else {
      const log = opts.log ? resolve(cwd, opts.log) : defaultAuditLog(cwd);
      events = filterSince(readAuditLog(log), window.cutoff);
      source = { kind: 'local' };
      sourceText = 'Local structured audit';
    }

    const summary = summarizeAudit(events);
    if (opts.json) {
      const doc: StatsDocumentV1 = {
        schema_version: 1,
        source,
        since: window.label,
        summary,
      };
      process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    } else {
      process.stdout.write(renderStats(summary, window.label, sourceText));
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write('tamperward stats: ' + message.replace(/\s+/g, ' ').trim() + '\n');
    return 2;
  }
}
