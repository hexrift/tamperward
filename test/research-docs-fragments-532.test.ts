// A local fragment link in the research docs must resolve to a heading id that the
// built site actually emits (#532). VitePress's default slugify keeps characters that
// are not whitespace or ASCII punctuation — an em dash survives the heading slug — so a
// hand-written fragment can point at an anchor the page never renders while both the
// VitePress build (`ignoreDeadLinks` only checks the target page exists, not the hash)
// and the HTML smoke test still pass. This suite walks every internal fragment link in
// `docs/research/` and resolves it against its target page's explicit `{#id}` anchors
// and heading ids, so a heading edit cannot silently break navigation again.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const researchDir = join(__dirname, '..', 'docs', 'research');

const pages = readdirSync(researchDir).filter((f) => f.endsWith('.md'));

// VitePress's heading id is `slugify(headingText)` from `@mdit-vue/shared`, unless the
// heading carries an explicit `{#id}` suffix, which it honours verbatim. This is a faithful
// port of that slugify (mdit-vue/packages/shared/src/slugify.ts). It is deliberately NOT a
// naive `[^a-z0-9]+ -> -` slug: the special-character class below excludes the em dash (and
// other non-ASCII punctuation), so `A — B` slugifies to `a-—-b`, keeping the literal em
// dash — the exact reason `#532`'s hand-written fragment missed the rendered anchor.
const rControl = /[\u0000-\u001f]/g; // eslint-disable-line no-control-regex
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g;
const rCombining = /[̀-ͯ]/g;

function slugify(str: string): string {
  return str
    .normalize('NFKD')
    .replace(rCombining, '')
    .replace(rControl, '')
    .replace(rSpecial, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

// Strip the inline markdown VitePress renders away before it slugifies (emphasis, code
// spans, and `[text](url)` -> text) so the heading text matches the plain text it emits.
function headingText(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

function anchorsOf(md: string): Set<string> {
  const ids = new Set<string>();
  for (const line of md.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const text = heading[1].trim();
    const explicit = /\{#([^}]+)\}\s*$/.exec(text);
    if (explicit) {
      ids.add(explicit[1]);
      continue;
    }
    const slug = slugify(headingText(text));
    if (slug) ids.add(slug);
  }
  return ids;
}

// (sourcePage, rawTarget, fragment) for every markdown link whose target is a local page
// or a same-page fragment. External links (http/https/mailto) and non-fragment links are
// skipped so an off-site URL is never mistaken for a local file.
type Frag = { source: string; target: string; fragment: string };

function fragmentLinks(page: string): Frag[] {
  const md = readFileSync(join(researchDir, page), 'utf8');
  const out: Frag[] = [];
  const link = /\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = link.exec(md)) !== null) {
    const url = m[1];
    if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('mailto:')) continue;
    const hash = url.indexOf('#');
    if (hash < 0) continue;
    out.push({ source: page, target: url.slice(0, hash), fragment: url.slice(hash + 1) });
  }
  return out;
}

// A link's target page in `docs/research/`. A bare `#frag` (empty target) is the source
// page itself; `./`, `.` and `./index` all address the directory index (index.md); other
// targets drop a `./` prefix, a `.md` suffix and any trailing slash before matching a page.
function resolveTargetPage(source: string, target: string): string | null {
  if (target === '') return source;
  let t = target.replace(/^\.\//, '').replace(/\.md$/, '').replace(/\/$/, '');
  if (t === '' || t === '.') t = 'index';
  const candidate = `${t}.md`;
  return pages.includes(candidate) ? candidate : null;
}

describe('research docs internal fragment links resolve to a rendered anchor (#532)', () => {
  const links = pages.flatMap(fragmentLinks);

  it('covers the Round 4 security-result link the issue reported', () => {
    const reported = links.find(
      (l) => l.source === 'security-evaluations.md' && /round-4/.test(l.target),
    );
    expect(reported, 'security-evaluations.md links the Round 4 security result').toBeDefined();
    expect(reported!.fragment).toBe('security-result-0-strict-tamper-bypasses-stated-precisely');
  });

  it('finds at least one relative, one base-prefixed and one same-page fragment link', () => {
    // relative to a sibling page, e.g. ./round-4#...
    expect(links.some((l) => l.target.startsWith('./') && l.target !== './' && !/^\.\/index$/.test(l.target))).toBe(
      true,
    );
    // base/directory-index, e.g. ./#... or ./index#pages
    expect(links.some((l) => l.target === './' || /^\.\/index$/.test(l.target))).toBe(true);
    // same-page fragment only, e.g. #corrections-and-errata
    expect(links.some((l) => l.target === '')).toBe(true);
  });

  it.each(pages.flatMap(fragmentLinks).map((l) => [`${l.source} → ${l.target}#${l.fragment}`, l] as const))(
    'resolves %s',
    (_label, l) => {
      const targetPage = resolveTargetPage(l.source, l.target);
      expect(targetPage, `${l.source}: local target page for "${l.target}" exists`).not.toBeNull();
      const anchors = anchorsOf(readFileSync(join(researchDir, targetPage!), 'utf8'));
      expect(
        anchors.has(l.fragment),
        `${l.source} → ${l.target}#${l.fragment}: no matching id in ${targetPage}`,
      ).toBe(true);
    },
  );
});
