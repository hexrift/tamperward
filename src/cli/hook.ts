// `tamperward hook claude` (PreToolUse) and `tamperward sweep claude` (Stop).
//
// Output contract (verified against current Claude Code docs):
//   PreToolUse deny → {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//     "permissionDecision":"deny","permissionDecisionReason":<reason>}}  at EXIT 0
//   Stop block     → {"decision":"block","reason":<reason>}              at EXIT 0
// CRITICAL: exit 2 makes Claude Code IGNORE the JSON and fall back to the raw-stderr
// channel (which arrives wrapped as a "hook error" and leaks the invoking command line).
// So a block MUST be exit 0 + JSON, never exit 2. The reason carries only the correction
// message — no command line, no env. Deny holds even under bypassPermissions.

import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { changesFromClaudeHook, ClaudeHookInput, synthFileChange } from '../adapters/claude/changes';
import { formatDenial } from '../adapters/claude/deny';
import { evaluate } from '../engine';
import { loadPolicy } from '../policy-load';
import { diffSince, diffWorktree, fileAt, fileOnDisk, hiddenTrackedPaths, ignoredAdds, isGitRepo, untrackedAdds } from '../git/build';
import { advanceTurnBaseline, turnBaseline } from '../session';
import {
  contentHash,
  driftBetween,
  dropTurnTree,
  loadPtree,
  loadTurnTree,
  PTree,
  ptreePath,
  savePtree,
  saveTurnTree,
  snapshotProtected,
} from '../effect';
import { defaultEventLog } from './watch';
import { readEvents, transientFindings } from '../detectors/fs-events';
import { isProtected } from '../policy';
import { inspectRel, unjudgeableFinding, unjudgeableProtected } from '../disk';
import { Change, FileChange, Finding, Policy } from '../types';

export interface HookResult {
  exitCode: number;
  stdout: string;
}

/** The hook could not be given its input, or the input was not a hook payload.
 *  Thrown, never absorbed: the callers below route it to failClosed(). */
export class HookInputError extends Error {}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch (e) {
    throw new HookInputError(`cannot read the hook payload on stdin: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * FAIL CLOSED on a payload we cannot understand.
 *
 * Both of these used to swallow the failure and return `{}` — the empty input —
 * which flows straight through preToolUseVerdict to `verdict([], ...)`: exit 0,
 * empty stdout, ALLOW. So truncated stdin, a JSON array, a partial write from a
 * runtime under memory pressure, or any payload shape the parser choked on was
 * indistinguishable from "this tool call is fine", for every tool call while the
 * condition lasted. That is the same hole failClosed() was written to close one
 * layer up, left open at the front door.
 *
 * Genuinely empty stdin stays an allow. It is a well-formed ABSENCE of a tool
 * call — there is nothing to deny, and denying it would break `tamperward hook
 * claude < /dev/null`, which is how the wiring is smoke-tested.
 */
function parseInput(raw: string): ClaudeHookInput {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HookInputError(`the hook payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookInputError(`the hook payload is not a JSON object (got ${Array.isArray(parsed) ? 'an array' : typeof parsed})`);
  }
  return parsed as ClaudeHookInput;
}

function recordDenylog(blocks: Finding[]): void {
  const log = process.env.TAMPERWARD_DENYLOG;
  if (!log) return;
  try {
    appendFileSync(log, blocks.map((b) => b.rule).join(',') + '\n');
  } catch {
    /* best effort */
  }
}

/** The error text only — never the stack, never the tool input. A hook error must not
 *  echo back the command line or the environment it was inspecting. */
function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? m.slice(0, 200) + '…' : m;
}

/**
 * FAIL CLOSED. If Tamperward cannot evaluate a change, the change is DENIED.
 *
 * The engine isolates each detector, but everything around it — loading the policy
 * (a malformed or merge-conflicted .tamperward.yml throws on parse), the adapter's own
 * file work — ran unguarded. An exception there exited non-(0|2), which Claude Code
 * treats as a NON-BLOCKING hook error: the tool call proceeds. A crashed gate became an
 * absent gate, silently, for every tool call while the condition lasted. SPEC §5.1's
 * whole guarantee is that a deny holds even under bypassPermissions; it cannot rest on
 * nothing having thrown.
 */
