#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands are dispatched in main.ts.
//
// main is imported DYNAMICALLY so that the one path which must stay thin —
// `hook claude` / `sweep claude` under the opt-in persistent hook service (#322,
// src/cli/hook-client.ts) — can hand the payload to the warm service without
// first evaluating the engine, the detectors and the parsers they load. esbuild
// bundles a dynamically imported module behind a lazy initialiser, so the single
// dist/cli/index.js still carries everything; it just does not run main's module
// graph until this asks for it. The service path asks only when the service does
// not answer, and then evaluates in-process exactly as before. Every other
// invocation loads main immediately.

import { readFileSync } from 'node:fs';
import { hookServiceEnabled, requestVerdict, type HookKind } from './hook-client';
import { exitAfterFlush } from './exit';

function loadMain(): Promise<typeof import('./main')> {
  return import('./main');
}

function hookKind(argv: string[]): HookKind | null {
  if (argv.length !== 2 || argv[1] !== 'claude') return null;
  return argv[0] === 'hook' ? 'PreToolUse' : argv[0] === 'sweep' ? 'Stop' : null;
}

async function launch(argv: string[]): Promise<number> {
  const kind = hookKind(argv);
  if (kind && hookServiceEnabled()) {
    let raw: string | null = null;
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      raw = null; // main's own stdin read fails closed the same way it always did
    }
    if (raw !== null) {
      const served = await requestVerdict(kind, raw);
      if (served) {
        if (served.stdout) process.stdout.write(served.stdout);
        return served.exitCode;
      }
      const main = await loadMain();
      return main.runHookFromRaw(kind, raw);
    }
  }
  const main = await loadMain();
  return main.guardedMain(argv);
}

const code = await launch(process.argv.slice(2));
// watch and hook-service return -1 after installing their daemon handlers; do not
// exit in that case because the event loop is the daemon lifetime. Every other exit
// waits for the verdict on stdout to drain first (#415): a `process.exit` straight
// after the write truncates it on an asynchronous pipe (macOS, Windows, a slow reader).
if (code >= 0) exitAfterFlush(code);
