// pytest opens exactly ONE inifile. That makes the effective configuration a
// property of the FILE SET, not of any single file — so a change can narrow the
// suite without any one file's before→after being a narrowing:
//
//   * delete the shadowing `pytest.ini` and a narrowing `setup.cfg` that was inert
//     for the whole life of the repository springs into effect. The deleted file
//     was benign; the narrowing file was not touched at all;
//   * add an EMPTY `pytest.ini` and it shadows a `setup.cfg` that had widened
//     collection (`norecursedirs =`), so specs the suite used to collect are
//     dropped by pytest's own defaults. Nothing in the added file is narrower than
//     the defaults — it IS the defaults; the narrowing is the shadowing.
//
// Both are invisible to a per-file before→after comparison. The negatives matter
// as much: an edit or deletion that leaves the effective configuration alone must
// stay silent, because a false positive lands in the gated arm alone.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import { testDeletion } from '../src/detectors/test-deletion';
import type { Change, DetectorContext, FileChange, FileOp } from '../src/types';

const P = defaultPolicy();

function diffed(path: string, before: string | null, after: string | null, op?: FileOp): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pp-'));
  writeFileSync(join(dir, 'a'), before ?? '');
  writeFileSync(join(dir, 'b'), after ?? '');
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0] as FileChange | undefined;
  return {
    kind: 'file', path, oldPath: null,
    op: op ?? (before == null ? 'add' : after == null ? 'delete' : 'modify'),
    before, after, binary: false, hunks: parsed?.hunks ?? [],
  };
}
const msgs = (c: Change[], ctx?: DetectorContext) =>
  testDeletion.run(c, P, 'staged', ctx).map((f) => `${f.message} ${f.evidence}`);

// A repository whose suite lives in tests/ and whose specs are the pytest default
// shapes. `tracked` is what `git ls-files` would answer; `contents` supplies the
// files the change did NOT touch (unchanged ⇒ identical at base, head and worktree).
const ctxOf = (tracked: string[], contents: Record<string, string>): DetectorContext => ({
  // build/test_legacy.py is a PROTECTED spec by basename, collected only while
  // something widens pytest's default `norecursedirs`.
  trackedFiles: [...tracked, 'tests/test_calc.py', 'tests/test_slow.py', 'build/test_legacy.py', 'src/calc.py'],
  trackedContents: contents,
});

const NARROW_SETUP_CFG = '[tool:pytest]\naddopts = -k "not slow"\n';
// widened: with no norecursedirs at all, pytest stops skipping build/ and dist/
const WIDE_SETUP_CFG = '[tool:pytest]\nnorecursedirs =\n';

describe('pytest inifile precedence — a transition can narrow with no narrowing edit', () => {
  it('flags deleting the shadowing pytest.ini when it activates a narrowing setup.cfg', () => {
    const out = msgs(
      [diffed('pytest.ini', '[pytest]\n', null, 'delete')],
      ctxOf(['pytest.ini', 'setup.cfg'], { 'setup.cfg': NARROW_SETUP_CFG }),
    );
    expect(out.join('\n')).toMatch(/setup\.cfg/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('flags adding an EMPTY pytest.ini that shadows a setup.cfg which had widened collection', () => {
    // the added file contains nothing narrower than pytest's defaults; the narrowing
    // is that it takes the inifile slot away from the file that widened collection
    const out = msgs(
      [diffed('pytest.ini', null, '[pytest]\n', 'add')],
      ctxOf(['setup.cfg'], { 'setup.cfg': WIDE_SETUP_CFG }),
    );
    expect(out.join('\n')).toMatch(/build\/test_legacy\.py/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('names the transition in the evidence, not just the file', () => {
    const out = msgs(
      [diffed('pytest.ini', '[pytest]\n', null, 'delete')],
      ctxOf(['pytest.ini', 'setup.cfg'], { 'setup.cfg': NARROW_SETUP_CFG }),
    );
    expect(out.join('\n')).toMatch(/pytest\.ini/);
  });
});

describe('pytest inifile precedence — the negatives, which must stay silent', () => {
  it('does not flag deleting an INERT lower-precedence config', () => {
    // setup.cfg never applied: pytest.ini shadowed it and still does.
    expect(
      msgs(
        [diffed('setup.cfg', NARROW_SETUP_CFG, null, 'delete')],
        ctxOf(['pytest.ini', 'setup.cfg'], { 'pytest.ini': '[pytest]\n' }),
      ),
    ).toEqual([]);
  });

  it('does not flag editing an INERT lower-precedence config', () => {
    expect(
      msgs(
        [diffed('setup.cfg', '[tool:pytest]\n', NARROW_SETUP_CFG)],
        ctxOf(['pytest.ini', 'setup.cfg'], { 'pytest.ini': '[pytest]\n' }),
      ),
    ).toEqual([]);
  });

  it('does not flag removing every pytest config — the defaults are BROADER', () => {
    expect(
      msgs(
        [diffed('pytest.ini', '[pytest]\naddopts = -k "not slow"\n', null, 'delete')],
        ctxOf(['pytest.ini'], {}),
      ),
    ).toEqual([]);
  });

  it('does not flag a transition to a BROADER effective config', () => {
    // the narrowing file goes away and a benign one takes over
    expect(
      msgs(
        [diffed('pytest.ini', '[pytest]\naddopts = -k "not slow"\n', null, 'delete')],
        ctxOf(['pytest.ini', 'setup.cfg'], { 'setup.cfg': '[tool:pytest]\n' }),
      ),
    ).toEqual([]);
  });

  it('does not treat a NESTED pytest.ini as the rootdir config', () => {
    expect(
      msgs(
        [diffed('tests/pytest.ini', '[pytest]\n', null, 'delete')],
        ctxOf(['tests/pytest.ini', 'setup.cfg'], { 'setup.cfg': NARROW_SETUP_CFG }),
      ),
    ).toEqual([]);
  });

  it('does not let a pyproject.toml WITHOUT a pytest table claim precedence', () => {
    // deleting pytest.ini must activate tox.ini, not the pytest-less pyproject.toml
    const out = msgs(
      [diffed('pytest.ini', '[pytest]\n', null, 'delete')],
      ctxOf(['pytest.ini', 'pyproject.toml', 'tox.ini'], {
        'pyproject.toml': '[project]\nname = "demo"\n',
        'tox.ini': '[pytest]\naddopts = -k "not slow"\n',
      }),
    );
    expect(out.join('\n')).toMatch(/tox\.ini/);
  });

  it('stays silent when the unchanged files cannot be read', () => {
    // no contents in hand: guessing costs a false positive in the gated arm alone
    expect(msgs([diffed('pytest.ini', '[pytest]\n', null, 'delete')], { trackedFiles: ['pytest.ini', 'setup.cfg'] })).toEqual([]);
  });
});
