// #611 (layer a): the EXPERIMENTAL GitHub Copilot SDK-HOSTED RuntimeAdapter conforms to the
// neutral steering contract over the `@github/copilot-sdk` `onPermissionRequest` /
// `onAgentStop` surface. The host JSON-serialises each SDK `PermissionRequest` (kind /
// toolName / toolCallId / fileName / fullCommandText) and hands it to `decide`, which reuses
// the SAME engine as every other surface for its shell content decision and DELEGATES the
// end-of-turn sweep to the canonical git sweep. It is conservative and honest about what it
// does NOT prove on a pinned SDK: `preDeny` is empty (enforcement unmeasured). A `write` request
// surfaces the proposed change (diff / newFileContents), so content-aware file-edit pre-deny is
// CONDITIONAL — reconstructed (bound to the request's fileName, conservatively) and content-judged,
// or `unsupported` only for a config that surfaces no usable content.
// Payloads are synthetic and inline; there are no fixture files.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotSdkAdapter, CopilotSdkHostedAdapter } from '../src/adapters/copilot-sdk/adapter';
import { copilotSdkDenyWire, copilotSdkWire } from '../src/adapters/copilot-sdk/deny';
import { normalizeCopilotSdkEvent, copilotSdkOperationKind, copilotSdkStopInput } from '../src/adapters/copilot-sdk/schema';
import { formatDenial } from '../src/adapters/claude/deny';
import { Finding } from '../src/types';

function repoFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-copilot-sdk-')));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir });
  g(['init', '-q']);
  g(['config', 'user.email', 'h@x']);
  g(['config', 'user.name', 'h']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.spec.ts'), `it('one', () => {}); it('two', () => {});\n`);
  writeFileSync(join(dir, '.tamperward.yml'), "version: 1\nprotected:\n  tests: ['**/*.spec.ts']\n");
  g(['add', '-A']);
  g(['commit', '-qm', 'seed']);
  return dir;
}

// A JSON-serialised SDK preToolUse PermissionRequest, as the host hands it to decide().
function req(cwd: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ toolCallId: 't1', sessionId: 's1', cwd, ...fields });
}
const shellReq = (cwd: string, fullCommandText: string) => req(cwd, { kind: 'shell', toolName: 'shell', fullCommandText });
// A write request as the current SDK surfaces it: fileName + diff + intention + optional newFileContents.
const writeReq = (cwd: string, fileName: string, extra: Record<string, unknown> = {}) => req(cwd, { kind: 'write', toolName: 'write', fileName, ...extra });

const findings: Finding[] = [
  { rule: 'test-deletion', severity: 'block', file: 'src/a.spec.ts', message: 'A protected test file was removed.', evidence: 'rm src/a.spec.ts', remediation: 'Fix the failing test.', signoff: { required: true, command: 'tamperward allow --reason "..."' } },
];

describe('CopilotSdkHostedAdapter — identity and capability honesty', () => {
  it('exposes a stable, DISTINCT name from the CLI adapter', () => {
    expect(copilotSdkAdapter.name).toBe('github-copilot-sdk-hosted');
    expect(new CopilotSdkHostedAdapter().name).toBe('github-copilot-sdk-hosted');
  });

  it('is CONSERVATIVE: preDeny/postObserve empty, endOfTurn true, unsupported names the real gaps', () => {
    const caps = copilotSdkAdapter.capabilities;
    expect(caps.preDeny).toEqual([]);
    expect(caps.postObserve).toEqual([]);
    expect(caps.endOfTurn).toBe(true);
    const u = caps.unsupported.join(' | ');
    // file-edit content-aware pre-deny is CONDITIONAL on what the pinned SDK surfaces (write
    // requests carry diff + optional newFileContents); it is not hard-coded unsupported.
    expect(u).toMatch(/conditional|diff|newFileContents/i);
    // the decisive unknown: handler throw / reject / timeout fail-open-vs-closed is unmeasured.
    expect(u).toMatch(/throw|reject|timeout/i);
    // onAgentStop is a lifecycle continuation control (block/continue), not a filesystem veto.
    expect(u).toMatch(/onAgentStop|continuation/i);
  });
});

