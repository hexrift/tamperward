#!/usr/bin/env node
// tamperward CLI entry. `check` is the gate; the agent hook, Stop sweep, init, and
// allow commands are dispatched in main.ts.

import { guardedMain } from './main';

const argv = process.argv.slice(2);
// watch returns -1 after installing its daemon watchers; do not call
// process.exit in that case because the event loop is the daemon lifetime.
const exit = (code: number): void => {
  if (code >= 0) process.exit(code);
};
const code = guardedMain(argv);
// onboard prompts, so its code arrives asynchronously; every other command is
// synchronous and exits exactly as before.
if (typeof code === 'number') exit(code);
else void code.then(exit);
