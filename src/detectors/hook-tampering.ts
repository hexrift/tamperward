// #8 hook-tampering (file + command surface, mechanical).
// The "guard the guardrail" rule: the hooks and the policy file are protected assets.
// Deleting/renaming them, lowering a severity, disabling a rule, or chmod/rm-ing a
// hook from the shell are all the tamper.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { Change, Detector, DetectorContext, FileChange, Finding, Policy } from '../types';
import { addedLines, removedLines } from '../diff/select';
import { isProtected, POLICY_FILE } from '../policy';
import { PLAIN_SEMVER, PRE_TOOLS, TW_VERSION, compareVersions, initScriptPin, isClaudeSettings, pinNotBelow, resolvesToClaudeSettings } from '../wiring';
import { makeFinding } from './finding';
import { policyAddWeakening, policyWeakening } from './policy-diff';
import { segments, tokens, unquote } from './command';
import { trackedFiles } from './repo';
import {
  chmodDropsExec, codeownersWeakening, hookIdentity, insertsDeadGuard, insertsPassingExit, isCodeowners,
  isLefthook, isLefthookLocal, isPackageJson, isPreCommitConfig, lefthookWeakening, mergeDocs, packageJsonWeakening,
  parseDoc, preCommitWeakening, scriptWeakening, shebangProblem, shellHookTarget, shellWritesHook, xargsWritesHook,
} from './hook-wiring';

const RULE = 'hook-tampering';

/** Owner execute bit of a git mode ("100755"). */
const ownerExec = (mode: string): boolean => (parseInt(mode.slice(-3), 8) & 0o100) !== 0;

// ── Claude Code settings: the wiring, judged by the shape init writes ──────────
//
// `.claude/settings.json` carries the PreToolUse and Stop hooks `init` installs; it
// is the enforcement. Every earlier comparison asked whether the gate was PRESENT
// — a parsed `command` carrying `tamperward … hook claude` on a matcher covering
// the editing tools — and presence is not what the runtime does with an entry:
//   - `npx --yes tamperward@2.5.0 hook claude | head -c0` is present; the runtime
//     reads an empty stdout and allows;
//   - `"async": true` beside a perfect command means the verdict is never awaited;
//     `"if": "Bash(never)"` means it is never asked; `"timeout": 1` means it is
//     killed before it answers;
//   - `PATH=/tmp/evil:$PATH npx …`, `NODE_OPTIONS=--require=…`, `npx -p /tmp/evil
//     tamperward …`, `./node_modules/.bin/tamperward …` run whatever the edit
//     chose to call tamperward;
//   - `tamperward@0.1.0` is present, live, and a gate with every bypass since fixed.
// So the gate's entry is compared to the CANONICAL SHAPE init writes — exactly
// `{ "type": "command", "command": "npx --yes tamperward@<ver> hook claude" }` on a
// matcher covering every tool init lists, `sweep claude` under Stop, the pin a
// plain version never below the one it replaces — and the matcher is evaluated
// with the runtime's own semantics (exact list or regex). Hooks MERGE across the
// user, project and local files, so an added local file that declares its own
// hooks shadows nothing; what a local file can do is `disableAllHooks`, an `env`
// the gate command resolves through, or a neutered gate entry of its own.

const EVENTS = ['PreToolUse', 'Stop'] as const;
type HookEvent = (typeof EVENTS)[number];

type Settings = Record<string, unknown>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseSettings(src: string): Settings | null {
  try {
    const v: unknown = JSON.parse(src);
    return isObj(v) ? (v as Settings) : null;
  } catch {
    return null;
  }
}

function eventEntries(s: Settings, event: HookEvent): unknown[] | null {
  const hooks = s.hooks;
  if (!isObj(hooks)) return null;
  const arr = hooks[event];
  return Array.isArray(arr) ? arr : null;
}

/** Whether the file declares this event at all (an array, empty or not). */
const declares = (s: Settings, event: HookEvent): boolean => eventEntries(s, event) !== null;

/** Keys the canonical gate entry may carry. `timeout` is tolerated at or above
 *  120s — the hook needs time to run a diff — and is a finding below.
 *  `statusMessage` is the runtime's documented spinner text: cosmetic, a string. */
const GATE_KEYS = new Set(['type', 'command', 'timeout', 'statusMessage']);
/** The `type` values the runtime's schema accepts on a hook entry. */
const HOOK_TYPES = new Set(['command', 'prompt', 'agent', 'http']);
/** Keys a hook entry beside the gate may carry and still be a plain command entry. */
const SIBLING_KEYS = GATE_KEYS;
const CANONICAL_CMD = /^npx --yes tamperward@(\S+) (hook|sweep) claude$/;
/** An entry that carries the gate's words at all — in any launcher, any pin, any
 *  wrapping. The candidates the shape comparison then judges. */
