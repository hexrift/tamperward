// #749 step 1: the project hook wiring of the experimental runtimes is control surface.
// `.codex/config.toml` is where Codex reads project hooks and `.github/hooks/tamperward.json`
// is where the Copilot CLI reads repository hooks. Both are protected hooks by default, and
// hook-tampering reads each at the grain its format has: the `[hooks]` tables of the TOML,
// the `hooks` member of the JSON. An agent on either runtime cannot remove or weaken its own
// interception before a protected edit without the gate seeing the wiring change.

import { describe, it, expect } from 'vitest';
import { hookTampering } from '../src/detectors/hook-tampering';
import { codexHooksWeakening, copilotHooksWeakening } from '../src/detectors/hook-wiring';
import { evaluate } from '../src/engine';
import { defaultPolicy, isProtected } from '../src/policy';
import { resolvesToRuntimeWiring, runtimeWiringOf } from '../src/wiring';
import { synthFileChange } from '../src/adapters/claude/changes';
import type { Change, CommandChange, FileChange } from '../src/types';

const P = defaultPolicy();
const cmd = (raw: string): CommandChange => ({ kind: 'command', raw, argv: raw.split(/\s+/) });
const file = (path: string, before: string | null, after: string | null, op: FileChange['op'] = 'modify', oldPath: string | null = null): FileChange => ({
  kind: 'file', path, oldPath, op, before, after, binary: false, hunks: [],
});
const edit = (path: string, before: string, after: string): Change[] => synthFileChange(path, before, after);
const msgs = (c: Change[]) => hookTampering.run(c, P).map((f) => `${f.message} ${f.evidence}`);

const CODEX = '.codex/config.toml';
const COPILOT = '.github/hooks/tamperward.json';

const PRE = 'npx --yes tamperward@2.39.0 hook codex';
const STOP = 'npx --yes tamperward@2.39.0 sweep codex';
const codexToml = (pre: string, stop: string, head = 'model = "gpt-5"\n'): string =>
  `${head}[hooks]\n[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${pre}"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "${stop}"\n`;
const CODEX_TOML = codexToml(PRE, STOP);

const copilotJson = (hooks: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, ...extra, hooks }, null, 2) + '\n';
const COPILOT_HOOKS = {
  preToolUse: [{ type: 'command', bash: 'npx --yes tamperward@2.39.0 hook copilot', timeoutSec: 30 }],
  agentStop: [{ type: 'command', bash: 'npx --yes tamperward@2.39.0 sweep copilot', timeoutSec: 30 }],
};
const COPILOT_JSON = copilotJson(COPILOT_HOOKS);

describe('the runtime hook wiring is protected hooks surface by default', () => {
  it.each([CODEX, COPILOT])('%s is in the default protected.hooks', (path) => {
    expect(isProtected(path, P, 'hooks')).toBe(true);
  });

  it.each([
    [CODEX, 'codex'],
    [COPILOT, 'copilot'],
    ['packages/app/.codex/config.toml', 'codex'],
    ['packages/app/.github/hooks/tamperward.json', 'copilot'],
    ['C:\\repo\\.codex\\config.toml', 'codex'],
  ])('%s is recognised as %s wiring at any depth', (path, runtime) => {
    expect(runtimeWiringOf(path)).toBe(runtime);
    expect(resolvesToRuntimeWiring(path)).toBe(runtime);
  });

  it.each(['.codex/hooks.json', '.github/hooks/other.json', 'config.toml', '.github/workflows/tamperward.json'])('%s is not runtime wiring', (path) => {
    expect(runtimeWiringOf(path)).toBeNull();
  });

  it.each([CODEX, COPILOT])('deleting %s is a blocking hook-tampering finding under the default policy', (path) => {
    const before = path === CODEX ? CODEX_TOML : COPILOT_JSON;
    const f = evaluate([file(path, before, null, 'delete')], P).filter((x) => x.rule === 'hook-tampering');
    expect(f.map((x) => x.severity)).toEqual(['block']);
    expect(f[0].message).toMatch(/deleted/);
  });

  it.each([CODEX, COPILOT])('renaming %s out of place is a finding', (path) => {
    const before = path === CODEX ? CODEX_TOML : COPILOT_JSON;
    expect(msgs([file(path + '.bak', before, before, 'rename', path)]).join()).toMatch(/renamed/);
  });

  it.each([`rm ${CODEX}`, `rm -f ${COPILOT}`, `echo "" > ${CODEX}`, `mv ${COPILOT} /tmp/`])('the shell write %s is a finding', (raw) => {
    expect(msgs([cmd(raw)]).join()).toMatch(/Hook tampering via shell/);
  });

  it.each([`cat ${CODEX}`, `git diff ${COPILOT}`])('the shell read %s is not', (raw) => {
    expect(msgs([cmd(raw)])).toEqual([]);
  });
});

