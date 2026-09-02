#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands are dispatched in main.ts.

import { guardedMain } from './main';
import { runWatch } from './watch';

const argv = process.argv.slice(2);
if (argv[0] === 'watch') {
  // Daemon: the fs watcher keeps the event loop alive; exit is via signal.
  runWatch(argv.slice(1));
} else {
  process.exit(guardedMain(argv));
}