const MENTIONS_GATE = /\btamperward\b.*\b(?:hook|sweep)\b/;
/** Text a sibling hook entry has no honest reason to emit: a forged decision. */
const FORGERY = /hookSpecificOutput|permissionDecision|updatedInput|"decision"|"continue"/;
/** Environment the gate command resolves through (the sensitive names), by the
 *  mechanism each reaches it: the explanation an `env` finding carries when the
 *  name is a known one, and the test a file WITHOUT the gate is still judged on.
 *  `env` applies to every session and every subprocess, the hook's shell is bash
 *  by default, and npm reads `npm_config_*` case-insensitively. In a file that
 *  carries the gate every other name is a finding too — init writes no `env`,
 *  and a name this table does not know is not a name the gate can vouch for. */
const ENV_MECHANISM: ReadonlyArray<[RegExp, string]> = [
  [/^PATH$/, 'the gate\'s launcher is looked up through it'],
  [/^(?:NODE_OPTIONS|NODE_PATH)$/, 'node loads what it names before the gate runs'],
  [/^HOME$/, 'npx\'s cache and configuration live under it'],
  [/^npm_config_/i, 'npx reads it as npm configuration, the registry the gate is fetched from included'],
  [/^(?:BASH_ENV|ENV)$/, 'a non-interactive shell sources it before every hook command'],
  [/^BASH_FUNC_/, 'bash imports it as a function that shadows the command it names'],
  [/^(?:LD|DYLD)_/, 'the dynamic loader injects it into every process, the gate included'],
  [/^TAMPERWARD_/, 'it configures the gate itself'],
];
const envMechanism = (k: string): string | null => ENV_MECHANISM.find(([re]) => re.test(k))?.[1] ?? null;

/** How a gate `command` string differs from the one init writes, and whether the
 *  runtime would still run the gate through it. */
function analyseGateCommand(cmd: string, event: HookEvent): { runs: boolean; problems: string[]; pin: string | null } {
  const want = event === 'PreToolUse' ? 'hook' : 'sweep';
  const problems: string[] = [];
  let runs = true;
  const canonical = cmd.match(CANONICAL_CMD);
  if (canonical) {
    if (canonical[2] !== want) { problems.push(`runs \`${canonical[2]} claude\` under ${event}`); runs = false; }
    if (!PLAIN_SEMVER.test(canonical[1])) { problems.push(`the pin \`${canonical[1]}\` is not a plain version`); runs = false; }
    return { runs, problems, pin: canonical[1] };
  }
  const inv = cmd.match(/\btamperward(?:@(\S+))?\s+(hook|sweep)\s+(\S+)/);
  if (!inv) return { runs: false, problems: ['the command does not invoke the gate'], pin: null };
  if (inv[2] !== want || inv[3] !== 'claude') { problems.push(`runs \`${inv[2]} ${inv[3]}\` under ${event}`); runs = false; }
  if (inv[1] !== undefined && !PLAIN_SEMVER.test(inv[1])) { problems.push(`the pin \`${inv[1]}\` is not a plain version`); runs = false; }
  if (/[|;&<>`]|\$\(/.test(cmd)) { problems.push('text around the invocation (a redirect, pipe or chain)'); runs = false; }
  if (/^\s*[A-Za-z_]\w*=/.test(cmd)) { problems.push('an environment assignment in front of the gate'); runs = false; }
  if (/\b(?:sh|bash|zsh|dash)\s+-[a-zA-Z]*c\b/.test(cmd)) { problems.push('wrapped in `sh -c`'); runs = false; }
  if (/(?:^|\s)(?:-p|--package)(?:=|\s)/.test(cmd)) { problems.push('`-p`/`--package` points npx at another package'); runs = false; }
  const at = cmd.indexOf(inv[0]);
  const trailing = cmd.slice(at + inv[0].length).trim();
  if (trailing) { problems.push(`extra text after the invocation (\`${trailing}\`)`); runs = false; }
  const head = cmd.slice(0, at).trim();
  if (head !== 'npx --yes') problems.push(`the launcher \`${head || '(none)'}\` is not \`npx --yes\``);
  return { runs, problems, pin: inv[1] ?? '' };
}

/** The tools a matcher selects, with the runtime's semantics: absent, empty or `*`
 *  is every tool (null); a string of letters, digits, `_`, `-`, spaces, `,` and
 *  `|` is an exact list separated by `|` or `,` with optional surrounding
 *  whitespace (`Edit|Write` and `Edit, Write` each match either tool exactly —
 *  the runtime's own matcher table); anything else is an unanchored regular
 *  expression tested per tool. A matcher that is not a string, or not a valid
 *  pattern, selects nothing and is reported. */
function matcherSelection(m: unknown): { tools: Set<string> | null; problem: string | null } {
  if (m === undefined) return { tools: null, problem: null };
  if (typeof m !== 'string') return { tools: new Set(), problem: `the matcher ${JSON.stringify(m)} is not a string` };
  if (m === '' || m === '*') return { tools: null, problem: null };
  let problem: string | null = null;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(m)) problem = 'the matcher contains non-ASCII characters that look like tool names but are not';
  if (/^[A-Za-z0-9_ ,|-]+$/.test(m)) return { tools: new Set(m.split(/[|,]/).map((t) => t.trim()).filter(Boolean)), problem };
  let re: RegExp;
  try {
    re = new RegExp(m);
  } catch {
    return { tools: new Set(), problem: `the matcher \`${m}\` is not a valid pattern — it selects nothing` };
  }
  return { tools: new Set(PRE_TOOLS.filter((t) => re.test(t))), problem };
}

