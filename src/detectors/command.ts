// Shared command-surface parsing. `raw` is authoritative (per the CommandChange
// contract); these split it into the units detectors reason over.

/** Split a command line into its `;`/`&&`/`||`/`|`/newline-separated segments. */
export function segments(raw: string): string[] {
  return raw
    .split(/(?:&&|\|\||[;&|\n])+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokenize a segment, keeping quoted spans intact. */
export function tokens(seg: string): string[] {
  return seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

export function unquote(t: string): string {
  return t.replace(/^['"]+|['"]+$/g, '');
}
