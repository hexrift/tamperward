// `yaml` and `picomatch`, loaded on first use rather than at startup.
//
// Same reasoning as src/ts-lazy.ts, smaller stakes: the two packages cost about
// 35 ms of every process start on the reference machine, and the thin hook client
// (src/cli/index.ts, under the opt-in persistent hook service) needs neither — it
// reads stdin and talks to a socket. A static `import` anywhere in the bundle is
// hoisted to the top of dist/cli/index.js and paid before the launcher runs;
// `createRequire` is paid by the first caller that actually parses a policy or
// compiles a glob. Every other invocation reaches that caller within
// milliseconds and sees no difference.
//
// The call sites read as they did: `picomatch(glob, opts)`, `picomatch.makeRe(...)`,
// `yaml.parse(text)`.

import { createRequire } from 'node:module';
import type PM from 'picomatch';
import type * as YAML from 'yaml';

const req = createRequire(import.meta.url);

let pm: typeof PM | null = null;
function loadPicomatch(): typeof PM {
  if (pm === null) {
    const loaded: typeof PM = req('picomatch');
    pm = loaded;
  }
  return pm;
}

let y: typeof YAML | null = null;
function loadYaml(): typeof YAML {
  if (y === null) {
    const loaded: typeof YAML = req('yaml');
    y = loaded;
  }
  return y;
}

/** picomatch's default export, forwarded: the matcher factory and the one static
 *  helper this codebase uses (`makeRe`). A Proxy cannot serve here — a proxy is
 *  callable only over a callable target, and a typed function target would have
 *  needed an assertion. */
export function picomatch(...args: Parameters<typeof PM>): ReturnType<typeof PM> {
  return loadPicomatch()(...args);
}
picomatch.makeRe = (...args: Parameters<typeof PM.makeRe>): ReturnType<typeof PM.makeRe> => loadPicomatch().makeRe(...args);

/** The yaml module namespace (`yaml.parse`). */
export const yaml: typeof YAML = new Proxy(Object.create(null), {
  get(_target, key) {
    return Reflect.get(loadYaml(), key);
  },
});