/** How a hook entry's keys differ from the canonical command entry, and whether
 *  the runtime would still run it as one: a `type` other than `command`, a key
 *  init does not write, a `timeout` that cuts the gate off, a non-string
 *  `statusMessage`. */
function entryShape(h: Obj): { problems: string[]; runs: boolean } {
  const problems: string[] = [];
  let runs = true;
  if (h.type !== 'command') {
    problems.push(h.type === undefined ? 'no `type`' : `\`type\` is ${JSON.stringify(h.type)}`);
    if (h.type !== undefined) runs = false;
  }
  for (const k of Object.keys(h)) {
    if (GATE_KEYS.has(k)) continue;
    problems.push(`carries \`${k}\``);
    runs = false;
  }
  if ('timeout' in h) {
    const t = h.timeout;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 120) { problems.push(`\`timeout\` ${JSON.stringify(t)} — the gate is cut off before it answers`); runs = false; }
  }
  if ('statusMessage' in h && typeof h.statusMessage !== 'string') { problems.push(`\`statusMessage\` ${JSON.stringify(h.statusMessage)} is not a string`); runs = false; }
  return { problems, runs };
}

interface Candidate {
  /** The entry as written, for "was this exact entry already there". */
  key: string;
  /** The runtime would run the gate through this entry and honour its verdict. */
  runs: boolean;
  /** How the entry differs from what init writes. */
  problems: string[];
  pin: string | null;
  /** Tools the matcher selects; null for every tool. */
  tools: Set<string> | null;
}

/** Whether a value names the gate anywhere in its JSON. */
const mentionsGate = (v: unknown): boolean => /\btamperward\b/.test(JSON.stringify(v) ?? '');

/** Every entry under `event` that names the gate, judged. Entries the runtime's
 *  schema would reject are candidates with a problem, not silence. */
function gateCandidates(s: Settings, event: HookEvent): Candidate[] {
  const out: Candidate[] = [];
  for (const group of eventEntries(s, event) ?? []) {
    if (!isObj(group)) {
      if (mentionsGate(group)) out.push({ key: JSON.stringify(group), runs: false, problems: ['the matcher entry is not an object'], pin: null, tools: null });
      continue;
    }
    if (!Array.isArray(group.hooks)) {
      if (mentionsGate(group)) out.push({ key: JSON.stringify(group), runs: false, problems: ['`hooks` is not a list'], pin: null, tools: null });
      continue;
    }
    for (const h of group.hooks) {
      if (!isObj(h)) {
        if (mentionsGate(h)) out.push({ key: JSON.stringify(h), runs: false, problems: ['the hook entry is not an object'], pin: null, tools: null });
        continue;
      }
      const cmd = typeof h.command === 'string' ? h.command : null;
      if (cmd === null) {
        if (mentionsGate(h)) out.push({ key: JSON.stringify(h), runs: false, problems: ['the gate is not in a `command` string'], pin: null, tools: null });
        continue;
      }
      if (!MENTIONS_GATE.test(cmd)) continue;
      const a = analyseGateCommand(cmd, event);
      const shape = entryShape(h);
      const problems = [...a.problems, ...shape.problems];
      let runs = a.runs && shape.runs;
      let tools: Set<string> | null = null;
      if (event === 'PreToolUse') {
        const sel = matcherSelection(group.matcher);
        tools = sel.tools;
        if (sel.problem) { problems.push(sel.problem); }
      } else if (group.matcher !== undefined && !(typeof group.matcher === 'string' && (group.matcher === '' || group.matcher === '*'))) {
        problems.push(`a \`matcher\` (${JSON.stringify(group.matcher)}) on the Stop entry`);
        runs = false;
      }
      out.push({ key: JSON.stringify({ m: group.matcher, h }), runs, problems, pin: a.pin, tools });
    }
  }
  return out;
}

/** Whether the file carries the gate under either event, in any shape. */
const carriesGate = (s: Settings): boolean => EVENTS.some((e) => gateCandidates(s, e).length > 0);

/** Non-gate command entries under an event, as written. */
function otherCommands(s: Settings, event: HookEvent): string[] {
  const out: string[] = [];
  for (const group of eventEntries(s, event) ?? []) {
    if (!isObj(group) || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks) {
      if (!isObj(h) || typeof h.command !== 'string' || MENTIONS_GATE.test(h.command)) continue;
      out.push(h.command);
    }
  }
  return out;
}

