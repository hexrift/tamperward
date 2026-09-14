// Preload (`node --require test/fixtures/async-stdout.cjs …`) that makes every
// process.stdout write ASYNCHRONOUS, the way a pipe behaves on macOS and Windows
// (Node: "Pipes and sockets: synchronous on Linux, asynchronous elsewhere"). Each
// chunk is handed to the real stdout only after a timer fires, so a `process.exit`
// that follows a write without waiting for it drops the chunk on every platform —
// the truncation #415 describes, made reproducible on a Linux runner.
'use strict';
const { Writable } = require('node:stream');

const real = process.stdout;
const delayMs = Number(process.env.TAMPERWARD_TEST_ASYNC_STDOUT_MS || 5);
const slow = new Writable({
  write(chunk, encoding, cb) {
    setTimeout(() => real.write(chunk, encoding, cb), delayMs);
  },
});
Object.assign(slow, { isTTY: false, columns: 80, fd: 1 });
Object.defineProperty(process, 'stdout', { value: slow, configurable: true, enumerable: true, writable: true });
