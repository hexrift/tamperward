// Shared command-surface parsing. `raw` is authoritative (per the CommandChange
// contract); these split it into the units detectors reason over.

/** Split a command line into its `;`/`&&`/`||`/`|`/`&`/newline-separated segments.
 *  Quote-aware: a `;` inside `python -c '…; os.remove(hook)'` is part of the
 *  script, not a separator — splitting there handed the hook path to a segment
 *  with no command in front of it. A `|` or `&` that follows `>` is part of a
 *  redirection (`>|hook` clobbers past `noclobber`, `>&2`, `&>hook`), likewise. */
export function segments(raw: string): string[] {
  const out: string[] = [];
  let single = false;
  let double = false;
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && !single) { i++; continue; }
    if (ch === "'" && !double) { single = !single; continue; }
    if (ch === '"' && !single) { double = !double; continue; }
    if (single || double) continue;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    let len = 0;
    if (ch === '&' && next === '&') len = 2;
    else if (ch === '|' && next === '|') len = 2;
    else if (ch === '|' && next === '&') len = 2;
    else if (ch === ';' || ch === '\n') len = 1;
    else if (ch === '|' && prev !== '>') len = 1;
    else if (ch === '&' && prev !== '>' && next !== '>') len = 1;
    if (!len) continue;
    out.push(raw.slice(last, i));
    i += len - 1;
    last = i + 1;
  }
  out.push(raw.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a segment, keeping quoted spans intact. */
export function tokens(seg: string): string[] {
  return seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

export function unquote(t: string): string {
  return t.replace(/^['"]+|['"]+$/g, '');
}

/** The segment's tokens with quotes stripped — `'--no-verify'` is the flag, while
 *  `"docs: --no-verify is banned"` is one message argument that is not. */
export function words(seg: string): string[] {
  return tokens(seg).map(unquote);
}

// git's global options that consume the next token (`git -c core.hooksPath=x commit`).
const GIT_OPT_WITH_ARG: ReadonlySet<string> = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The git subcommand a token list runs (`HUSKY=0 git -C . commit …` -> `commit`),
 *  or null when it does not invoke git. `git log -n 5 -- src/commit.ts` runs `log`:
 *  the words `commit` and `-n` elsewhere in the segment are not the spelling. */
export function gitSubcommand(toks: string[]): string | null {
  const i = toks.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (i < 0) return null;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j];
    if (GIT_OPT_WITH_ARG.has(t)) {
      j++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}