/** Every hook entry under every event the file declares, with its group, keyed
 *  as written — the unit a sibling edit is judged at. */
function allEntries(s: Settings): Array<{ event: string; key: string; group: Obj; h: unknown }> {
  const hooks = s.hooks;
  if (!isObj(hooks)) return [];
  const out: Array<{ event: string; key: string; group: Obj; h: unknown }> = [];
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) out.push({ event, key: JSON.stringify({ e: event, m: group.matcher, h }), group, h });
    }
  }
  return out;
}

/** A value the runtime's schema rejects on a hook entry — on ANY entry: a file
 *  with a rejected value is "broken settings" the runtime continues without,
 *  the gate entries in it included. Which values are rejected per entry and
 *  which fail the file is not documented, so every one is read as the latter. */
function schemaProblem(group: Obj, h: unknown): string | null {
  if (group.matcher !== undefined && typeof group.matcher !== 'string') return `the matcher ${JSON.stringify(group.matcher)} is not a string`;
  if (!isObj(h)) return `the hook entry ${JSON.stringify(h)} is not an object`;
  if (typeof h.type !== 'string' || !HOOK_TYPES.has(h.type)) return `\`type\` ${JSON.stringify(h.type)} is not one the runtime accepts`;
  if (h.type === 'command' && typeof h.command !== 'string') return '`command` is not a string';
  if ('timeout' in h && (typeof h.timeout !== 'number' || !Number.isFinite(h.timeout) || h.timeout <= 0)) return `\`timeout\` ${JSON.stringify(h.timeout)} is not a positive number`;
  return null;
}

/** Why a hook entry ADDED beside the gate under PreToolUse or Stop needs a
 *  sign-off. The textual forgery is the fast path with the specific message; a
 *  shape that is not a plain command entry (`args`, `http`, `prompt`, `agent`,
 *  `async`, `if`) is named; and a plain command is still a finding, because its
 *  output combines with the gate's verdict — an `updatedInput` rewrites the tool
 *  input after the gate allowed it (the last hook wins), a `continue: false`
 *  takes precedence over the sweep's block — and a script body carries what the
 *  regex cannot see. init writes no entry beside the gate. */
function siblingProblem(h: Obj): string {
  const cmd = typeof h.command === 'string' ? h.command : '';
  if (FORGERY.test(cmd)) return `emits a hook decision of its own (\`${cmd.slice(0, 60)}\`)`;
  if (h.type !== 'command') return `is not a plain command entry (\`type\` is ${JSON.stringify(h.type)})`;
  const extra = Object.keys(h).filter((k) => !SIBLING_KEYS.has(k));
  if (extra.length) return `is not a plain command entry (carries \`${extra.join('`, `')}\`)`;
  return `was added (\`${cmd.slice(0, 60)}\`) — its output combines with the gate's verdict (an \`updatedInput\` after an allow, a \`continue: false\` over a block), and init writes no entry beside the gate`;
}

/** The union of tools the gate's live entries cover for an event: null = every
 *  tool, 'none' = the gate is not wired for this event. */
function coverage(cs: Candidate[]): Set<string> | null | 'none' {
  const live = cs.filter((c) => c.runs);
  if (live.length === 0) return 'none';
  if (live.some((c) => c.tools === null)) return null;
  return new Set(live.flatMap((c) => [...(c.tools as Set<string>)]));
}

/** Keys that appear twice in one JSON object: the runtime's reading of the file
 *  is whichever its parser keeps, which is not something the gate can vouch for. */
export function duplicateJsonKeys(src: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; } else { s += src[j]; j++; }
      }
      if (expectKey) {
        const set = stack[stack.length - 1];
        if (set) { if (set.has(s)) dups.push(s); set.add(s); }
        expectKey = false;
      }
      i = j;
      continue;
    }
    if (ch === '{') { stack.push(new Set()); expectKey = true; }
    else if (ch === '[') { stack.push(null); expectKey = false; }
    else if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; }
    else if (ch === ',') expectKey = stack[stack.length - 1] !== null;
  }
  return [...new Set(dups)];
}

/** Reasons the after-settings run less of the gate than the before-settings did
 *  — or, for an entry this edit wrote, less than init would have written. */
