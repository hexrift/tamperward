#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands are dispatched in main.ts.
//
// main.js is loaded DYNAMICALLY, and built as its own bundle, so that the one
// path which must stay thin — `hook claude` / `sweep claude` under the opt-in
// persistent hook service (#322, src/cli/hook-client.ts) — can hand the payload
// to the warm service without first paying for the engine, the detectors and
// the `typescript` package they import. That path loads main.js only when the
// service does not answer, and then evaluates in-process exactly as before.
// Every other invocation loads main.js immediately.

import { readFileSync } from 'node:fs';
import { hookServiceEnabled, requestVerdict, type HookKind } from './hook-client';

type MainModule = typeof import('./main');

function loadMain(): Promise<MainModule> {
  return import(new URL('./main.js', import.meta.url).href);
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
// call process.exit in that case because the event loop is the daemon lifetime.
if (code >= 0) process.exit(code);
