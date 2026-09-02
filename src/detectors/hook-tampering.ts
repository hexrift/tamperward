// #8 hook-tampering (file + command surface, mechanical).
// The "guard the guardrail" rule: the hooks and the policy file are protected assets.
// Deleting/renaming them, lowering a severity, disabling a rule, or chmod/rm-ing a
// hook from the shell are all the tamper.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Change, Detector, DetectorContext, FileChange, Finding, Policy } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected, POLICY_FILE } from '../policy';
import { makeFinding } from './finding';
import { policyAddWeakening, policyWeakening } from './policy-diff';
import { segments, tokens, unquote } from './command';
import {
  chmodDropsExec, codeownersWeakening, hookIdentity, insertsDeadGuard, insertsPassingExit, isCodeowners,
  isLefthook, isPackageJson, isPreCommitConfig, lefthookWeakening, packageJsonWeakening, parseDoc,
  preCommitWeakening, scriptWeakening, shellWritesHook,
} from './hook-wiring';

const RULE = 'hook-tampering';

/** Owner execute bit of a git mode ("100755"). */
const ownerExec = (mode: string): boolean => (parseInt(mode.slice(-3), 8) & 0o100) !== 0;

// ── Claude Code settings: the wiring, read as the runtime reads it ─────────────
//
// `.claude/settings.json` carries the PreToolUse and Stop hooks `init` installs; it
// is the enforcement. The line-based comparison below (written for shell hooks)
// read it as text, and text is the wrong grain for JSON:
//   - narrowing the matcher from "Bash|Edit|Write|MultiEdit|NotebookEdit" to "Bash"
//     removes no invocation and adds no `exit 0`, so nothing fired — and every
//     file-edit tool was ungated afterwards;
//   - a removed invocation was excused when its token reappeared in ANY added line,
//     so `"command": "true"` plus a decoy `"_note": "npx tamperward hook claude"`
//     passed clean;
//   - a settings file ADDED with `{"hooks":{"PreToolUse":[],"Stop":[]}}` had no
//     before-text to compare and fired nothing, although it shadows the gate.
// The runtime does not read lines; it parses the file and runs the `command` of
// each hook entry whose matcher selects the tool. So the comparison parses too,
// and judges survival on the parsed hook commands alone.

const CLAUDE_SETTINGS = /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/;
const isClaudeSettings = (p: string): boolean => CLAUDE_SETTINGS.test(p);

/** The other settings file of the pair: overrides between them are what an
 *  added file can shadow. */
function siblingSettings(p: string): string {
  return p.endsWith('settings.local.json')
    ? p.replace(/settings\.local\.json$/, 'settings.json')
    : p.replace(/settings\.json$/, 'settings.local.json');
}

/** A command that runs this gate — `hook claude` (PreToolUse) or `sweep claude`
 *  (Stop) — in any pin, from any launcher. Same shape `init` recognises. */
const TW_INVOCATION = /\btamperward(?:@\S+)?\s+(?:hook|sweep)\s+claude\b/;

const EVENTS = ['PreToolUse', 'Stop'] as const;
type HookEvent = (typeof EVENTS)[number];

/** One hook entry that runs the gate, with the tools its matcher selects. */
interface Wiring {
  /** Tools the matcher selects; null when it selects every tool. */
  tools: Set<string> | null;
  command: string;
}

type Settings = Record<string, unknown>;

function parseSettings(src: string): Settings | null {
  try {
    const v: unknown = JSON.parse(src);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Settings) : null;
  } catch {
    return null;
  }
}

/** The tools a matcher selects, or null for every tool — Claude Code treats an
 *  absent matcher, an empty one and `*` alike. Mirrors `init`'s reading. */
function toolSet(matcher: unknown): Set<string> | null {
  const m = typeof matcher === 'string' ? matcher.trim() : '';
  if (m === '' || m === '*') return null;
  return new Set(m.split('|').map((t) => t.trim()).filter(Boolean));
}

function eventEntries(s: Settings, event: HookEvent): unknown[] | null {
  const hooks = s.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const arr = (hooks as Record<string, unknown>)[event];
  return Array.isArray(arr) ? arr : null;
}

/** Whether the file declares this event at all (an array, empty or not). An
 *  override file that declares an event without the gate's entry shadows it. */
const declares = (s: Settings, event: HookEvent): boolean => eventEntries(s, event) !== null;

/** Every hook entry under `event` whose COMMAND invokes this gate. Only the
 *  `command` field of a command-type hook is a command; a note, a description,
 *  a prompt-type hook, or any other string carrying the same words runs nothing. */