function settingsWeakening(before: Settings | null, after: Settings, local: boolean): string[] {
  const reasons: string[] = [];
  const gated = carriesGate(after);
  const gatedBefore = before !== null && carriesGate(before);
  const dis = after.disableAllHooks;
  if (dis !== undefined && dis !== false && !(before !== null && before.disableAllHooks === dis)) {
    reasons.push(`\`disableAllHooks: ${JSON.stringify(dis)}\` switches every hook off, the gate included`);
  }
  // init declares `disableAllHooks: false` in the file it writes (2.9.0): the
  // project value overrides the user file's, so a `true` planted in
  // `~/.claude/settings.json` — which no repository glob names — no longer
  // reaches the gate. Dropping the declaration reopens that route. A file init
  // wrote before 2.9.0 has no declaration and stays clean until an edit writes
  // the gate into it anew.
  if (gated && dis === undefined) {
    if (before !== null && before.disableAllHooks === false) {
      reasons.push('`disableAllHooks: false` was removed — init declares it so that a `true` in the user settings file cannot switch the gate off');
    } else if (!gatedBefore) {
      reasons.push('`disableAllHooks: false` is not declared — init declares it in the file it writes, so that a `true` in the user settings file cannot switch the gate off');
    }
  }
  // `env` is set for every session and every subprocess. A key added or changed
  // in a file that carries the gate is a finding whatever its name (init writes
  // no `env`); a well-known name is a finding in any settings file, and the
  // reason names the mechanism. Removing a key never weakens anything.
  if (isObj(after.env)) {
    const was = before !== null && isObj(before.env) ? before.env : {};
    for (const [k, v] of Object.entries(after.env)) {
      if (k in was && JSON.stringify(was[k]) === JSON.stringify(v)) continue;
      const how = envMechanism(k);
      if (how) reasons.push(`a top-level \`env\` sets ${k} — ${how}`);
      else if (gated) reasons.push(`a top-level \`env\` sets ${k} — every hook command runs with it, and init writes no \`env\``);
    }
  }
  for (const event of EVENTS) {
    const bc = before !== null ? gateCandidates(before, event) : [];
    const ac = gateCandidates(after, event);
    const was = coverage(bc);
    const now = coverage(ac);
    if (was !== 'none') {
      if (now === 'none') {
        reasons.push(`the tamperward ${event} hook entry was removed`);
      } else if (event === 'PreToolUse') {
        // Stop hooks take no matcher; for PreToolUse the matcher IS the coverage.
        if (was === null && now !== null) {
          reasons.push(`the PreToolUse matcher for the gate was narrowed from every tool to ${[...now].join('|') || '(nothing)'}`);
        } else if (was !== null && now !== null) {
          const lost = [...was].filter((t) => !now.has(t));
          if (lost.length) reasons.push(`the PreToolUse matcher for the gate no longer covers ${lost.join(', ')}`);
        }
      }
    } else if (now === 'none' && declares(after, event) && !(before !== null && declares(before, event)) && (eventEntries(after, event) ?? []).length === 0) {
      // An EMPTY declaration has no other purpose. (Hooks merge across the settings
      // files, so a non-empty list of somebody's own hooks shadows nothing.)
      reasons.push(`${event} hooks declared empty in ${local ? 'an override file' : 'the settings file'}`);
    }
    // Entries this edit wrote are held to the shape init writes.
    const had = new Set(bc.map((c) => c.key));
    const fresh = ac.filter((c) => !had.has(c.key));
    for (const c of fresh) {
      if (c.problems.length) reasons.push(`the ${event} gate entry does not match the shape \`tamperward init\` writes: ${c.problems.join('; ')}`);
    }
    // The pin only ever goes up, and never past the gate judging it: never below
    // what the file pinned before — for a file that had no gate entry under this
    // event, never below the judging gate — and, for an entry this edit wrote,
    // never above it either. `npx --yes tamperward@99.0.0` is a pin npm cannot
    // resolve, and a hook that exits non-zero without a decision is fail-OPEN;
    // an unpinned entry runs whatever `tamperward` resolves to on this machine.
    // A gate entry the file carried unpinned (as init wrote before 1.14.7) sets
    // no floor. The honest raise is `tamperward init` run from the newer version,
    // which raises the judging gate together with the pin.
    const pins = bc.map((c) => c.pin).filter((p): p is string => !!p && PLAIN_SEMVER.test(p)).sort((a, b) => (compareVersions(b, a) ?? 0));
    const judging = PLAIN_SEMVER.test(TW_VERSION) ? TW_VERSION : null;
    const floor = pins[0] ?? (bc.length === 0 ? judging : null);
    for (const c of fresh) {
      if (c.pin === null || (c.pin !== '' && !PLAIN_SEMVER.test(c.pin))) continue; // reported by the shape above
      if (floor !== null && !pinNotBelow(c.pin, floor)) {
        reasons.push(
          c.pin === ''
            ? `the ${event} gate is unpinned, below ${floor} — \`npx\` then runs whatever \`tamperward\` resolves to on this machine`
            : `the ${event} gate is pinned to tamperward@${c.pin}, below ${floor}`,
        );
      } else if (judging !== null && c.pin !== '' && (compareVersions(c.pin, judging) ?? 0) > 0) {
        reasons.push(`the ${event} gate is pinned to tamperward@${c.pin}, above the ${judging} judging it — a pin npm cannot resolve fails the hook open; raise it by running \`tamperward init\` from the newer version, which raises the judging gate with it`);
      }
    }
  }
  if (gated) {
    // Every entry this edit wrote beside the gate, under any event: a value the
    // schema rejects loses the whole file; a new entry under a gate event
    // combines with the gate's verdict. An entry that was there before, as
    // written, is not this edit's doing.
    const had = new Set(before !== null ? allEntries(before).map((e) => e.key) : []);
    for (const e of allEntries(after)) {
      if (had.has(e.key) || mentionsGate(e.h)) continue;
      const schema = schemaProblem(e.group, e.h);
      if (schema) {
        reasons.push(`a ${e.event} hook entry carries a value the runtime's schema rejects (${schema}) — the runtime continues without the broken file, the gate included`);
      } else if (e.event === 'PreToolUse' || e.event === 'Stop') {
        reasons.push(`a ${e.event} hook entry beside the gate ${siblingProblem(e.h as Obj)}`);
      }
    }
  } else {
    // A file without the gate: a sibling that forges a decision is still one
    // (hooks merge across the settings files).
    for (const event of EVENTS) {
      const hadOther = new Set(before !== null ? otherCommands(before, event) : []);
      for (const cmd of otherCommands(after, event)) {
        if (!hadOther.has(cmd) && FORGERY.test(cmd)) reasons.push(`a ${event} hook entry beside the gate emits a hook decision of its own (\`${cmd.slice(0, 60)}\`)`);
      }
    }
  }
  return reasons;
}

