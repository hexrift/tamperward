#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands are dispatched in main.ts.

import { guardedMain } from './main';

const argv = process.argv.slice(2);
const code = guardedMain(argv);
// watch returns -1 after installing its daemon watchers; do not call
// process.exit in that case because the event loop is the daemon lifetime.
if (code >= 0) process.exit(code);
