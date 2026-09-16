// Exit only once what was written to stdout has left the process (#415).
//
// `process.exit(code)` straight after `process.stdout.write(doc)` truncates `doc`
// whenever the write did not complete synchronously. Node's contract: pipes and
// sockets are ASYNCHRONOUS on POSIX (Linux and macOS) and synchronous on Windows —
// so the async case is the normal one for every consumer that parses this CLI (Claude
// Code reading a hook verdict, CI reading `--json` / `--format github`), and the write
// also backs up once the kernel buffer is full and the reader is slow. Whatever is
// still queued dies with the process. For the hook that is a fail-open: a deny whose
// JSON is cut off is a malformed hook response, and Claude Code ignores those and proceeds.
//
// So the CLI never calls `process.exit` on its own after parsed output. It sets
// `process.exitCode` — the code the process carries if it drains naturally — and exits
// from a write callback that the stream invokes only after everything queued before it
// has been handed to the OS. stderr is flushed the same way, so a diagnostic written
// just before a non-zero exit is not lost on the same platforms. On Linux the callbacks
// fire on the next tick and the behaviour is exactly what it was.

const noop = (): void => {};

/** Exit with `code` once stdout and stderr have drained. Never returns control to the
 *  caller's business logic: everything after the call runs only until the flush
 *  completes, which on a synchronous stream is the next tick. */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 0;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  for (const stream of [process.stdout, process.stderr]) {
    pending += 1;
    // A consumer that closed its end (EPIPE) surfaces as an 'error' after the callback;
    // the output is gone either way and the exit code is what the caller decided.
    stream.on('error', noop);
    stream.write('', done);
  }
}