/**
 * Findings for a change to a Claude settings file, or null when the semantic
 * comparison has nothing to stand on (no full content on either side, or a
 * before that already did not parse) — the caller then falls back to the line
 * comparison. A file that parsed before and does not parse after is reported
 * here: the runtime ignores an unparseable settings file, hooks and all.
 */
function claudeSettingsFindings(c: FileChange, policy: Policy): Finding[] | null {
  if (c.after == null) return null;
  const after = parseSettings(c.after);
  const before = c.before != null ? parseSettings(c.before) : null;
  const finding = (reason: string): Finding =>
    makeFinding(RULE, policy, {
      file: c.path,
      message: `The Claude Code hook wiring was weakened: ${reason}.`,
      evidence: reason,
      remediation:
        'Leave the PreToolUse and Stop entries that run tamperward, the matcher that covers every editing tool, and `disableAllHooks: false` exactly as `tamperward init` wrote them, with no `env` and no hook entry beside the gate. Editing the wiring is editing the gate: re-run `tamperward init` to restore it, or sign off.',
    });
  if (c.before != null && before === null) return null; // was already unreadable: nothing to compare
  if (after === null) {
    if (c.before == null) return []; // an unreadable new file wires nothing and shadows nothing
    return [finding('the settings file no longer parses as JSON — the runtime ignores it, hooks and all')];
  }
  const reasons = settingsWeakening(before, after, /settings\.local\.json$/.test(c.path));
  const had = new Set(c.before != null ? duplicateJsonKeys(c.before) : []);
  for (const k of duplicateJsonKeys(c.after)) {
    if (!had.has(k)) reasons.push(`the key "${k}" appears twice — which reading the runtime keeps is not something the gate can vouch for`);
  }
  return reasons.map(finding);
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

/** The lefthook.yml a lefthook-local overlay sits on, as it will stand after this
 *  changeset: its own change in the same Change[] wins, then the checkout on disk.
 *  null when it cannot be known. */
function lefthookBase(c: FileChange, changes: Change[], ctx?: DetectorContext): Record<string, unknown> | null {
  const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/') + 1) : '';
  const names = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'].map((n) => dir + n);
  const inSet = changes.find((o): o is FileChange => o.kind === 'file' && names.includes(o.path));
  if (inSet) return inSet.after != null ? parseDoc(inSet.after) : null;
  if (!ctx?.cwd) return null;
  for (const n of names) {
    try {
      const p = join(ctx.cwd, n);
      if (existsSync(p)) return parseDoc(readFileSync(p, 'utf8'));
    } catch {
      /* unreadable: unknown */
    }
  }
  return null;
}

/** When the lefthook.yml an overlay sits on cannot be read, the overlay's own
 *  entries under the gate's name are read as the gate: `tamperward: { skip: true }`
 *  in a local file has one purpose. */
function syntheticBase(over: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [section, v] of Object.entries(over)) {
    if (!isObj(v)) continue;
    for (const group of ['commands', 'scripts']) {
      const g = v[group];
      if (!isObj(g)) continue;
      for (const name of Object.keys(g)) {
        if (!/tamperward/.test(name)) continue;
        const sec = (base[section] ??= {}) as Record<string, unknown>;
        const grp = (sec[group] ??= {}) as Record<string, unknown>;
        grp[name] = { run: 'npx tamperward check --staged' };
      }
    }
  }
  return base;
}

