import { describe, it, expect } from 'vitest';
import { changesFromClaudeHook } from '../src/adapters/claude/changes';
import { Change } from '../src/types';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A recorded corpus of Claude Code tool payload shapes — one per tool and mode — pinned
// to the exact Change[] the adapter models for each. It exists so a field the runtime adds
// to a payload (or a change in how the adapter interprets one) surfaces as a test failure
// here instead of a silent modelling drift. See #418: `replace_all` was such a field, and
// the adapter ignored it.

// The on-disk spec that before-content is read from. Three `it(` blocks so `replace_all`
// touches every occurrence while a single Edit touches exactly one.
const SPEC = `it('a', () => { expect(1).toBe(1); });\nit('b', () => { expect(2).toBe(2); });\nit('c', () => { expect(3).toBe(3); });\n`;

function fixtureCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-corpus-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), SPEC);
  return dir;
}

/** Project a Change to its stable, load-bearing fields (the derived hunks are not pinned —
 *  the predicted `after` content is what the hash and the detectors consume). */
function project(c: Change): Record<string, unknown> {
  if (c.kind === 'command') return { kind: 'command', raw: c.raw, argv: c.argv };
  return { kind: 'file', path: c.path, op: c.op, after: c.after };
}

describe('Claude payload corpus — recorded shapes → expected Change[]', () => {
  interface Row {
    name: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    expected: (cwd: string) => Record<string, unknown>[];
  }

  const rows: Row[] = [
    {
      name: 'Bash',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      expected: () => [{ kind: 'command', raw: 'npm test', argv: ['npm', 'test'] }],
    },
    {
      name: 'Write (new file)',
      tool_name: 'Write',
      tool_input: { file_path: 'PLACEHOLDER:src/new.ts', content: 'export const x = 1;\n' },
      expected: () => [{ kind: 'file', path: 'src/new.ts', op: 'add', after: 'export const x = 1;\n' }],
    },
    {
      name: 'Edit (single)',
      tool_name: 'Edit',
      tool_input: { file_path: 'PLACEHOLDER:src/a.spec.ts', old_string: `it('a'`, new_string: `it.skip('a'` },
      expected: () => [{ kind: 'file', path: 'src/a.spec.ts', op: 'modify', after: SPEC.replace(`it('a'`, `it.skip('a'`) }],
    },
    {
      name: 'Edit (replace_all: true)',
      tool_name: 'Edit',
      tool_input: { file_path: 'PLACEHOLDER:src/a.spec.ts', old_string: 'it(', new_string: 'it.skip(', replace_all: true },
      expected: () => [{ kind: 'file', path: 'src/a.spec.ts', op: 'modify', after: SPEC.replaceAll('it(', 'it.skip(') }],
    },
    {
      name: 'MultiEdit (mixed single + replace_all)',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'PLACEHOLDER:src/a.spec.ts',
        edits: [
          { old_string: `it('a'`, new_string: `it('A'` },
          { old_string: 'expect(', new_string: 'assert(', replace_all: true },
        ],
      },
      expected: () => [
        {
          kind: 'file',
          path: 'src/a.spec.ts',
          op: 'modify',
          after: SPEC.replace(`it('a'`, `it('A'`).replaceAll('expect(', 'assert('),
        },
      ],
    },
    {
      name: 'NotebookEdit (insert)',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'PLACEHOLDER:nb.ipynb', edit_mode: 'insert', new_source: 'print(1)\n' },
      expected: () => [{ kind: 'file', path: 'nb.ipynb', op: 'modify', after: 'print(1)\n' }],
    },
    {
      name: 'NotebookEdit (replace)',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'PLACEHOLDER:nb.ipynb', edit_mode: 'replace', new_source: 'print(2)\n' },
      expected: () => [{ kind: 'file', path: 'nb.ipynb', op: 'modify', after: 'print(2)\n' }],
    },
    {
      // A delete carries no new_source; the adapter models nothing from the PreToolUse
      // payload alone — the removed cell is the Stop sweep's job (it re-derives the turn's
      // net diff from git). Pinned so a future attempt to model it here is a deliberate change.
      name: 'NotebookEdit (delete)',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'PLACEHOLDER:nb.ipynb', edit_mode: 'delete' },
      expected: () => [],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const cwd = fixtureCwd();
      // Resolve PLACEHOLDER-prefixed paths to absolute paths inside the fixture cwd, the way
      // the runtime always sends absolute tool paths.
      const ti: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row.tool_input)) {
        ti[k] = typeof v === 'string' && v.startsWith('PLACEHOLDER:') ? join(cwd, v.slice('PLACEHOLDER:'.length)) : v;
      }
      const changes = changesFromClaudeHook({ tool_name: row.tool_name, tool_input: ti, cwd }, cwd);
      expect(changes.map(project)).toEqual(row.expected(cwd));
    });
  }

  // ── acceptance for #418: the predicted content/hash of a replace_all edit equals applying
  //    that same edit to the real file bytes on disk (what the tool will actually write). ──
  it('replace_all: predicted content and hash match the post-write file bytes', () => {
    const cwd = fixtureCwd();
    const file = join(cwd, 'src', 'a.spec.ts');
    const payload = {
      tool_name: 'Edit',
      cwd,
      tool_input: { file_path: file, old_string: 'it(', new_string: 'it.skip(', replace_all: true },
    };

    const changes = changesFromClaudeHook(payload, cwd);
    expect(changes).toHaveLength(1);
    const c = changes[0];
    expect(c.kind).toBe('file');
    if (c.kind !== 'file') throw new Error('unreachable');
    const predicted = c.after ?? '';

    // Every occurrence is reflected, not just the first.
    expect((predicted.match(/it\.skip\(/g) ?? []).length).toBe(3);

    // Apply the SAME edit to the real file bytes the way the Edit tool would, then compare.
    const postWrite = readFileSync(file, 'utf8').replaceAll('it(', 'it.skip(');
    expect(predicted).toBe(postWrite);

    // The hash sanctionPredictedWrites would record must equal the hash of the post-write
    // bytes — otherwise the next call re-judges the same edit via drift.
    const hashOf = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
    expect(hashOf(predicted)).toBe(hashOf(postWrite));
  });

  it('without replace_all, a unique old_string is replaced exactly once', () => {
    const cwd = fixtureCwd();
    const file = join(cwd, 'src', 'a.spec.ts');
    const changes = changesFromClaudeHook(
      { tool_name: 'Edit', cwd, tool_input: { file_path: file, old_string: `it('b'`, new_string: `it.skip('b'` } },
      cwd,
    );
    const c = changes[0];
    if (c.kind !== 'file') throw new Error('unreachable');
    expect((c.after?.match(/it\.skip\(/g) ?? []).length).toBe(1);
    expect(c.after).toBe(SPEC.replace(`it('b'`, `it.skip('b'`));
  });
});
