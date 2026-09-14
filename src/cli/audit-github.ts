// Minimal GitHub contents/ref client for observational audit storage.
//
// Runs fetch in a child Node process with a deliberately tiny environment so a
// token never appears in argv, process listings, logs or thrown stack traces.
// Audit publishing is opt-in and never part of an enforcement verdict.

import { execFileSync } from 'node:child_process';

export interface GitHubResponse {
  status: number;
  body: unknown;
}

const SCRIPT = [
  "const fs = require('node:fs');",
  "const method = process.argv[1];",
  "const endpoint = process.argv[2];",
  "const raw = fs.readFileSync(0, 'utf8');",
  "const token = process.env.TAMPERWARD_GITHUB_TOKEN || '';",
  "const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'tamperward-audit' };",
  "if (token) headers.Authorization = 'Bearer ' + token;",
  "if (raw) headers['Content-Type'] = 'application/json';",
  "fetch('https://api.github.com/' + endpoint, { method, headers, body: raw || undefined }).then(async (r) => {",
  "  const text = await r.text();",
  "  let body = null;",
  "  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 500) }; }",
  "  process.stdout.write(JSON.stringify({ status: r.status, body }));",
  "}).catch((e) => { process.stderr.write(e instanceof Error ? e.message : String(e)); process.exit(23); });",
].join('\n');

export function githubRequest(
  cwd: string,
  method: 'GET' | 'POST' | 'PUT',
  endpoint: string,
  body?: unknown,
): GitHubResponse {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  try {
    const stdout = execFileSync(process.execPath, ['-e', SCRIPT, method, endpoint], {
      cwd,
      encoding: 'utf8',
      input: body === undefined ? '' : JSON.stringify(body),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20_000,
      env: {
        TAMPERWARD_GITHUB_TOKEN: token,
        LANG: 'C',
        LC_ALL: 'C',
      },
    });
    const parsed = JSON.parse(stdout) as GitHubResponse;
    if (!Number.isInteger(parsed.status)) throw new Error('GitHub response did not contain a status');
    return parsed;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error('GitHub audit request failed: ' + message.replace(/\s+/g, ' ').slice(0, 300));
  }
}

export function requireGitHubOk(response: GitHubResponse, context: string): unknown {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body as { message?: unknown } | null;
  const detail = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
  throw new Error(`${context}: ${detail}`);
}