function gateWiring(s: Settings, event: HookEvent): Wiring[] {
  const out: Wiring[] = [];
  for (const m of eventEntries(s, event) ?? []) {
    if (m === null || typeof m !== 'object') continue;
    const matcher = m as { matcher?: unknown; hooks?: unknown };
    if (!Array.isArray(matcher.hooks)) continue;
    for (const h of matcher.hooks) {
      if (h === null || typeof h !== 'object') continue;
      const entry = h as { type?: unknown; command?: unknown };
      if (entry.type !== undefined && entry.type !== 'command') continue;
      if (typeof entry.command !== 'string' || !TW_INVOCATION.test(entry.command)) continue;
      out.push({ tools: toolSet(matcher.matcher), command: entry.command });
    }
  }
  return out;
}

/** The union of tools the gate's entries cover for an event: null = every tool,
 *  'none' = the gate is not wired for this event. */
function coverage(ws: Wiring[]): Set<string> | null | 'none' {
  if (ws.length === 0) return 'none';
  if (ws.some((w) => w.tools === null)) return null;
  return new Set(ws.flatMap((w) => [...(w.tools as Set<string>)]));
}

/** `disableAllHooks: true` switches every hook off in one key — cheaper than
 *  editing any of them. */
const hooksDisabled = (s: Settings): boolean => s.disableAllHooks === true;

/** Reasons the after-settings run less of the gate than the before-settings did.
 *  Pure over the two parsed documents; the shadow case needs the sibling. */
function settingsWeakening(before: Settings | null, after: Settings, sibling: Settings | null): string[] {
  const reasons: string[] = [];
  if (hooksDisabled(after) && !(before !== null && hooksDisabled(before))) {
    reasons.push('`disableAllHooks: true` switches every hook off, the gate included');
  }
  for (const event of EVENTS) {
    const was = before ? coverage(gateWiring(before, event)) : 'none';
    const now = coverage(gateWiring(after, event));
    if (was !== 'none') {
      if (now === 'none') {
        reasons.push(`the tamperward ${event} hook entry was removed`);
      } else if (event === 'PreToolUse') {
        // Stop hooks take no matcher; for PreToolUse the matcher IS the coverage.
        if (was === null && now !== null) {
          reasons.push(`the PreToolUse matcher for the gate was narrowed from every tool to ${[...now].join('|')}`);
        } else if (was !== null && now !== null) {
          const lost = [...was].filter((t) => !now.has(t));
          if (lost.length) reasons.push(`the PreToolUse matcher for the gate no longer covers ${lost.join(', ')}`);
        }
      }
      continue;
    }
    // The gate was not wired for this event in THIS file before (or the file is
    // new). Declaring the event now, without the gate, in a file whose sibling
    // carries it is the override that shadows the wiring. An EMPTY declaration
    // has no other purpose and is reported even when the sibling is unknown;
    // a non-empty one is somebody's own hook unless the sibling says otherwise.
    if (now !== 'none' || !declares(after, event)) continue;
    if (before !== null && declares(before, event)) continue; // was already declared without the gate: not this edit's doing
    const empty = (eventEntries(after, event) ?? []).length === 0;
    const shadowed = sibling !== null && gateWiring(sibling, event).length > 0;
    if (empty || shadowed) {
      reasons.push(
        `${event} hooks declared ${empty ? 'empty' : 'without the tamperward entry'} in an override file` +
          (shadowed ? ' — this shadows the gate the sibling settings file wires' : ''),
      );
    }
  }
  return reasons;
}

/** The sibling settings file as it will stand after this changeset: its own change
 *  in the same Change[] wins, then the checkout on disk (when the caller said
 *  where that is). null when it cannot be known. */