describe('copilotSdkOperationKind — SDK permission kinds → neutral operation kind', () => {
  it('maps each documented SDK kind', () => {
    expect(copilotSdkOperationKind('shell')).toBe('shell');
    expect(copilotSdkOperationKind('write')).toBe('file-edit');
    expect(copilotSdkOperationKind('read')).toBe('file-read');
    expect(copilotSdkOperationKind('mcp')).toBe('mcp');
    expect(copilotSdkOperationKind('custom-tool')).toBe('other');
    expect(copilotSdkOperationKind('url')).toBe('other');
    expect(copilotSdkOperationKind('memory')).toBe('other');
    expect(copilotSdkOperationKind('hook')).toBe('other');
    expect(copilotSdkOperationKind(undefined)).toBe('other');
  });
});

describe('normalizeCopilotSdkEvent — permission request → neutral event', () => {
  it('a shell request carries fullCommandText as the command arg', () => {
    const ev = normalizeCopilotSdkEvent(shellReq('/repo', 'rm src/a.spec.ts'), 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('shell');
    expect(ev.operation.args).toEqual({ command: 'rm src/a.spec.ts' });
    expect(ev.identity).toEqual({ claimedCwd: '/repo', sessionId: 's1' });
  });

  it('a write request retains path + content fields (diff / newFileContents / intention)', () => {
    const ev = normalizeCopilotSdkEvent(writeReq('/repo', 'src/a.spec.ts', { diff: '@@ -1 +1 @@', newFileContents: 'x', intention: 'weaken' }), 'pre-action');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation.kind).toBe('file-edit');
    expect(ev.operation.args).toEqual({ path: 'src/a.spec.ts', diff: '@@ -1 +1 @@', newFileContents: 'x', intention: 'weaken' });
  });

  it('end-of-turn is a synthetic stop op regardless of request fields', () => {
    const ev = normalizeCopilotSdkEvent(shellReq('/repo', 'rm x'), 'end-of-turn');
    expect('failure' in ev).toBe(false);
    if ('failure' in ev) return;
    expect(ev.operation).toEqual({ kind: 'other', name: 'stop', args: {} });
  });

  it('empty input is a well-formed absence; a JSON array/primitive is a parse-failure', () => {
    expect('failure' in normalizeCopilotSdkEvent('', 'pre-action')).toBe(false);
    expect('failure' in normalizeCopilotSdkEvent('[1,2,3]', 'pre-action')).toBe(true);
    expect('failure' in normalizeCopilotSdkEvent('nope{', 'pre-action')).toBe(true);
  });

  it('copilotSdkStopInput maps sessionId/cwd to the Claude Stop shape the git sweep consumes', () => {
    const s = copilotSdkStopInput(JSON.stringify({ sessionId: 's9', cwd: '/repo', stopHookActive: true }));
    expect(typeof s).toBe('string');
    if (typeof s !== 'string') return;
    expect(JSON.parse(s)).toEqual({ cwd: '/repo', session_id: 's9', stop_hook_active: true });
  });
});

describe('copilotSdkDenyWire — the SDK PermissionRequestResult / agentStop shapes', () => {
  it('pre-action deny is the SDK reject RESULT discriminated on kind, with feedback', () => {
    const wire = copilotSdkDenyWire(findings, 'pre-action');
    const j = JSON.parse(wire);
    expect(j.kind).toBe('reject'); // PermissionRequestResult is discriminated on `kind`
    expect(j.feedback).toBe(formatDenial(findings));
    expect(j.decision).toBeUndefined(); // NOT the agentStop shape
    expect(j.permissionDecision).toBeUndefined(); // NOT the CLI hook shape
  });

  it('end-of-turn deny is the agentStop block/continue shape (decision, not kind)', () => {
    const j = JSON.parse(copilotSdkWire('because', 'end-of-turn'));
    expect(j.decision).toBe('block');
    expect(j.reason).toBe('because');
    expect(j.kind).toBeUndefined();
  });

  it('no findings is an allow (empty wire)', () => {
    expect(copilotSdkDenyWire([], 'pre-action')).toBe('');
  });
});

