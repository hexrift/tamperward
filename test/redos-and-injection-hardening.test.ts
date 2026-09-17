// Regressions for the CodeQL "High" findings on shipped code: three ReDoS-class
// regexes, one second-order command-injection surface, and one incomplete escape.
// Each fix is proven two ways where it matters — the behaviour is unchanged on
// normal input, and a crafted payload that the old form choked on now returns
// promptly. The time bounds are deliberately generous; the point is "does not
// hang", not a benchmark. The pre-fix forms took many seconds on these inputs.

import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/diff/parse';
import type { FileChange } from '../src/types';
import { parseStraceFileAccess } from '../src/cli/trace-verify';
import { shellTokens } from '../src/dependency-env';
import { cell } from '../src/cli/render/github';
import { cloneArgs } from '../src/research/run';

function elapsed(fn: () => void): number {
  const t = Date.now();
  fn();
  return Date.now() - t;
}

describe('diff header parse — ReDoS (src/diff/parse.ts)', () => {
  it('still resolves a renamed path that contains spaces', () => {
    const diff = `diff --git a/old file.ts b/new file.ts
similarity index 100%
rename from old file.ts
rename to new file.ts`;
    const changes = parseDiff(diff).map((c) => c as FileChange);
    expect(changes.map((c) => c.op)).toEqual(['rename']);
    expect(changes[0].path).toBe('new file.ts');
  });

  it('does not hang on a header line of spaces with no ` b/`', () => {
    const diff = `diff --git a/${' '.repeat(80_000)}`;
    let out: unknown;
    const ms = elapsed(() => {
      out = parseDiff(diff);
    });
    expect(Array.isArray(out)).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });
});

describe('strace path parse — ReDoS (src/cli/trace-verify.ts)', () => {
  it('still extracts the quoted path of a normal syscall line', () => {
    const raw = 'openat(AT_FDCWD, "/etc/passwd", O_RDONLY) = 3';
    expect(parseStraceFileAccess(raw)).toEqual([{ path: '/etc/passwd', access: 'read' }]);
  });

  it('does not hang on an unterminated quote full of backslashes', () => {
    const raw = `open("${'\\'.repeat(60_000)}`;
    let out: unknown;
    const ms = elapsed(() => {
      out = parseStraceFileAccess(raw);
    });
    expect(Array.isArray(out)).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });
});

describe('shell tokeniser — ReDoS (src/dependency-env.ts)', () => {
  it('tokenises the same way as before the fix', () => {
    expect(shellTokens('npm run build')).toEqual(['npm', 'run', 'build']);
    expect(shellTokens('env FOO=1 "my cmd" \'x\'')).toEqual(['env', 'FOO=1', 'my cmd', 'x']);
  });

  it('does not hang on a quote followed by a long backslash run', () => {
    const command = `"${'\\'.repeat(50_000)}`;
    let out: unknown;
    const ms = elapsed(() => {
      out = shellTokens(command);
    });
    expect(Array.isArray(out)).toBe(true);
    expect(ms).toBeLessThan(1_000);
  });
});

describe('markdown table cell escape (src/cli/render/github.ts)', () => {
  it('escapes a bare pipe', () => {
    expect(cell('x|y')).toBe('x\\|y');
  });

  it('escapes the backslash before the pipe, so a crafted `\\|` cannot survive', () => {
    expect(cell('x\\y')).toBe('x\\\\y');
    expect(cell('x\\|y')).toBe('x\\\\\\|y');
  });
});

describe('research clone argv — command-injection hardening (src/research/run.ts)', () => {
  it('disables the ext:: transport and ends options before the repo', () => {
    const args = cloneArgs('https://example.com/r.git', '/tmp/ws');
    expect(args).toEqual([
      '-c', 'protocol.ext.allow=never',
      'clone', '-q', '--no-hardlinks', '--',
      'https://example.com/r.git', '/tmp/ws',
    ]);
    // `--` immediately precedes the repo, so neither a `-`-prefixed value nor an
    // `ext::` URL can be read as an option.
    const dashDash = args.indexOf('--');
    expect(args[dashDash + 1]).toBe('https://example.com/r.git');
  });

  it('keeps a hostile repo value in positional territory, after `--`', () => {
    const args = cloneArgs('ext::sh -c "id"', '/tmp/ws');
    expect(args.indexOf('ext::sh -c "id"')).toBeGreaterThan(args.indexOf('--'));
    expect(args).toContain('protocol.ext.allow=never');
  });
});
