// The `typescript` package is loaded on first use, not at startup (#322): a hook
// call that never needs the AST — a Bash command, an edit outside JS/TS — must
// not pay for the 9 MB parser, and a protected JS/TS edit must still reach the
// AST path with the same verdict as before.
//
// This file must be the only thing that runs in its worker: the assertion on
// "not loaded yet" is process-wide. Vitest isolates test files, and the first
// `evaluate` here happens before anything in this file could have touched it.

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../src/engine';
import { defaultPolicy } from '../src/policy';
import { changesFromClaudeHook, synthFileChange } from '../src/adapters/claude/changes';
import { tsLoaded } from '../src/ts-lazy';
import type { CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const file = (path: string, before: string, after: string): FileChange[] => synthFileChange(path, before, after);

describe('typescript is loaded lazily', () => {
  it('a Bash-only call and a non-JS protected edit never load the parser', () => {
    expect(tsLoaded()).toBe(false);
    const bash = evaluate([cmd('git commit --no-verify -m wip')], P, undefined, 'tool-call');
    expect(bash.some((f) => f.rule === 'no-verify')).toBe(true);
    expect(tsLoaded()).toBe(false);

    const py = evaluate(
      file('tests/test_a.py', 'def test_a():\n    assert 1 == 1\n', 'import pytest\n@pytest.mark.skip\ndef test_a():\n    assert 1 == 1\n'),
      P,
      undefined,
      'tool-call',
    );
    expect(py.some((f) => f.rule === 'test-skip')).toBe(true);
    expect(tsLoaded()).toBe(false);
  });

  it('a protected JS edit loads it and still gets the AST verdict', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tw-lazy-'));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
    const changes = changesFromClaudeHook(
      {
        tool_name: 'Edit',
        cwd,
        tool_input: {
          file_path: join(cwd, 'src/a.spec.ts'),
          old_string: `it('one', () => {}); it('two', () => {});`,
          new_string: `it('one', () => {});`,
        },
      },
      cwd,
    );
    const f = evaluate(changes, P, undefined, 'tool-call', { cwd });
    expect(f.some((x) => x.rule === 'test-deletion')).toBe(true);
    expect(tsLoaded()).toBe(true);
    // A comment is not a test: the verdict came from the AST, not a line regex.
    const commentOnly = evaluate(
      file('src/b.spec.ts', `// it('phantom', () => {})\nit('real', () => {});\n`, `it('real', () => {});\n`),
      P,
      undefined,
      'tool-call',
    );
    expect(commentOnly.some((x) => x.rule === 'test-deletion')).toBe(false);
  });
});