describe('CopilotSdkHostedAdapter.decide — shell content deny via the shared engine', () => {
  it('denies a protected shell deletion with the SDK reject wire', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(shellReq(cwd, 'rm src/a.spec.ts'), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      const j = JSON.parse(r.wire as string);
      expect(j.kind).toBe('reject');
      expect(j.feedback).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows a benign shell read (empty wire)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(shellReq(cwd, 'cat src/a.spec.ts'), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotSdkHostedAdapter.decide — file-edit content-aware pre-deny is CONDITIONAL on surfaced content', () => {
  it('a write whose newFileContents WEAKENS a protected test is denied (content-aware, via the shared engine)', () => {
    const cwd = repoFixture();
    try {
      // Full new content that drops an assertion → the engine's content detectors block it.
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { newFileContents: `it('one', () => {});\n` }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      expect(JSON.parse(r.wire as string).kind).toBe('reject');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write whose diff removes a protected test is denied (reconstructed from the unified diff)', () => {
    const cwd = repoFixture();
    try {
      const diff = ['--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write whose diff header names a DIFFERENT file than fileName fails CLOSED (proposal binding, #611)', () => {
    const cwd = repoFixture();
    try {
      // The permission request authorizes a write to the PROTECTED spec, but the diff headers name
      // a benign file. TamperWard must NOT judge the benign path — it binds to fileName and fails closed.
      const diff = ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-hello', '+hello world'].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff whose deletion line does not match the on-disk file fails CLOSED (no synthetic guess)', () => {
    const cwd = repoFixture();
    try {
      // The `-` line does NOT match the disk; if it were mis-applied the synthetic `after` would
      // KEEP both tests (benign → allow). Verification must instead fail closed rather than judge a guess.
      const diff = ['--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-DOES NOT MATCH DISK", "+it('one', () => {}); it('two', () => {}); it('three', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff with overlapping / backwards hunks fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      // Both hunks would (if mis-applied) keep the tests intact (benign → allow); the backwards
      // second hunk must fail closed instead of producing a judged synthetic change.
      const diff = [
        '--- a/src/a.spec.ts',
        '+++ b/src/a.spec.ts',
        '@@ -1 +1 @@',
        "-it('one', () => {}); it('two', () => {});",
        "+it('one', () => {}); it('two', () => {}); it('a', () => {});",
        '@@ -1 +1 @@', // second hunk goes backwards over the first → must fail closed
        "-it('one', () => {}); it('two', () => {});",
        "+it('one', () => {}); it('two', () => {}); it('b', () => {});",
      ].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a non-empty diff that parses to ZERO valid hunks fails CLOSED (malformed → not a no-op allow)', () => {
    const cwd = repoFixture();
    try {
      // A malformed @@ header is skipped by parseDiff, leaving hunks:[]. That must not become
      // "nothing changed → allow"; a non-empty modify diff with no valid hunk fails closed.
      const diff = ['@@ THIS IS NOT A VALID HUNK HEADER', "-it('one', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('when BOTH newFileContents and diff are supplied and DISAGREE, it fails CLOSED (ambiguous request)', () => {
    const cwd = repoFixture();
    try {
      // Benign full content (keeps all tests) alongside a weakening diff (drops one) → ambiguous;
      // must not silently approve the benign representation.
      const newFileContents = `it('one', () => {}); it('two', () => {}); it('three', () => {});\n`;
      const diff = ['--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { newFileContents, diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a diff-only INSERTION into an EXISTING file is reconstructed by git and judged, not misclassified as a create', () => {
    const cwd = repoFixture();
    try {
      // A well-formed insertion hunk (one context line + an added line). git apply anchors it to the
      // existing file — before !== null so it is NOT a create — and the benign insertion → allow.
      const diff = ['@@ -1,1 +1,2 @@', ' it(\'one\', () => {}); it(\'two\', () => {});', "+it('inserted', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an existing-file insertion where diff and newFileContents DISAGREE fails CLOSED (agreement check not bypassed)', () => {
    const cwd = repoFixture();
    try {
      // The insertion diff adds a line that the benign newFileContents lacks → git reconstructs an
      // `after` that does not byte-match newFileContents. The agreement check must fail closed.
      const diff = ['@@ -1,1 +1,2 @@', ' it(\'one\', () => {}); it(\'two\', () => {});', "+it('inserted', () => {});"].join('\n');
      const newFileContents = `it('one', () => {}); it('two', () => {});\n`; // no inserted line → disagrees with the diff
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff, newFileContents }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a diff-only file CREATE (target ABSENT on disk) is reconstructed by git from /dev/null and judged', () => {
    const cwd = repoFixture();
    try {
      // The target does not exist (DiskEntry.kind === absent), so this is a genuine create. git apply
      // anchors the hunk to /dev/null and reconstructs the new file; adding a fresh test → allow.
      const diff = ['@@ -0,0 +1,1 @@', "+it('new', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/new.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write that surfaces NO usable content (no diff, no newFileContents) is UNSUPPORTED for this measured config, allow-through', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts'), 'pre-action', cwd);
      expect(r.outcome).toBe('unsupported');
      expect(r.decision).toBeUndefined();
      expect(r.detail).toMatch(/content|sweep/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff that DELETES a protected test (+++ /dev/null) is reconstructed as a real deletion and denied — not an empty-file modify', () => {
    const cwd = repoFixture();
    try {
      // The exact proposed operation is a DELETE. It must be judged as a deletion of the protected
      // file (test-deletion → deny), not normalized into "modify to empty".
      const diff = ['--- a/src/a.spec.ts', '+++ /dev/null', '@@ -1 +0,0 @@', "-it('one', () => {}); it('two', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
      expect(JSON.parse(r.wire as string).feedback).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff whose operation header DISAGREES with disk state fails CLOSED (create header on an existing target)', () => {
    const cwd = repoFixture();
    try {
      // The header claims a create (--- /dev/null) but the target already exists on disk. The
      // operation must not be normalized into a modify; the inconsistent event fails closed.
      const diff = ['--- /dev/null', '+++ b/src/a.spec.ts', '@@ -0,0 +1 @@', "+it('x', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff whose operation header DISAGREES with disk state fails CLOSED (modify header on an absent target)', () => {
    const cwd = repoFixture();
    try {
      // The header claims a modify (path -> path) but the target is absent. Fails closed rather than
      // being reconstructed against a phantom empty before.
      const diff = ['--- a/src/gone.spec.ts', '+++ b/src/gone.spec.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/gone.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a hunk-body line beginning "--- " / "+++ " (deleted/added CONTENT) is NOT mis-read as a file header (no false-deny)', () => {
    const cwd = repoFixture();
    try {
      // A non-protected file whose diff body contains lines starting `--- ` / `+++ ` as real content
      // (a deletion/addition of text that begins with dashes/pluses). Only the pre-hunk header names
      // the file; git owns the body. It must reconstruct and be allowed, not fail closed on a phantom
      // "path mismatch".
      writeFileSync(join(cwd, 'src', 'notes.md'), `-- divider\nkeep\n`);
      const diff = ['--- a/src/notes.md', '+++ b/src/notes.md', '@@ -1,2 +1,2 @@', '--- divider', '+++ divider', ' keep'].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/notes.md', { diff }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a diff past the operator-owned reconstruction budget fails CLOSED before git is spawned', () => {
    const cwd = repoFixture();
    const prev = process.env.TAMPERWARD_RECONSTRUCT_MAX_BYTES;
    try {
      process.env.TAMPERWARD_RECONSTRUCT_MAX_BYTES = '16'; // tiny ceiling → any real diff is over budget
      const diff = ['--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      if (prev === undefined) delete process.env.TAMPERWARD_RECONSTRUCT_MAX_BYTES;
      else process.env.TAMPERWARD_RECONSTRUCT_MAX_BYTES = prev;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff with a one-sided --- / +++ endpoint pair fails CLOSED — a malformed event is not repaired into a valid op', () => {
    const cwd = repoFixture();
    try {
      // Only a `+++` endpoint, no `---`. This must not be normalized into a modify; the malformed
      // event fails closed.
      const diff = ['+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff with CONTRADICTORY duplicate endpoint pairs fails CLOSED — not repaired by last-one-wins', () => {
    const cwd = repoFixture();
    try {
      // First pair says CREATE (--- /dev/null), second says MODIFY. A last-one-wins parser would treat
      // it as a valid modify; the contradictory duplicate endpoints must fail closed instead.
      const diff = [
        '--- /dev/null',
        '+++ b/src/a.spec.ts',
        '--- a/src/a.spec.ts',
        '+++ b/src/a.spec.ts',
        '@@ -1 +1 @@',
        "-it('one', () => {}); it('two', () => {});",
        "+it('one', () => {});",
      ].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write diff carrying Git file metadata but NO --- / +++ endpoints fails CLOSED (not bare-hunk)', () => {
    const cwd = repoFixture();
    try {
      // An `index` line is Git file metadata; it promises a normal endpoint pair. Without one this is
      // malformed and must fail closed, not be inferred as a modify from disk state.
      const diff = ['index 1234567..89abcde 100644', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an in-repo symlink ALIAS to a protected file is judged as that protected file (canonical path, not the alias)', () => {
    const cwd = repoFixture();
    try {
      // `alias.md` (not itself protected) is an in-repo symlink to the protected spec. A weakening
      // write through the alias must be judged against `.spec.ts` protection via the canonical path —
      // not allowed through because the alias spelling dodges the protected glob.
      symlinkSync(join(cwd, 'src', 'a.spec.ts'), join(cwd, 'alias.md'));
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'alias.md', { newFileContents: `it('one', () => {});\n` }), 'pre-action', cwd);
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('metadata that CONTRADICTS the derived op fails CLOSED (new file mode + modify endpoints)', () => {
    const cwd = repoFixture();
    try {
      // `new file mode` claims a create, but the endpoints are a path→path modify of an existing
      // file. Contradictory — must fail closed, not be normalized into a modify with the metadata
      // stripped.
      const diff = ['new file mode 100644', '--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an unknown non-blank pre-hunk header line fails CLOSED (grammar is total, not discard-what-you-do-not-know)', () => {
    const cwd = repoFixture();
    try {
      const diff = ['this is not a header line git understands', '--- a/src/a.spec.ts', '+++ b/src/a.spec.ts', '@@ -1 +1 @@', "-it('one', () => {}); it('two', () => {});", "+it('one', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a write whose EXISTING target cannot be read (a directory) fails CLOSED — not treated as a create', () => {
    const cwd = repoFixture();
    try {
      // A directory stands where the write names a file: DiskEntry.kind is `directory`, not `absent`,
      // so there is no readable `before`. It must fail closed rather than reconstruct against an empty
      // phantom before (which would model a create and could let a weakening through).
      mkdirSync(join(cwd, 'src', 'dir.spec.ts'));
      const diff = ['@@ -0,0 +1,1 @@', "+it('x', () => {});"].join('\n');
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/dir.spec.ts', { diff }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a benign write (newFileContents keeps the tests) is allowed', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/a.spec.ts', { newFileContents: `it('one', () => {}); it('two', () => {}); it('three', () => {});\n` }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotSdkHostedAdapter.decide — the write target is bound to the trusted repository root (#611)', () => {
  const writeDiff = (target: string) => ['--- a/' + target, '+++ b/' + target, '@@ -1 +1 @@', '-a', '+b'].join('\n');

  it('an absolute target OUTSIDE the trusted root fails CLOSED before reconstruction', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const outside = join(B, 'src', 'a.spec.ts');
      const r = copilotSdkAdapter.decide(writeReq(A, outside, { diff: writeDiff(outside) }), 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/outside the trusted repository root/);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('a "../" path escape fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(writeReq(cwd, '../outside.spec.ts', { diff: writeDiff('../outside.spec.ts') }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/outside the trusted repository root/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an in-repo symlink whose real target escapes the root fails CLOSED', () => {
    const cwd = repoFixture();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'hf-outside-')));
    try {
      writeFileSync(join(outside, 'secret.spec.ts'), `it('one', () => {});\n`);
      symlinkSync(join(outside, 'secret.spec.ts'), join(cwd, 'src', 'link.spec.ts'));
      const r = copilotSdkAdapter.decide(writeReq(cwd, 'src/link.spec.ts', { newFileContents: `it('x', () => {});\n` }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/outside the trusted repository root/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a resolvedPath claim that disagrees with the host-derived target fails CLOSED (untrusted claim)', () => {
    const cwd = repoFixture();
    try {
      // fileName targets the protected spec; the runtime-claimed resolvedPath names a different file.
      const r = copilotSdkAdapter.decide(
        writeReq(cwd, 'src/a.spec.ts', { newFileContents: `it('one', () => {});\n`, resolvedPath: join(cwd, 'src', 'other.ts') }),
        'pre-action',
        cwd,
      );
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/resolvedPath/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a resolvedPath claim that AGREES with the host-derived target is judged normally (weakening → deny)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(
        writeReq(cwd, 'src/a.spec.ts', { newFileContents: `it('one', () => {});\n`, resolvedPath: join(cwd, 'src', 'a.spec.ts') }),
        'pre-action',
        cwd,
      );
      expect(r.outcome).toBe('ok');
      expect(r.decision?.verdict).toBe('deny'); // denied for WEAKENING, not for a path mismatch
      expect(r.detail ?? '').not.toMatch(/resolvedPath|outside the trusted/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotSdkHostedAdapter.decide — end-of-turn sweep delegates to the canonical git sweep', () => {
  it('denies a landed protected weakening with the agentStop block wire', () => {
    const cwd = repoFixture();
    try {
      writeFileSync(join(cwd, 'src', 'a.spec.ts'), `it('one', () => {});\n`);
      const r = copilotSdkAdapter.decide(JSON.stringify({ sessionId: 's', cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('deny');
      const j = JSON.parse(r.wire as string);
      expect(j.decision).toBe('block');
      expect(j.reason).toContain('test-deletion');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a clean turn allows (empty wire)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(JSON.stringify({ sessionId: 's', cwd }), 'end-of-turn', cwd);
      expect(r.decision?.verdict).toBe('allow');
      expect(r.wire).toBe('');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('CopilotSdkHostedAdapter.decide — failure states fail CLOSED (deny)', () => {
  it('post-action is unsupported (the SDK has no post-execution veto)', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(shellReq(cwd, 'rm src/a.spec.ts'), 'post-action', cwd);
      expect(r.outcome).toBe('unsupported');
      expect(r.decision).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a parse-failure at pre-action fails closed in the SDK reject wire', () => {
    const r = copilotSdkAdapter.decide('[1,2,3]', 'pre-action');
    expect(r.outcome).toBe('parse-failure');
    expect(r.decision?.verdict).toBe('deny');
    expect(JSON.parse(r.wire as string).kind).toBe('reject');
  });

  it('a cross-repo identity claim fails closed BEFORE evaluation', () => {
    const A = repoFixture();
    const B = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(shellReq(B, 'rm src/a.spec.ts'), 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/different repository/);
      expect(JSON.parse(r.wire as string).feedback).toMatch(/identity claim rejected/i);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it('a malformed (empty) identity claim fails closed', () => {
    const A = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(shellReq('   ', 'rm x'), 'pre-action', A);
      expect(r.decision?.verdict).toBe('deny');
      expect(r.detail).toMatch(/malformed/);
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it('a shell event with no reconstructable command fails CLOSED', () => {
    const cwd = repoFixture();
    try {
      const r = copilotSdkAdapter.decide(req(cwd, { kind: 'shell', toolName: 'shell' }), 'pre-action', cwd);
      expect(r.decision?.verdict).toBe('deny');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