describe('.codex/config.toml is read at the grain of its [hooks] tables', () => {
  it.each([
    ['the PreToolUse command removed', codexToml('true', STOP)],
    ['the Stop command removed', codexToml(PRE, 'true')],
    ['the gate piped into nothing', codexToml(`${PRE} | head -c0`, STOP)],
    ['the [hooks] tables deleted entirely', 'model = "gpt-5"\n'],
    ['the Stop table deleted', `model = "gpt-5"\n[hooks]\n[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "${PRE}"\n`],
    ['the matcher narrowed', CODEX_TOML.replace('matcher = "*"', 'matcher = "Read"')],
  ])('flags: %s', (_name, after) => {
    const m = msgs(edit(CODEX, CODEX_TOML, after));
    expect(m.length, m.join('\n')).toBe(1);
    expect(m[0]).toMatch(/Codex hook wiring/);
  });

  it('an edit outside the [hooks] tables is not a finding', () => {
    expect(msgs(edit(CODEX, CODEX_TOML, CODEX_TOML.replace('model = "gpt-5"', 'model = "gpt-5-mini"\napproval_policy = "never"')))).toEqual([]);
  });

  it('a comment or blank line inside the tables is not a finding', () => {
    expect(msgs(edit(CODEX, CODEX_TOML, CODEX_TOML.replace('[hooks]\n', '# project hooks\n[hooks]\n\n')))).toEqual([]);
  });

  it('a new config that arrives with hooks is not a finding, and one with none is not either', () => {
    expect(msgs([file(CODEX, null, CODEX_TOML, 'add')])).toEqual([]);
    expect(msgs([file(CODEX, null, 'model = "gpt-5"\n', 'add')])).toEqual([]);
  });

  it('hooks tables added to a config that had none are not a finding', () => {
    expect(msgs(edit(CODEX, 'model = "gpt-5"\n', CODEX_TOML))).toEqual([]);
  });

  it('on a hunk-only view a removed line running tamperward is the finding', () => {
    const c = edit(CODEX, CODEX_TOML, codexToml('true', STOP))[0] as FileChange;
    const m = msgs([{ ...c, before: null, after: null }]);
    expect(m.join()).toMatch(/Codex hook wiring/);
  });

  it('codexHooksWeakening names what was lost', () => {
    expect(codexHooksWeakening(CODEX_TOML, codexToml('true', 'true'))).toEqual([expect.stringMatching(/tamperward.*removed from the \[hooks\] tables/)]);
    expect(codexHooksWeakening(CODEX_TOML, CODEX_TOML.replace('matcher = "*"', 'matcher = "Read"'))).toEqual([expect.stringMatching(/\[hooks\] tables changed/)]);
    expect(codexHooksWeakening(CODEX_TOML, CODEX_TOML)).toEqual([]);
  });
});

describe('.github/hooks/tamperward.json is read at the grain of its hooks member', () => {
  it.each([
    ['preToolUse emptied', copilotJson({ ...COPILOT_HOOKS, preToolUse: [] })],
    ['agentStop removed', copilotJson({ preToolUse: COPILOT_HOOKS.preToolUse })],
    ['the gate replaced by true', copilotJson({ ...COPILOT_HOOKS, preToolUse: [{ type: 'command', bash: 'true' }] })],
    ['the timeout shortened', copilotJson({ ...COPILOT_HOOKS, preToolUse: [{ ...COPILOT_HOOKS.preToolUse[0], timeoutSec: 1 }] })],
    ['hooks removed entirely', JSON.stringify({ version: 1 }) + '\n'],
    ['the file no longer parses', '{ "hooks": '],
  ])('flags: %s', (_name, after) => {
    const m = msgs(edit(COPILOT, COPILOT_JSON, after));
    expect(m.length, m.join('\n')).toBe(1);
    expect(m[0]).toMatch(/Copilot CLI hook wiring/);
  });

  it('a change outside hooks, or a reformat, is not a finding', () => {
    expect(msgs(edit(COPILOT, COPILOT_JSON, copilotJson(COPILOT_HOOKS, { description: 'tamperward gate' })))).toEqual([]);
    expect(msgs(edit(COPILOT, COPILOT_JSON, JSON.stringify({ version: 1, hooks: COPILOT_HOOKS })))).toEqual([]);
  });

  it('a hook added beside the gate is a sign-off, as it is in the Claude wiring: its output combines with the gate verdict', () => {
    const more = { ...COPILOT_HOOKS, preToolUse: [...COPILOT_HOOKS.preToolUse, { type: 'command', bash: 'echo audit' }] };
    expect(msgs(edit(COPILOT, COPILOT_JSON, copilotJson(more))).join()).toMatch(/"hooks" entries changed/);
  });

  it('a new wiring file is not a finding, with or without hooks', () => {
    expect(msgs([file(COPILOT, null, COPILOT_JSON, 'add')])).toEqual([]);
    expect(msgs([file(COPILOT, null, '{}\n', 'add')])).toEqual([]);
  });

  it('on a hunk-only view a removed line running tamperward is the finding', () => {
    const c = edit(COPILOT, COPILOT_JSON, copilotJson({ ...COPILOT_HOOKS, agentStop: [] }))[0] as FileChange;
    expect(msgs([{ ...c, before: null, after: null }]).join()).toMatch(/Copilot CLI hook wiring/);
  });

  it('copilotHooksWeakening names what was lost', () => {
    expect(copilotHooksWeakening(COPILOT_JSON, copilotJson({}))).toEqual([expect.stringMatching(/tamperward.*removed from "hooks"/)]);
    expect(copilotHooksWeakening(COPILOT_JSON, '{ "hooks": ')).toEqual([expect.stringMatching(/no longer parses as JSON/)]);
    expect(copilotHooksWeakening(COPILOT_JSON, COPILOT_JSON)).toEqual([]);
    expect(copilotHooksWeakening('{ not json', COPILOT_JSON)).toEqual([]);
  });
});

describe('nested wiring is judged even when the policy names only the root', () => {
  it('a nested .codex/config.toml whose hooks lose the gate is a finding', () => {
    const path = 'packages/app/.codex/config.toml';
    expect(isProtected(path, P, 'hooks')).toBe(false);
    expect(msgs(edit(path, CODEX_TOML, codexToml('true', STOP))).join()).toMatch(/Codex hook wiring/);
  });
});