/**
 * lefthook and pre-commit configs, compared as the tool reads them: the entry
 * that runs the gate removed or no longer live, `skip:`/`only:` in any non-false
 * shape, a `glob`/`exclude`/tag narrowing, `stages` (explicit or inherited from
 * `default_stages`) no longer including the commit stages. A lefthook-local file
 * is judged as the overlay it is: merged over lefthook.yml, before and after.
 * null when there is nothing to compare — the caller falls back to the script
 * comparison.
 */
function configFindings(c: FileChange, changes: Change[], policy: Policy, ctx?: DetectorContext): Finding[] | null {
  if (c.after == null) return null;
  let reasons: string[];
  if (isLefthookLocal(c.path)) {
    const overBefore = c.before != null ? parseDoc(c.before) : {};
    const overAfter = parseDoc(c.after);
    if (overBefore === null) return null;
    const base = lefthookBase(c, changes, ctx) ?? syntheticBase(overAfter ?? {});
    reasons = overAfter === null
      ? ['the file no longer parses as YAML — the tool that reads it runs nothing']
      : lefthookWeakening(mergeDocs(base, overBefore), mergeDocs(base, overAfter));
  } else {
    if (c.before == null) return null;
    const before = parseDoc(c.before);
    const after = parseDoc(c.after);
    if (before === null) return null;
    reasons =
      after === null
        ? ['the file no longer parses as YAML — the tool that reads it runs nothing']
        : isLefthook(c.path)
          ? lefthookWeakening(before, after)
          : preCommitWeakening(before, after);
  }
  return reasons.map((reason) =>
    makeFinding(RULE, policy, {
      file: c.path,
      message: `The hook configuration was weakened: ${reason}.`,
      evidence: reason,
      remediation: 'Leave the entry that runs the gate as `tamperward init` wrote it. Skipping, staging-off or scoping it is disabling it.',
    }),
  );
}

/** The repository's own workflow files and hooks, for the CODEOWNERS comparison. */
function repoGateFiles(ctx?: DetectorContext): string[] {
  const files = trackedFiles(ctx);
  if (!files) return [];
  return files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /^\.husky\/[^/_][^/]*$/.test(f));
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
function updateIndexHiding(toks: string[], policy: Policy): { reason: string; file: string } | null {
  if (!toks.some((t) => t === 'git' || t.endsWith('/git')) || !toks.includes('update-index')) return null;
  const hide = toks.find((t) => /^--(?:skip-worktree|assume-unchanged)$/.test(t));
  const hidden = hide ? toks.find((t) => isProtected(t, policy)) : undefined;
  if (hide && hidden) {
    return {
      reason: `git update-index ${hide} hides a protected file from every git diff — edits to it no longer reach the sweep or the pre-commit gate`,
      file: hidden,
    };
  }
  const hook = toks.some((t) => /^--chmod=-x$/.test(t)) ? toks.find((t) => isProtected(t, policy, 'hooks')) : undefined;
  if (hook) {
    return { reason: 'git update-index --chmod=-x clears the execute bit on a protected hook through the index, which disables it', file: hook };
  }
  return null;
}

/** The path a command-surface finding is about, repo-relative when the command
 *  spelled it absolute inside the checkout. The engine's pin reads it against the
 *  baseline hook globs, which are repo-relative. */