function failClosed(kind: 'PreToolUse' | 'Stop', detail: string): HookResult {
  const f: Finding = {
    rule: 'tamperward-unavailable',
    severity: 'block',
    message: `Tamperward could not evaluate this change (${detail}), so it is denied rather than allowed.`,
    evidence: detail,
    remediation:
      'Repair the Tamperward setup — most often an unparseable .tamperward.yml (check for merge-conflict markers) — then retry. Do not work around the gate while it is down.',
    signoff: { required: true, command: 'tamperward allow --reason "..."' },
  };
  return verdict([f], kind);
}

/** Deny via JSON on stdout at exit 0. Empty stdout + exit 0 = allow. */
function verdict(blocks: Finding[], kind: 'PreToolUse' | 'Stop'): HookResult {
  if (blocks.length === 0) return { exitCode: 0, stdout: '' };
  recordDenylog(blocks);
  const reason = formatDenial(blocks);
  const payload =
    kind === 'PreToolUse'
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }
      : { decision: 'block', reason };
  return { exitCode: 0, stdout: JSON.stringify(payload) + '\n' };
}

/** PreToolUse: deny the shortcut before the tool runs. Pure — testable without stdin.
 *  AGENT-LAYER TRUST RULE: never consults the sign-off ledger. The agent can write the ledger
 *  (observed self-invoking `tamperward allow` 3×), so honoring it here would let the agent clear
 *  its own block in-loop. A block is a block; sign-off is a human decision made at the
 *  local/CI layers (src/signoff.ts), never here. */

function fileChanges(changes: Change[]): FileChange[] {
  return changes.filter((c): c is FileChange => c.kind === 'file');
}

/** The hash the snapshot would record for the path's content, or null when the
 *  gate does not read what stands there (src/disk.ts) — which never compares
 *  equal to a sanctioned entry, so the path is judged. */
function hashOnDisk(cwd: string, rel: string): string | null {
  const e = inspectRel(cwd, rel);
  return e.content == null ? null : contentHash(e.content);
}

/** git's file mode for a stat mode: executable or not (the two modes a tracked file can have). */
function gitMode(mode: number): string {
  return (mode & 0o100) !== 0 ? '100755' : '100644';
}

/**
 * The turn's net change to the working tree, as the detectors should see it. Four
 * sources, because a tracked diff alone is not the tree the runner will execute:
 *
 *  1. `git diff <turn base>` — committed or not, every tracked edit.
 *  2. UNTRACKED protected files. A new protected file the turn created (a shadowing
 *     vitest.config.ts, a conftest.py carrying `collect_ignore`, a workflow) is not
 *     in any tracked diff; only the `run` envelope scanned untracked files, so the
 *     Stop sweep never saw them. Scoped to protected paths — those are the only ones
 *     the safety-net rules read, and ordinary untracked scratch stays out of the
 *     sweep — and to files that are new or changed since the TURN began (the turn
 *     tree, src/effect.ts): a developer's own pre-existing untracked spec is not
 *     re-litigated every turn. No turn tree → every untracked protected file is
 *     judged (fail closed on unknown provenance).
 *  3. IGNORED protected files. `ls-files --others --exclude-standard` drops them by
 *     design, so a conftest.py the turn created AND excluded — one line in the
 *     agent-writable `.git/info/exclude`, or in `.gitignore` — reached no view;
 *     the effect layer saw it in its snapshot and absorbed it as an addition. Same
 *     scoping as (2), plus one rule: an ignored file the ptree sanctioned at OTHER
 *     bytes is drift, not an add — it has no git blob to diff against, and the
 *     effect layer's reconstruct-or-block (uncoveredDrift) is the honest verdict
 *     for it, where an add of the full content would let a gutting pass.
 *  4. Tracked protected files git has been told to stop comparing (skip-worktree,
 *     assume-unchanged). They appear in no diff, no status and no untracked list;
 *     diffed here by hand, trusted blob at the turn base vs the disk.
 *
 * THE TURN TREE EXCUSES ONLY WHAT THE PTREE ALSO KNOWS. Both trees are `.git`
 * state the agent can write, and a turn tree forged to list a file the turn
 * created, at its current hash, used to make (2) drop it as pre-existing — after
 * which the effect layer absorbed it. The two trees are written together from the
 * same snapshot, so an untracked file that genuinely predates the turn is in both
 * at the same hash; an entry the turn tree carries that the ptree never sanctioned
 * is not something this gate wrote, and the file is judged. Residual, documented:
 * an agent that rewrites BOTH trees consistently (or removes the ptree so the next
 * call re-snapshots it — met by effectDriftBlocks, which forgets the turn tree
 * with it) is inside the loop layer's known trust boundary; CI, which reads none
 * of this state, remains the authority.
 */
