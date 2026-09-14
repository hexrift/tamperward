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