function repoRelative(path: string, ctx?: DetectorContext): string {
  if (!ctx?.cwd || !isAbsolute(path)) return path;
  const rel = relative(ctx.cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** husky runs its scripts through `sh -e`; every other hook is exec'ed by git. */
const isHuskyScript = (path: string): boolean => /(?:^|\/)\.husky\/[^/]+$/.test(path);

export const hookTampering: Detector = {
  id: RULE,
  surface: ['file', 'command'],
  certainty: 'mechanical',
  run(changes: Change[], policy, _view, ctx): Finding[] {
    const out: Finding[] = [];

    for (const c of changes) {
      let semantic: Finding[] | null;
      if (c.kind === 'file') {
        // A Claude settings file is the enforcement wherever the runtime reads it
        // from — the user file and managed settings included, which the tool-call
        // layer sees by absolute path and no protected glob names.
        const targetsHook =
          isProtected(c.path, policy, 'hooks') ||
          (c.oldPath ? isProtected(c.oldPath, policy, 'hooks') : false) ||
          resolvesToClaudeSettings(c.path);
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
          (c.path.endsWith(POLICY_FILE) || resolvesToClaudeSettings(c.path)) &&
          (semantic = c.path.endsWith(POLICY_FILE) ? policyFindings(c, policy) : claudeSettingsFindings(c, policy)) !== null
        ) {
          // Full content available and parseable → compare SEMANTICALLY: the policy
          // as the loader would merge it (every weakening move, incl. the multiline
          // form and an ADD judged against the baseline it displaces), the Claude
          // settings against the shape init writes. A null result (no content, or a
          // before that already did not parse) drops through to the line-regex below.
          out.push(...semantic);
        } else if (c.op === 'rename') {
          // a same-identity rename with unchanged content: kept (see renameKept)
        } else if (isCodeowners(c.path)) {
          // Ownership wiring, not a script: the word `husky` in `/.husky/ @owner` is a
          // path, not an invocation. What can be lost here is a human requirement on
          // a gate-critical file. Needs both sides; a hunk-only view says nothing.
          if (c.before != null && c.after != null) {
            for (const reason of codeownersWeakening(c.before, c.after, [...repoGateFiles(ctx), c.path])) {
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
        } else if ((isLefthook(c.path) || isPreCommitConfig(c.path)) && (semantic = configFindings(c, changes, policy, ctx)) !== null) {
          out.push(...semantic);
        } else if (!c.path.endsWith(POLICY_FILE)) {
          // A hook SCRIPT. Deleting it fires above; the cheaper tamper is to leave the
          // file in place and gut its body. A script init wrote is held to the shape
          // init writes: the same three lines, a pin that only goes up. A hand-written
          // script is compared over the checks each version actually RUNS
          // (hook-wiring.ts invocations): runner prefix, pin and output redirection
          // are presentation; a survivor counts only when it is live — its failure
          // able to fail the hook — under the way this hook is run.
          const husky = isHuskyScript(c.path);
          const beforePin = c.before != null && c.after != null ? initScriptPin(c.before) : null;
          if (beforePin !== null) {
            const afterPin = initScriptPin(c.after as string);
            const kept = afterPin !== null && (beforePin === '' ? afterPin === '' || PLAIN_SEMVER.test(afterPin) : pinNotBelow(afterPin, beforePin));
            if (!kept) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  message: 'A protected hook script no longer matches the shape `tamperward init` writes.',
                  evidence: 'the gate script no longer matches the shape init wrote; re-run init or sign off',
                  remediation:
                    'The pre-commit script init writes is the marker line and the pinned staged check, nothing else. Re-run `tamperward init` to restore it, or sign off on the customised script.',
                }),
              );
            }
            continue;
          }
          if (!husky && c.after != null) {
            const problem = shebangProblem(c.after);
            if (problem && (c.before == null || problem !== shebangProblem(c.before))) {
              out.push(
                makeFinding(RULE, policy, {
                  file: c.path,
                  line: 1,
                  message: `A protected hook's interpreter was changed: ${problem}.`,
                  evidence: c.after.split('\n')[0],
                  remediation: 'Keep a shell in shebang position. git execs the hook directly, and an interpreter that never reads the script is a disabled hook.',
                }),
              );
            }
          }
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
          const lost = scriptWeakening(beforeLines, afterLines, husky ? { errexit: true } : {});
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
        // The tokens of every segment so far: `echo .husky/pre-commit | xargs rm`
        // names the hook in the segment that FEEDS the one that deletes it.
        const fed: string[] = [];
        for (const seg of segments(c.raw)) {
          const toks = tokens(seg).map(unquote);
          const hiding = updateIndexHiding(toks, policy);
          if (hiding) {
            out.push(
              makeFinding(RULE, policy, {
                file: repoRelative(hiding.file, ctx),
                message: `Hook tampering via shell: ${hiding.reason}.`,
                evidence: seg,
                remediation:
                  'Leave protected files visible to git. Hiding one from the diff hides it from the gate, which is the tamper — use `--no-skip-worktree` / `--no-assume-unchanged` to undo it.',
              }),
            );
            fed.push(...toks);
            continue;
          }
          // Only the hook as a WRITE TARGET is tampering. Naming it as a source
          // (`cat hook > /tmp/backup`, `cp hook /tmp/`, `sed -n 1,5p hook`) reads
          // it, and `chmod +x` restores it; both used to block.
          const why = shellWritesHook(seg, toks, policy, ctx) ?? xargsWritesHook(toks, fed, policy, ctx);
          if (why) {
            // `file` is load-bearing: the guarded-rule pin (engine) applies only to a
            // finding that names the policy file or a baseline hook, so a command
            // finding without one was governed by the policy it may have just weakened.
            const target = shellHookTarget(seg, toks, policy, ctx) ?? shellHookTarget('', fed, policy, ctx);
            const file = target ? repoRelative(target, ctx) : undefined;
            // The user and managed settings files live outside every repository
            // glob; the runtime reads hooks from them and reloads them live.
            const outside = file !== undefined && (isAbsolute(file) || /^[A-Za-z]:\//.test(file)) && isClaudeSettings(file)
              ? ` — ${file} is a Claude Code settings file the runtime reads hooks from`
              : '';
            out.push(
              makeFinding(RULE, policy, {
                ...(file !== undefined ? { file } : {}),
                message: `Hook tampering via shell: ${why}${outside}.`,
                evidence: seg,
                remediation: 'Leave the hooks in place. Mutating them from the shell is still tampering.',
              }),
            );
          }
          fed.push(...toks);
        }
      }
    }
    return out;
  },
};