function turnView(cwd: string, sessionId: string | undefined, policy: Policy, base: string | null): Change[] {
  const tracked = base ? diffSince(base, { cwd }) : diffWorktree({ cwd });
  const seen = new Set<string>();
  for (const c of fileChanges(tracked)) {
    seen.add(c.path);
    if (c.oldPath) seen.add(c.oldPath);
  }
  const turnTree = loadTurnTree(cwd, sessionId);
  const ptree = loadPtree(cwd, sessionId);
  const keep = (rel: string): boolean => isProtected(rel, policy);
  const untouched = (rel: string, disk: string | null): boolean =>
    disk != null && turnTree?.[rel]?.hash === disk && ptree?.[rel]?.hash === disk;
  const untracked = untrackedAdds({ cwd }, keep, seen).filter((c) => c.kind !== 'file' || !untouched(c.path, hashOnDisk(cwd, c.path)));
  for (const c of fileChanges(untracked)) seen.add(c.path);
  const ignored = ignoredAdds({ cwd }, keep, seen).filter((c) => {
    if (c.kind !== 'file') return false;
    const disk = hashOnDisk(cwd, c.path);
    if (untouched(c.path, disk)) return false;
    const sanctioned = ptree?.[c.path];
    return !(sanctioned && disk != null && sanctioned.hash !== disk); // drift on a sanctioned file: uncoveredDrift's
  });
  for (const c of fileChanges(ignored)) seen.add(c.path);
  const trusted = base ?? 'HEAD';
  const hidden: Change[] = [];
  for (const rel of hiddenTrackedPaths({ cwd })) {
    if (seen.has(rel) || !isProtected(rel, policy)) continue;
    hidden.push(...synthFileChange(rel, fileAt(trusted, rel, { cwd }), fileOnDisk(rel, { cwd })));
  }
  return [...tracked, ...untracked, ...ignored, ...hidden];
}

/**
 * FAIL CLOSED on drift git cannot show. The ptree says a protected file changed
 * since its last sanctioned state, but nothing in the turn view carries that path —
 * the file has left git's sight by a route the view does not enumerate. This used
 * to evaluate an EMPTY change list, find nothing, and `savePtree(current)` absorbed
 * the tamper as the new baseline: the effect layer, built to catch what the
 * spelling matcher missed, ratified what git missed.
 *
 * Reconstruct the change instead. `before` is the sanctioned content, recovered
 * from any git blob whose hash equals the ptree's (the turn base, HEAD, the index);
 * `after` is the disk. When the disk already equals the trusted base blob, the file
 * was RESTORED to its git state (a `git restore`, or an Edit the hook allowed but
 * the tool never applied) — benign, absorbed as before. When the sanctioned content
 * cannot be found anywhere, there is nothing honest to diff against, and the only
 * safe verdict is a block that names the file.
 */
