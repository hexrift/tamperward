// Pure unified-diff parser: `git diff` text in, `Change[]` out. No shelling, no I/O,
// so it is exhaustively unit-testable. Full before/after content is NOT available here
// (a diff only carries hunks) — the git builder enriches that on top. What this layer
// owns and must get exactly right: file op, the old path on a rename, and the per-line
// old/new line numbers, since every Finding.line downstream inherits them.

import { Change, FileChange, FileOp, Hunk, DiffLine } from '../types';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

/**
 * Decode a path the way git wrote it. With `core.quotePath` (ON by default) git wraps any
 * path containing non-ASCII or control characters in double quotes and C-escapes its BYTES:
 *
 *     diff --git "a/caf\303\251.spec.ts" "b/caf\303\251.spec.ts"
 *
 * Left encoded, that path matches no protected glob, so `café.spec.ts` could be deleted,
 * renamed out, or gutted with EVERY path-based detector silent — on all three git views.
 * Decode the escapes back to bytes, then read them as UTF-8.
 */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      for (const b of Buffer.from(body[i], 'utf8')) bytes.push(b);
      continue;
    }
    const oct = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) {
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    const esc = C_ESCAPES[body[i + 1]];
    if (esc !== undefined) {
      bytes.push(esc);
      i += 1;
      continue;
    }
    bytes.push(92); // a lone backslash git did not escape
  }
  return Buffer.from(bytes).toString('utf8');
}

function endOfQuoted(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

/** The two path tokens of a `diff --git` header. Either side may be quoted independently,
 *  and an unquoted path may itself contain spaces, so a quoted token is read as a unit and
 *  only the all-unquoted case falls back to splitting on the last ` b/`. */
function headerPaths(line: string): [string | null, string | null] {
  let rest = line.slice('diff --git '.length);
  let first: string | null = null;

  if (rest.startsWith('"')) {
    const end = endOfQuoted(rest);
    if (end > 0) {
      first = rest.slice(0, end + 1);
      rest = rest.slice(end + 1).trimStart();
    }
  }
  if (first === null) {
    const q = rest.indexOf(' "b/');
    if (q >= 0) {
      first = rest.slice(0, q);
      rest = rest.slice(q + 1);
    } else {
      const m = rest.match(/^(.*) (b\/.*)$/);
      if (!m) return [null, null];
      first = m[1];
      rest = m[2];
    }
  }
  return [stripAB(first), stripAB(rest)];
}

function stripAB(p: string | null): string | null {
  if (p === null) return null;
  const u = unquotePath(p);
  if (u === '/dev/null') return null;
  return u.replace(/^[ab]\//, '');
}

export function parseDiff(diff: string): Change[] {
  const lines = diff.split('\n');
  const changes: Change[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const [headerOld, headerNew] = headerPaths(lines[i]);
    i++;

    let op: FileOp = 'modify';
    let binary = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let minusPath: string | null = null;
    let plusPath: string | null = null;
    let oldMode: string | undefined;
    let newMode: string | undefined;
    const hunks: Hunk[] = [];

    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const l = lines[i];

      if (l.startsWith('@@')) {
        const parsed = parseHunk(lines, i);
        if (parsed) {
          hunks.push(parsed.hunk);
          i = parsed.next;
          continue;
        }
        i++;
        continue;
      }

      if (l.startsWith('new file mode ')) { op = 'add'; newMode = l.slice(14).trim(); }
      else if (l.startsWith('deleted file mode ')) { op = 'delete'; oldMode = l.slice(18).trim(); }
      else if (l.startsWith('old mode ')) oldMode = l.slice(9).trim();
      else if (l.startsWith('new mode ')) newMode = l.slice(9).trim();
      else if (l.startsWith('rename from ')) { renameFrom = unquotePath(l.slice(12)); op = 'rename'; }
      else if (l.startsWith('rename to ')) { renameTo = unquotePath(l.slice(10)); op = 'rename'; }
      else if (l.startsWith('copy from ')) { renameFrom = unquotePath(l.slice(10)); if (op === 'modify') op = 'rename'; }
      else if (l.startsWith('copy to ')) { renameTo = unquotePath(l.slice(8)); if (op === 'modify') op = 'rename'; }
      else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) binary = true;
      else if (l.startsWith('--- ')) minusPath = l.slice(4);
      else if (l.startsWith('+++ ')) plusPath = l.slice(4);

      i++;
    }

    let path: string;
    let oldPath: string | null = null;

    if (op === 'rename') {
      oldPath = renameFrom ?? stripAB(minusPath) ?? headerOld;
      path = renameTo ?? stripAB(plusPath) ?? headerNew ?? oldPath ?? '';
    } else if (op === 'delete') {
      path = stripAB(minusPath) ?? headerOld ?? '';
    } else {
      path = stripAB(plusPath) ?? headerNew ?? headerOld ?? '';
    }

    const change: FileChange = {
      kind: 'file',
      path,
      oldPath,
      op,
      before: null,
      after: null,
      binary,
      hunks,
      ...(oldMode !== undefined ? { oldMode } : {}),
      ...(newMode !== undefined ? { newMode } : {}),
    };
    changes.push(change);
  }

  return changes;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } | null {
  const m = lines[start].match(HUNK_RE);
  if (!m) return null;

  const oldStart = Number(m[1]);
  const oldLines = m[2] !== undefined ? Number(m[2]) : 1;
  const newStart = Number(m[3]);
  const newLines = m[4] !== undefined ? Number(m[4]) : 1;

  const out: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let i = start + 1;

  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
    if (l.startsWith('\\')) continue; // "\ No newline at end of file"

    const tag = l[0];
    const content = l.slice(1);

    if (tag === '+') {
      out.push({ type: 'add', content, oldLine: null, newLine });
      newLine++;
    } else if (tag === '-') {
      out.push({ type: 'del', content, oldLine, newLine: null });
      oldLine++;
    } else if (tag === ' ') {
      out.push({ type: 'context', content, oldLine, newLine });
      oldLine++;
      newLine++;
    } else {
      break; // trailing blank line or end of patch
    }
  }

  return { hunk: { oldStart, oldLines, newStart, newLines, lines: out }, next: i };
}
