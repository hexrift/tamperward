// Capture what a nested command writes to stdout. The research runner reuses
// `verify`, `check` and `run` exactly as shipped — each emits its versioned
// JSON document on stdout — and reads those documents back rather than
// reaching into their internals. This is the same seam the test suite uses.

type StdoutWrite = typeof process.stdout.write;

export function captureStdout<T>(fn: () => T): { result: T; out: string } {
  let out = '';
  const original: StdoutWrite = process.stdout.write;
  const patched: StdoutWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const cb = rest.find((r) => typeof r === 'function');
    if (typeof cb === 'function') cb();
    return true;
  };
  process.stdout.write = patched;
  try {
    return { result: fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

/** Run `fn` with extra process environment, restoring the original after. The
 *  run envelope freezes `process.env` for the agent it launches, so the
 *  adapter's task environment has to be in place before it starts. */
export function withEnv<T>(extra: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(extra)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