function uncoveredDrift(
  cwd: string,
  policy: Policy,
  expected: PTree,
  current: PTree,
  covered: Change[],
  base: string | null,
  turnTree: PTree | null,
): { changes: Change[]; blocks: Finding[] } {
  const d = driftBetween(expected, current);
  const seen = new Set<string>();
  for (const c of fileChanges(covered)) {
    seen.add(c.path);
    if (c.oldPath) seen.add(c.oldPath);
  }
  const changes: Change[] = [];
  const blocks: Finding[] = [];
  const trusted = base ?? 'HEAD';
  const candidates = base ? [base, 'HEAD', ''] : ['HEAD', ''];
  for (const rel of [...d.changed, ...d.deleted]) {
    if (seen.has(rel)) continue;
    // What stands there now is not something the gate reads (a link, a FIFO, a
    // device, a file past the cap): blocked by name, before any exemption.
    const unjudgeable = unjudgeableFinding(cwd, rel);
    if (unjudgeable) {
      blocks.push(unjudgeable);
      continue;
    }
    const after = fileOnDisk(rel, { cwd });
    const trustedBlob = fileAt(trusted, rel, { cwd });
    const atGitState = after != null && trustedBlob != null && contentHash(after) === contentHash(trustedBlob);
    // The turn tree may excuse a file that stands exactly as the turn found it ONLY
    // for an edit this gate predicted and never saw land (the ptree entry still
    // carries sanctionPredictedWrites' marker, mtimeMs -1): the tool call was allowed,
    // the user rejected it, the disk never moved. Read without that condition, the
    // exemption was a second door for a forged turn tree — rewrite an untracked
    // file from the shell, list it in the turn tree at the new hash, and the drift
    // was "as the turn found it". A sanctioned entry that a real snapshot confirmed
    // has no such excuse: a file at bytes the ptree never sanctioned is drift.
    const atTurnStart = current[rel] != null && expected[rel]?.mtimeMs === -1 && turnTree?.[rel]?.hash === current[rel].hash;
    if ((atGitState || atTurnStart) && current[rel] && expected[rel] && current[rel].mode === expected[rel].mode) {
      // Back at its git state, or exactly as the turn found it: a restore, or an
      // Edit the hook sanctioned that the tool never applied. Nothing to judge.
      continue;
    }
    const want = expected[rel]?.hash;
    let before: string | null = null;
    for (const rev of candidates) {
      const blob = fileAt(rev, rel, { cwd });
      if (blob != null && contentHash(blob) === want) {
        before = blob;
        break;
      }
    }
    if (before == null) {
      blocks.push({
        rule: 'hidden-drift',
        severity: 'block',
        file: rel,
        message: `Protected file ${rel} changed outside git's view, and its sanctioned content cannot be reconstructed to judge the change.`,
        evidence: rel,
        remediation:
          'Restore the file to its last sanctioned content (git restore, or undo the edit) and bring it back into git\'s view (git update-index --no-skip-worktree / --no-assume-unchanged); make the change through a tool call the gate can see.',
        signoff: { required: true, command: `tamperward allow hidden-drift --file ${rel} --reason "..."` },
      });
      continue;
    }
    const synth = synthFileChange(rel, before, after);
    if (synth.length > 0) {
      changes.push(...synth);
    } else if (after != null && current[rel] && expected[rel] && current[rel].mode !== expected[rel].mode) {
      // Same bytes, different mode: a chmod git cannot see. hook-tampering reads the modes.
      changes.push({
        kind: 'file',
        path: rel,
        oldPath: null,
        op: 'modify',
        before,
        after,
        binary: false,
        hunks: [],
        oldMode: gitMode(expected[rel].mode),
        newMode: gitMode(current[rel].mode),
      });
    }
  }
  // ADDITIONS the view could not find. A protected file that exists now and that no
  // sanctioned state knows was created by a route none of the git views lists — a
  // directory git treats as a nested repository, a listing that came back short —
  // and used to be absorbed by `savePtree(current)` without a rule having read it.
  // Reconstructed as the add it is: before = nothing, after = the disk. The turn
  // tree cannot excuse it (see turnView): an entry there for a path the ptree has
  // never sanctioned is not something this gate wrote. A file that cannot be read
  // cannot be judged, and is blocked by name like unreconstructable drift.
  for (const rel of d.added) {
    if (seen.has(rel)) continue;
    const unjudgeable = unjudgeableFinding(cwd, rel);
    if (unjudgeable) {
      blocks.push(unjudgeable);
      continue;
    }
    const after = fileOnDisk(rel, { cwd });
    if (after == null) {
      blocks.push({
        rule: 'hidden-drift',
        severity: 'block',
        file: rel,
        message: `Protected file ${rel} appeared outside git's view and cannot be read to judge it.`,
        evidence: rel,
        remediation: 'Remove the file, or make it readable and bring it into git\'s view; create protected files through a tool call the gate can see.',
        signoff: { required: true, command: `tamperward allow hidden-drift --file ${rel} --reason "..."` },
      });
      continue;
    }
    changes.push(...synthFileChange(rel, null, after));
  }
  return { changes, blocks };
}

