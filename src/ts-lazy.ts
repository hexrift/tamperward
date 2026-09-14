// The `typescript` package, loaded on first use rather than at startup.
//
// Eight detectors parse JavaScript/TypeScript on the TS AST, and each imported
// the package at the top of its module. Bundled, that is one static
// `import ts from 'typescript'` at the top of the CLI: Node runs the
// cjs-module-lexer over the 9 MB source to discover its named exports, then
// evaluates it — measured at roughly three quarters of every hook call's wall
// time (#322), paid on a `Bash` call that touches no file, on an edit to a
// Python test, on `--help`. The detectors already fall back to their line-level
// paths when the AST is unavailable, and read the AST only for a JS/TS file
// they were given full content for; the parser is needed exactly then.
//
// `createRequire` loads the CommonJS package synchronously (the detectors are
// synchronous) and without the ESM named-export discovery pass, so the AST
// path itself is cheaper than the static import was. The proxy makes the
// laziness invisible at the use sites: `ts.isIdentifier(...)`,
// `ts.SyntaxKind.X`, `ts.createSourceFile(...)` read exactly as before; only
// the type namespace moves to `import type TS from 'typescript'`, because a
// value cannot carry types.
//
// Trust is unchanged: the same detectors run the same parser over the same
// inputs; what moves is the moment the module is read from disk.

import { createRequire } from 'node:module';
import type TS from 'typescript';

let loaded: typeof TS | null = null;

/** The typescript module, read from disk on the first call and kept. */
export function loadTs(): typeof TS {
  if (loaded === null) {
    const required: typeof TS = createRequire(import.meta.url)('typescript');
    loaded = required;
  }
  return loaded;
}

/** Whether the package has been loaded in this process (tests assert the
 *  Bash-only and non-JS paths never trigger it). */
export function tsLoaded(): boolean {
  return loaded !== null;
}

const handler: ProxyHandler<object> = {
  get(_target, key) {
    return Reflect.get(loadTs(), key);
  },
  has(_target, key) {
    return Reflect.has(loadTs(), key);
  },
  ownKeys() {
    return Reflect.ownKeys(loadTs());
  },
  getOwnPropertyDescriptor(_target, key) {
    const d = Reflect.getOwnPropertyDescriptor(loadTs(), key);
    return d ? { ...d, configurable: true } : undefined;
  },
};

/** `typescript`'s namespace object, materialised on first property access. */
export const ts: typeof TS = new Proxy(Object.create(null), handler);

// ── The one guarded entry to the parser ──────────────────────────────────────
//
// `ts.createSourceFile` recurses once per nesting level, and so does every
// detector's visitor over the tree it returns: a spec beginning with
// `const deep = [[[…30 000 deep…]]];` overflowed the stack inside the parser —
// a `RangeError` that repository content can trigger at will — and a detector
// that threw was dropped from the verdict at the layers that did not fail
// closed (#444). Every parse therefore goes through here: a source past the
// byte ceiling or past the nesting ceiling is DECLINED (null) before the parser
// sees it, and a `RangeError` the parser still raises is declined the same way.
// A declined parse is not a verdict: the caller falls back to its line-level
// path, which judges the same content without the tree. The nesting ceiling is
// a bracket-depth count over the raw text — a string or comment full of `[` can
// only make it decline sooner, never parse deeper — and sits well under the
// depth at which Node's default stack gives out on the parser (measured
// between 500 and 700 levels on the TypeScript in the lockfile) with the
// detectors' visitors still to run on top.

/** Largest source the AST path reads, in bytes; larger content takes the
 *  line-level path. */
export const MAX_PARSE_BYTES = 4 * 1024 * 1024;

/** Deepest bracket nesting (`(`, `[`, `{`) the AST path reads; deeper content
 *  takes the line-level path. */
export const MAX_PARSE_DEPTH = 256;

/** Whether the bracket nesting of `src` stays within `MAX_PARSE_DEPTH`. Linear,
 *  allocation-free; an unbalanced close never goes below zero. */
function nestsWithinCeiling(src: string): boolean {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    // ( [ {
    if (c === 40 || c === 91 || c === 123) {
      if (++depth > MAX_PARSE_DEPTH) return false;
    } else if (c === 41 || c === 93 || c === 125) {
      // ) ] }
      if (depth > 0) depth--;
    }
  }
  return true;
}

/** Parse `src` as a TypeScript source file, or decline: null when the source is
 *  past the byte ceiling, past the nesting ceiling, or overflows the parser
 *  anyway. Never throws for content-shaped reasons; a caller that gets null
 *  runs its line-level fallback. */
export function parseSource(fileName: string, src: string, kind?: TS.ScriptKind): TS.SourceFile | null {
  if (Buffer.byteLength(src) > MAX_PARSE_BYTES) return null;
  if (!nestsWithinCeiling(src)) return null;
  const t = loadTs();
  try {
    return t.createSourceFile(fileName, src, t.ScriptTarget.Latest, true, kind ?? t.ScriptKind.TS);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}