function siblingOf(c: FileChange, changes: Change[], ctx?: DetectorContext): Settings | null {
  const path = siblingSettings(c.path);
  const inSet = changes.find((o): o is FileChange => o.kind === 'file' && o.path === path);
  if (inSet) return inSet.after != null ? parseSettings(inSet.after) : null;
  if (!ctx?.cwd) return null;
  try {
    const p = join(ctx.cwd, path);
    return existsSync(p) ? parseSettings(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * Findings for a change to a Claude settings file, or null when the semantic
 * comparison has nothing to stand on (no full content on either side, or a
 * before that already did not parse) — the caller then falls back to the line
 * comparison. A file that parsed before and does not parse after is reported
 * here: the runtime ignores an unparseable settings file, hooks and all.
 */
function claudeSettingsFindings(c: FileChange, changes: Change[], policy: Policy, ctx?: DetectorContext): Finding[] | null {
  if (c.after == null) return null;
  const after = parseSettings(c.after);
  const before = c.before != null ? parseSettings(c.before) : null;
  const finding = (reason: string): Finding =>
    makeFinding(RULE, policy, {
      file: c.path,
      message: `The Claude Code hook wiring was weakened: ${reason}.`,
      evidence: reason,
      remediation:
        'Leave the PreToolUse and Stop entries that run tamperward, and the matcher that covers every editing tool, exactly as `tamperward init` wrote them. Editing the wiring is editing the gate.',
    });
  if (c.before != null && before === null) return null; // was already unreadable: nothing to compare
  if (after === null) {
    if (c.before == null) return []; // an unreadable new file wires nothing and shadows nothing
    return [finding('the settings file no longer parses as JSON — the runtime ignores it, hooks and all')];
  }
  return settingsWeakening(before, after, siblingOf(c, changes, ctx)).map(finding);
}

/**
 * Findings for an edit to — or an ADD of — the policy file, or null when there is
 * nothing to compare (no after-content, or a before that does not parse). An added
 * policy is compared to the baseline it displaces: a repo on the baseline that gains
 * `.tamperward.yml` with `ignore: ['**']` has been switched off exactly as an edited
 * one would be, and used to be compared to nothing because there was no before-text.
 */
function policyFindings(c: FileChange, policy: Policy): Finding[] | null {
  if (c.after == null) return null;
  const added = c.before == null;
  const reasons = added ? policyAddWeakening(c.after) : policyWeakening(c.before as string, c.after);
  if (reasons === null) return null;
  return reasons.map((reason) =>
    makeFinding(RULE, policy, {
      file: c.path,
      message: added ? `A policy file was added that weakens the baseline: ${reason}.` : `The policy was weakened: ${reason}.`,
      evidence: reason,
      remediation:
        'A change that weakens the guardrail is a high-risk edit requiring human sign-off, not an automated pass.',
    }),
  );
}

/**
 * A rename the consumer cannot tell from the original: same identity to the tool
 * that reads it (`lefthook.yml` → `lefthook.yaml`, `.github/CODEOWNERS` →
 * `CODEOWNERS`) and unchanged content. `.husky/pre-commit` → `.husky/pre-commit.bak`
 * stays inside the glob but git will never run it, so it is not kept.
 */
function renameKept(c: FileChange): boolean {
  if (!c.oldPath) return false;
  const id = hookIdentity(c.oldPath);
  if (id === null || hookIdentity(c.path) !== id) return false;
  return c.before != null && c.after != null ? c.before === c.after : c.hunks.length === 0;
}

/**
 * lefthook and pre-commit configs, compared as the tool reads them: the entry
 * that runs the gate removed, `skip: true`, a `glob`/`exclude`/`only` narrowing
 * when it runs, `stages: [manual]`. null when either side is not a YAML mapping —
 * the caller falls back to the script comparison.
 */
function configFindings(c: FileChange, policy: Policy): Finding[] | null {
  if (c.before == null || c.after == null) return null;
  const before = parseDoc(c.before);
  const after = parseDoc(c.after);
  if (before === null) return null;
  const reasons =
    after === null
      ? ['the file no longer parses as YAML — the tool that reads it runs nothing']
      : isLefthook(c.path)
        ? lefthookWeakening(before, after)
        : preCommitWeakening(before, after);
  return reasons.map((reason) =>
    makeFinding(RULE, policy, {
      file: c.path,
      message: `The hook configuration was weakened: ${reason}.`,
      evidence: reason,
      remediation: 'Leave the entry that runs the gate as `tamperward init` wrote it. Skipping, staging-off or scoping it is disabling it.',
    }),
  );
}

/**
 * `git update-index` can hide a file from git without touching it: `--skip-worktree`
 * and `--assume-unchanged` make every later `git diff` omit the path, so a shell
 * write to a protected test afterwards is invisible to the Stop sweep, the effect
 * drift check and pre-commit alike. `--chmod=-x` clears a hook's execute bit through
 * the index, the same disabling `chmod -x` is. The flag is judged only when a token
 * names a protected path; `--no-skip-worktree` / `--no-assume-unchanged` restore
 * visibility and pass. Prefixes (`git -C dir`, `git -c k=v`) are transparent because
 * the test is over the segment's tokens, not its shape.
 */
function updateIndexHiding(toks: string[], policy: Policy): string | null {
  if (!toks.some((t) => t === 'git' || t.endsWith('/git')) || !toks.includes('update-index')) return null;
  const hide = toks.find((t) => /^--(?:skip-worktree|assume-unchanged)$/.test(t));
  if (hide && toks.some((t) => isProtected(t, policy))) {
    return `git update-index ${hide} hides a protected file from every git diff — edits to it no longer reach the sweep or the pre-commit gate`;
  }
  if (toks.some((t) => /^--chmod=-x$/.test(t)) && toks.some((t) => isProtected(t, policy, 'hooks'))) {
    return 'git update-index --chmod=-x clears the execute bit on a protected hook through the index, which disables it';
  }
  return null;
}

export const hookTampering: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy, _view, ctx): Finding[] {
    const out: Finding[] = [];

    for (const c of changes) {
      let semantic: Finding[] | null;
      if (c.kind === 'file') {
        const targetsHook =
          isProtected(c.path, policy, 'hooks') ||
          (c.oldPath ? isProtected(c.oldPath, policy, 'hooks') : false);
        if (!targetsHook) {
          // package.json is config-class, but `prepare: husky` is the line that
          // INSTALLS the hooks on a fresh checkout — exact through the JSON, so
          // it is judged here rather than left to the coverage rules.
          if (isPackageJson(c.path) && c.before != null && c.after != null) {
            for (const reason of packageJsonWeakening(c.before, c.after)) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  message: `The hook installation was weakened: ${reason}.`,
                  evidence: reason,
                  remediation: 'Keep the lifecycle script that installs the git hooks. Without it a clone runs no hook at all.',
                }),
              );
            }
          }
          continue;
        }

        // A MODE-ONLY change carries no hunks, so nothing below ever saw it: `chmod
        // -x .husky/pre-commit` (husky v8 points core.hooksPath at that file, and
        // git silently skips a hook that is not executable) reached the staged,
        // worktree and range views as a modify with nothing in it — clean on all
        // three. The parser now records the modes; losing the owner execute bit on
        // a hook is the disabling it is.
        if (c.op !== 'delete' && c.oldMode && c.newMode && ownerExec(c.oldMode) && !ownerExec(c.newMode)) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: `Execute permission was removed from a protected hook (${c.oldMode} → ${c.newMode}) — git will skip it.`,
              evidence: `${c.path}: mode ${c.oldMode} → ${c.newMode}`,
              remediation: 'Restore the execute bit (chmod +x). A hook git cannot run is a disabled hook.',
            }),
          );
        }

        if (c.op === 'delete') {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: 'A protected hook/policy file was deleted.',
              evidence: c.path,
              remediation: 'Restore it. The hooks and the policy are protected assets, not obstacles to remove.',
            }),
          );
        } else if (c.op === 'rename' && !renameKept(c)) {
          out.push(
            makeFinding(RULE, policy, {
              file: c.path,
              message: `A protected hook/policy file was renamed (${c.oldPath} → ${c.path}).`,
              evidence: `${c.oldPath} → ${c.path}`,
              remediation: 'Renaming a hook out of place disables it. Restore the original path.',
            }),
          );
        } else if (
          (c.path.endsWith(POLICY_FILE) || isClaudeSettings(c.path)) &&
          (semantic = c.path.endsWith(POLICY_FILE) ? policyFindings(c, policy) : claudeSettingsFindings(c, changes, policy, ctx)) !== null
        ) {
          // Full content available and parseable → compare SEMANTICALLY: the policy
          // as the loader would merge it (every weakening move, incl. the multiline
          // form and an ADD judged against the baseline it displaces), the Claude
          // settings as the runtime would read them. A null result (no content, or a
          // before that already did not parse) drops through to the line-regex below.
          out.push(...semantic);
        } else if (c.op === 'rename') {
          // a same-identity rename with unchanged content: kept (see renameKept)
        } else if (isCodeowners(c.path)) {
          // Ownership wiring, not a script: the word `husky` in `/.husky/ @owner` is a
          // path, not an invocation. What can be lost here is a human requirement on
          // a gate-critical path. Needs both sides; a hunk-only view says nothing.
          if (c.before != null && c.after != null) {
            for (const reason of codeownersWeakening(c.before, c.after)) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  message: `CODEOWNERS was weakened: ${reason}.`,
                  evidence: reason,
                  remediation:
                    'Keep a code owner on the workflows, the policy and the hooks. That rule is the only thing requiring a human on a change to the gate itself.',
                }),
              );
            }
          }
        } else if ((isLefthook(c.path) || isPreCommitConfig(c.path)) && (semantic = configFindings(c, policy)) !== null) {
          out.push(...semantic);
        } else if (!c.path.endsWith(POLICY_FILE)) {
          // A hook SCRIPT. Deleting it fires above; the cheaper tamper is to leave the
          // file in place and gut its body: an early exit, a dropped or commented
          // invocation — or, at the same line count, `|| true` after the gate, a
          // dead `if false` around it, `echo` in front of it, `--version` instead of
          // `check`. The comparison is over the checks each version actually RUNS
          // (hook-wiring.ts invocations): runner prefix, pin and output redirection
          // are presentation; a survivor counts only when it is live on a
          // non-comment line in invocation position.
          const added = addedLines(c);
          const earlyExit = added.find((l) => insertsPassingExit(l.content));
          if (earlyExit) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: earlyExit.newLine ?? undefined,
                message: 'An early `exit 0` was inserted into a protected hook — it now passes everything.',
                evidence: earlyExit.content.trim(),
                remediation: 'Remove the early exit. A hook that always succeeds is a disabled hook.',
              }),
            );
          }
          // With full content the liveness comparison below decides what a guard
          // did; on a hunk-only view the guard line is all there is to see.
          const deadGuard = c.before == null || c.after == null ? added.find((l) => insertsDeadGuard(l.content)) : undefined;
          if (deadGuard) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: deadGuard.newLine ?? undefined,
                message: 'A guard that can never be true was inserted into a protected hook — what it wraps no longer runs.',
                evidence: deadGuard.content.trim(),
                remediation: 'Remove the dead condition. A check behind `if false` is a removed check.',
              }),
            );
          }
          const beforeLines = c.before != null ? c.before.split('\n') : removedLines(c).map((l) => l.content);
          const afterLines = c.after != null ? c.after.split('\n') : added.map((l) => l.content);
          const lost = scriptWeakening(beforeLines, afterLines);
          if (lost.length) {
            // one finding per hook is the signal; don't spam per line
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                message: `A check invocation was removed from a protected hook: ${lost[0].reason}.`,
                evidence: lost[0].evidence,
                remediation: 'Restore the check. Removing, commenting out, guarding off or swallowing the gate\'s exit status disables it just as surely as deleting the hook.',
              }),
            );
          }
        } else {
          // Fallback when full content isn't available: pair severity by RULE NAME
          // (inline form: `rule: { severity: block }`), so reformatting — which removes
          // block lines and adds warn lines for unrelated rules — does not read as a
          // lowering. Only the same rule going block → warn fires.
          const INLINE = /^\s*([A-Za-z0-9_-]+):\s*\{[^}]*\bseverity:\s*(block|warn)\b/;
          const removedSeverity = new Map<string, string>();
          for (const l of removedLines(c)) {
            const m = l.content.match(INLINE);
            if (m) removedSeverity.set(m[1], m[2]);
          }
          for (const l of addedLines(c)) {
            const m = l.content.match(INLINE);
            if (m && m[2] === 'warn' && removedSeverity.get(m[1]) === 'block') {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  line: l.newLine ?? undefined,
                  message: `Rule "${m[1]}" was lowered from block to warn in the policy.`,
                  evidence: l.content.trim(),
                  remediation: 'Do not weaken the policy to pass. Lowering a gate is a human sign-off decision.',
                }),
              );
            } else if (/enabled:\s*false\b/.test(l.content)) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  line: l.newLine ?? undefined,
                  message: 'A rule was disabled (enabled: false) in the policy.',
                  evidence: l.content.trim(),
                  remediation: 'Re-enable the rule. Disabling the check to pass is the tamper.',
                }),
              );
            }
          }
        }
      } else {
        for (const seg of segments(c.raw)) {
          const toks = tokens(seg).map(unquote);
          const hiding = updateIndexHiding(toks, policy);
          if (hiding) {
            out.push(
              makeFinding(RULE, policy, {
                message: `Hook tampering via shell: ${hiding}.`,
                evidence: seg,
                remediation:
                  'Leave protected files visible to git. Hiding one from the diff hides it from the gate, which is the tamper — use `--no-skip-worktree` / `--no-assume-unchanged` to undo it.',
              }),
            );
            continue;
          }
          // Only the hook as a WRITE TARGET is tampering. Naming it as a source
          // (`cat hook > /tmp/backup`, `cp hook /tmp/`, `sed -n 1,5p hook`) reads
          // it, and `chmod +x` restores it; both used to block.
          const why = shellWritesHook(seg, toks, policy);
          if (why) {
            out.push(
              makeFinding(RULE, policy, {
                message: `Hook tampering via shell: ${why}.`,
                evidence: seg,
                remediation: 'Leave the hooks in place. Mutating them from the shell is still tampering.',
              }),
            );
          }
        }
      }
    }
    return out;
  },
};