/**
 * Per-call EFFECT check (taskbench Phase 3, run 07-fastify gated): whatever a
 * spelling matcher or a hook flake misses, the protected tree remembers. If it
 * drifted since the last sanctioned state, run the ordinary detector stack over
 * the drift (the turn view, scoped to the drifted paths) NOW — findings then
 * carry the existing rules' corpus-priced severities. Benign drift (a git
 * restore, an honest new spec) evaluates clean and is absorbed. Drift the view
 * cannot show — a hidden edit, an ADDITION git will not list — is reconstructed
 * or blocked (uncoveredDrift), never absorbed.
 * Returns blocking findings, or null when the current call may proceed.
 */
function effectDriftBlocks(cwd: string, sessionId: string | undefined, policy: Policy): Finding[] | null {
  if (!sessionId || !isGitRepo(cwd)) return null;
  const expected = loadPtree(cwd, sessionId);
  const current = snapshotProtected(cwd, policy, expected ?? undefined);
  if (!expected) {
    savePtree(cwd, sessionId, current);
    // First sight of the session: the turn begins here, alongside the git baseline.
    // The two trees are written together, so a turn tree ALREADY here with no ptree
    // beside it is not a first sight: the ptree was removed (or never survived its
    // write). A snapshot taken now would sanction whatever is on disk, and the
    // surviving turn tree — agent-writable — would then excuse it at Stop as
    // pre-existing. The turn tree is forgotten with the ptree instead: no turn
    // tree → every untracked protected file is judged at the next sweep, the
    // stance this gate takes on unknown provenance.
    if (loadTurnTree(cwd, sessionId)) dropTurnTree(cwd, sessionId);
    else saveTurnTree(cwd, sessionId, current);
    return null;
  }
  const d = driftBetween(expected, current);
  if (d.changed.length === 0 && d.deleted.length === 0 && d.added.length === 0) {
    savePtree(cwd, sessionId, current); // refresh mtimes
    return null;
  }
  const base = turnBaseline(cwd, sessionId);
  const all = turnView(cwd, sessionId, policy, base);
  const drifted = new Set([...d.changed, ...d.deleted, ...d.added]);
  const scoped = all.filter(
    (c) => c.kind === 'file' && (drifted.has(c.path) || (c.oldPath != null && drifted.has(c.oldPath))),
  );
  const gap = uncoveredDrift(cwd, policy, expected, current, scoped, base, loadTurnTree(cwd, sessionId));
  const judged = [...scoped, ...gap.changes];
  // A protected path the view lists that the gate cannot judge by content — a
  // symbolic link (git's blob for it is the target text; the runner follows it),
  // a FIFO, a device, a file past the cap — is blocked by name, whatever the
  // rules made of the content the view carried for it.
  const blocks = evaluate(judged, policy, undefined, 'turn', { cwd })
    .filter((f) => f.severity === 'block')
    .concat(gap.blocks, unjudgeableProtected(cwd, policy, judged));
  if (blocks.length > 0) return blocks; // do NOT absorb: the deny repeats until restored
  savePtree(cwd, sessionId, current);
  return null;
}

