import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

describe('security documentation status (#311)', () => {
  it('keeps package identity aligned with the newest changelog release (#378)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const newest = changelog.match(/^## \[([^\]]+)\]/m)?.[1];

    expect(newest).toBeDefined();
    expect(pkg.version).toBe(newest);
  });

  it('binds the build spec to the shipped major/minor line', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const [major, minor] = pkg.version.split('.');
    const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');

    expect(spec).toContain(`**Implementation status:** TamperWard ${major}.${minor}.x`);
  });

  it('names the currently supported ecosystem surface instead of the old TS/Jest-only slice', () => {
    const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');
    for (const ecosystem of ['JavaScript/TypeScript', 'Python', 'Go', 'Rust', 'Ruby', 'JVM', 'PHP', '.NET']) {
      expect(spec).toContain(ecosystem);
    }
  });

  it('separates current residuals from historical closed/corrected findings', () => {
    const tracker = readFileSync(join(root, 'SECURITY-ENVELOPE.md'), 'utf8');

    expect(tracker).toContain('## Current open residuals');
    expect(tracker).toContain('## Historical findings — closed');
    expect(tracker).toContain('## Historical findings — withdrawn/corrected');
    expect(tracker).not.toContain('## Open — scoped, not yet closed');

    // Every current residual must point readers to the live threat-model/test
    // evidence rather than forcing them to infer status from historical rows.
    expect(tracker).toMatch(/checkpointed-local[\s\S]*THREAT-MODEL-pristine-run[\s\S]*verifier-container-e2e/);
    expect(tracker).toMatch(/suite-exit-only[\s\S]*THREAT-MODEL-pristine-run[\s\S]*verifier-container-e2e/);
    expect(tracker).toMatch(/verification surface[\s\S]*THREAT-MODEL-pristine-run/);
  });
});

// Every page the docs site builds must be reachable from its sidebar or nav (#451):
// the five top-level reference pages were built but reachable only through search,
// and one of them linked a `harness/` path that resolves on GitHub but 404s on the
// site because `harness/` is not served — the site form is the GitHub blob URL.
describe('docs site navigation and links (#451)', () => {
  const docsDir = join(root, 'docs');

  function markdownPages(dir: string, prefix = ''): string[] {
    const pages: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.vitepress' || entry.name === 'public') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pages.push(...markdownPages(join(dir, entry.name), rel));
      else if (entry.name.endsWith('.md')) pages.push(rel);
    }
    return pages.sort();
  }

  it('lists every built page in the sidebar or nav', () => {
    const config = readFileSync(join(docsDir, '.vitepress', 'config.mts'), 'utf8');
    const pages = markdownPages(docsDir);
    expect(pages.length).toBeGreaterThan(40);
    for (const page of pages) {
      // `index.md` is the home page the logo links to; every other page needs a
      // `link:` entry so it is reachable without the search box.
      if (page === 'index.md') continue;
      const link = page.endsWith('/index.md')
        ? `/${page.slice(0, -'index.md'.length)}`
        : `/${page.replace(/\.md$/, '')}`;
      expect(config, `sidebar/nav link for docs/${page}`).toContain(`link: '${link}'`);
    }
  });

  it('never links a harness/ path relatively — the site does not serve it', () => {
    for (const page of markdownPages(docsDir)) {
      const md = readFileSync(join(docsDir, page), 'utf8');
      expect(md, `docs/${page}`).not.toMatch(/\]\((?:\.\.\/)+harness\//);
    }
  });
});