/** After ALLOWING an Edit/Write on a protected file, record the content the tool is
 *  about to write as the new sanctioned state, so the next call's drift check does
 *  not re-litigate an edit this hook already passed. */
function sanctionPredictedWrites(cwd: string, sessionId: string | undefined, policy: Policy, changes: ReturnType<typeof changesFromClaudeHook>): void {
  if (!sessionId) return;
  const tree = loadPtree(cwd, sessionId);
  if (!tree) return;
  let dirty = false;
  for (const c of changes) {
    if (c.kind !== 'file' || c.after == null || !isProtected(c.path, policy)) continue;
    const hash = createHash('sha256').update(c.after).digest('hex').slice(0, 16);
    const prev = tree[c.path];
    tree[c.path] = {
      hash,
      mode: prev?.mode ?? 0o100644,
      size: Buffer.byteLength(c.after),
      mtimeMs: -1, // unknown until written; forces a re-hash next snapshot, which is correct
    };
    dirty = true;
  }
  if (dirty) savePtree(cwd, sessionId, tree);
}

export function preToolUseVerdict(input: ClaudeHookInput): HookResult {
  try {
    const cwd = input.cwd ?? process.cwd();
    // First tool call of the session pins the commit the Stop sweep will compare against.
    turnBaseline(cwd, input.session_id);
    const policy = loadPolicy(cwd);
    const driftBlocks = effectDriftBlocks(cwd, input.session_id, policy);
    if (driftBlocks) return verdict(driftBlocks, 'PreToolUse');
    const changes = changesFromClaudeHook(input, cwd);
    const blocks = evaluate(changes, policy, undefined, 'tool-call', { cwd }).filter((f) => f.severity === 'block');
    if (blocks.length === 0) sanctionPredictedWrites(cwd, input.session_id, policy, changes);
    return verdict(blocks, 'PreToolUse');
  } catch (e) {
    return failClosed('PreToolUse', errText(e));
  }
}

/** Stop: re-scan the turn's net working tree for shell-mediated mutations the PreToolUse
 *  matcher can't see. Respects stop_hook_active to avoid an infinite loop. */
function cursorPath(cwd: string, sessionId?: string): string | null {
  const p = ptreePath(cwd, sessionId);
  return p ? p.replace(/ptree-/, 'fscursor-') : null;
}

/** Watcher events for the turn: judged only when the daemon is running (log exists).
 *  The cursor advances with the turn, mirroring the baseline's semantics. */
function turnTransientBlocks(cwd: string, sessionId: string | undefined, policy: Policy, changes: Change[]): { blocks: Finding[]; commit: () => void } {
  const none = { blocks: [] as Finding[], commit: () => {} };
  const log = defaultEventLog(cwd);
  const cp = cursorPath(cwd, sessionId);
  if (!existsSync(log)) return none;
  let offset = 0;
  if (cp && existsSync(cp)) {
    const n = Number(readFileSync(cp, 'utf8'));
    offset = Number.isFinite(n) ? n : 0;
  }
  const { events, newOffset } = readEvents(log, offset);
  if (events.length === 0) return { ...none, commit: () => { if (cp) try { writeFileSync(cp, String(newOffset)); } catch { /* best effort */ } } };
  const persistent = new Set(changes.filter((c) => c.kind === 'file').map((c) => c.path));
  const finalHash = (path: string): string | null => {
    const e = inspectRel(cwd, path);
    return e.kind === 'file' && e.content != null ? contentHash(e.content) : null;
  };
  const findings = transientFindings(events, persistent, policy, finalHash);
  recordWarns(findings.filter((f) => f.severity !== 'block'));
  return {
    blocks: findings.filter((f) => f.severity === 'block'),
    commit: () => { if (cp) try { writeFileSync(cp, String(newOffset)); } catch { /* best effort */ } },
  };
}

/** Warn-severity transients would otherwise be invisible in the hook flow (the
 *  schema-utils lesson: an unseen warn is a no-op in an unattended loop). They at
 *  least land in the deny log's audit trail, marked as warnings. */
function recordWarns(warns: Finding[]): void {
  const log = process.env.TAMPERWARD_DENYLOG;
  if (!log || warns.length === 0) return;
  try {
    appendFileSync(log, warns.map((w) => `warn:${w.rule}:${w.file ?? ''}`).join('\n') + '\n');
  } catch {
    /* best effort */
  }
}

export function stopVerdict(input: ClaudeHookInput): HookResult {
  if (input.stop_hook_active) return { exitCode: 0, stdout: '' };
  const cwd = input.cwd ?? process.cwd();
  // "Nothing to compare" and "the comparison failed" must not share a code path: a blanket
  // catch→allow turned a broken policy or a git failure into a silent pass.
  if (!isGitRepo(cwd)) return { exitCode: 0, stdout: '' };
  let blocks: Finding[];
  let commitCursor: () => void = () => {};
  try {
    // Compare against the turn's starting commit, not HEAD: a tamper the agent COMMITTED
    // mid-turn is still the turn's work, and `git diff HEAD` could not see it.
    const policy = loadPolicy(cwd);
    const base = turnBaseline(cwd, input.session_id);
    let changes = turnView(cwd, input.session_id, policy, base);
    // The effect state sees what git does not: drift on a protected path that no
    // part of the view carries is reconstructed or blocked, never passed.
    const expected = loadPtree(cwd, input.session_id);
    const current = input.session_id ? snapshotProtected(cwd, policy, expected ?? undefined) : null;
    let hiddenBlocks: Finding[] = [];
    if (expected && current) {
      const gap = uncoveredDrift(cwd, policy, expected, current, changes, base, loadTurnTree(cwd, input.session_id));
      changes = changes.concat(gap.changes);
      hiddenBlocks = gap.blocks;
    }
    blocks = evaluate(changes, policy, undefined, 'turn', { cwd })
      .filter((f) => f.severity === 'block')
      .concat(hiddenBlocks, unjudgeableProtected(cwd, policy, changes));
    const transient = turnTransientBlocks(cwd, input.session_id, policy, changes);
    blocks = blocks.concat(transient.blocks);
    commitCursor = transient.commit;
    if (blocks.length === 0 && input.session_id && current) {
      // A clean turn re-baselines the effect state too, so the next turn's drift
      // check starts from what this turn legitimately left behind — and the turn
      // tree advances with the git baseline, so the next sweep judges only the
      // untracked files the next turn creates or changes.
      savePtree(cwd, input.session_id, current);
      saveTurnTree(cwd, input.session_id, current);
    }
  } catch (e) {
    return failClosed('Stop', errText(e));
  }
  if (blocks.length === 0) {
    advanceTurnBaseline(cwd, input.session_id);
    commitCursor();
  }
  return verdict(blocks, 'Stop');
}

function emit(r: HookResult): number {
  if (r.stdout) process.stdout.write(r.stdout);
  return r.exitCode;
}

/** The whole PreToolUse path from RAW BYTES, so the payload-parsing failures are
 *  reachable from a test without a real stdin. */
export function preToolUseFromRaw(raw: string): HookResult {
  try {
    return preToolUseVerdict(parseInput(raw));
  } catch (e) {
    return failClosed('PreToolUse', errText(e));
  }
}

export function stopFromRaw(raw: string): HookResult {
  try {
    return stopVerdict(parseInput(raw));
  } catch (e) {
    return failClosed('Stop', errText(e));
  }
}

export function runHookClaude(): number {
  try {
    return emit(preToolUseFromRaw(readStdin()));
  } catch (e) {
    return emit(failClosed('PreToolUse', errText(e)));
  }
}

export function runSweepClaude(): number {
  try {
    return emit(stopFromRaw(readStdin()));
  } catch (e) {
    return emit(failClosed('Stop', errText(e)));
  }
}
