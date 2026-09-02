// The enforcement wiring, read at the grain each format actually has.
//
// hook-tampering used to compare every hooks-class file as text: a removed line
// carrying a runner token, an added line matching `^exit 0$`. Text is the wrong
// grain for all of them, in both directions. A shell hook is disabled just as well
// by `|| true`, by `if false; then`, by `exit 0  # done`, by piping the gate into
// `tee`; it is NOT disabled by `npx` becoming `pnpm exec`. CODEOWNERS is not a
// script at all, and the word `husky` in an ownership rule is not an invocation.
// A lefthook or pre-commit entry is disabled by `skip: true`, by `stages:
// [manual]`, by an `exclude` covering everything — no invocation moves. Each
// helper here reads one format the way its consumer does; hook-tampering asks
// them what was lost.

import { parse as parseYaml } from 'yaml';
import { isProtected } from '../policy';
import { Policy } from '../types';

// ── shell hook scripts ─────────────────────────────────────────────────────────

/** Drop a trailing `# comment` that sits outside quotes. */
export function stripComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
    else if (ch === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const isComment = (line: string): boolean => /^\s*#/.test(line);

/** A package runner in front of the tool. `npx tamperward`, `pnpm exec tamperward`,
 *  `yarn tamperward` and `bunx tamperward` run the same binary; the prefix is a
 *  package-manager preference, not a check. */
const RUNNER = /^(?:npx|pnpm|yarn|bunx|bun|npm)\s+(?:(?:exec|dlx|x|run)\s+)?(?:(?:--yes|-y|--no-install|--silent|-s|--)\s+)*/;

/** Tools that are a check wherever they are invoked from. */
const TOOL = /^(tamperward|jest|vitest|eslint|tsc|lint-staged|lefthook|husky|pytest|make|cargo|go|pre-commit|mypy|ruff|rubocop|prettier|gradlew?)\b/;
/** Script names that are a check only when run THROUGH a package runner (`npm test`);
 *  a bare `test` in shell is the `[` builtin. */
const SCRIPT = /^(test|tests|lint|typecheck|type-check|coverage|check)\b/;
/** Tools whose first argument names WHAT runs (`tamperward check`, `make test`). */
const SUBCOMMAND_TOOLS = new Set(['tamperward', 'make', 'cargo', 'go', 'lefthook', 'husky', 'pre-commit']);

/** Words a segment may start with that are not the command: keywords, env
 *  assignments, wrappers. */
const PREFIX = /^(?:(?:then|do|else|\{|\(|!|exec|command|time|nice|env|sudo|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"(?=\s|$)|'[^']*'(?=\s|$)|[^\s"']\S*|(?=\s)))\s+)*/;

/**
 * The identity of the check a shell segment runs, or null when it runs none.
 *
 * `npx tamperward@2.1.0 check --staged >/dev/null` and `pnpm exec tamperward check
 * --staged` are the same check: runner, pin, output redirection and extra flags
 * are not what a hook is for. `echo "npx tamperward check --staged"` is not a
 * check (the invocation is in argument position) and neither is `npx tamperward
 * --version` (no subcommand that checks anything).
 */
export function checkIdentity(segment: string): string | null {
  const core = segment.trim().replace(PREFIX, '').replace(/\s+/g, ' ');
  const viaRunner = RUNNER.test(core);
  const rest = core.replace(RUNNER, '');
  const tool = rest.match(TOOL)?.[1] ?? (viaRunner ? rest.match(SCRIPT)?.[1] : undefined);
  if (!tool) return null;
  const toks = rest.replace(/^tamperward@\S+/, 'tamperward').split(' ');
  if (tool === 'tamperward') {
    const sub = toks[1];
    if (!sub || sub.startsWith('-')) return null; // `tamperward --version` checks nothing
    return `tamperward ${sub}`;
  }
  if (SUBCOMMAND_TOOLS.has(tool) && toks[1] && !toks[1].startsWith('-')) return `${tool} ${toks[1]}`;
  return tool;
}

/** Split a statement into its segments and the operators between them. */
function split(stmt: string): { segs: string[]; ops: string[] } {
  const segs: string[] = [];
  const ops: string[] = [];
  const re = /(&&|\|\||;|\|)/g;
  let last = 0;
  for (const m of stmt.matchAll(re)) {
    segs.push(stmt.slice(last, m.index));
    ops.push(m[1]);
    last = (m.index ?? 0) + m[1].length;
  }
  segs.push(stmt.slice(last));
  return { segs, ops };
}

const unq = (s: string): string => s.replace(/^["']|["']$/g, '');

/**
 * Whether a shell condition can never be true — the spellings of `false`.
 * `[ 0 -eq 1 ]`, `[ "a" = "b" ]`, `[ -n "" ]`, `test 1 -eq 0`, `! true`, `( exit 1 )`.
 * Anything mentioning a variable is unknown, and unknown is not false.
 */
export function alwaysFalse(cond: string): boolean {
  const c = cond.trim().replace(/;$/, '').trim();
  if (/^(?:false|!\s*true|\(\s*exit\s+[1-9]\d*\s*\))$/.test(c)) return true;
  const m = c.match(/^(?:\[\[\s+(.+?)\s+\]\]|\[\s+(.+?)\s+\]|test\s+(.+))$/);
  if (!m) return false;
  const inner = (m[1] ?? m[2] ?? m[3]).trim();
  if (inner.includes('$')) return false;
  const parts = inner.match(/^(\S+)\s+(-eq|-ne|-lt|-le|-gt|-ge|=|==|!=)\s+(\S+)$/);
  if (parts) {
    const [, a, op, b] = parts;
    const x = unq(a);
    const y = unq(b);
    const nx = Number(x);
    const ny = Number(y);
    const ints = /^-?\d+$/.test(x) && /^-?\d+$/.test(y);
    switch (op) {
      case '-eq': return ints && nx !== ny;
      case '-ne': return ints && nx === ny;
      case '-lt': return ints && !(nx < ny);
      case '-le': return ints && !(nx <= ny);
      case '-gt': return ints && !(nx > ny);
      case '-ge': return ints && !(nx >= ny);
      case '=': case '==': return x !== y;
      case '!=': return x === y;
    }
  }
  const unary = inner.match(/^(-n|-z)\s+(\S+)$/);
  if (unary) {
    const v = unq(unary[2]);
    return unary[1] === '-n' ? v === '' : v !== '';
  }
  if (/^(?:""|'')$/.test(inner)) return true;
  return false;
}

const alwaysTrue = (cond: string): boolean => /^(?:true|:|\[\s+1\s+-eq\s+1\s+\]|\[\s+-n\s+"?\S"?\s+\])$/.test(cond.trim().replace(/;$/, '').trim());

/** An exit that passes: `exit`, `exit 0`, `return 0`, with or without `;`. */
const EXIT_ZERO = /^(?:exit|return)(?:\s+0+)?$/;
/** Any exit, with any argument: the rest of the script is unreachable after it. */
const EXIT_ANY = /^(?:exit|return)(?:\s+\S+)?$/;
/** Something on the right of `||` that would make a failed gate not fail the hook. */
const FAILS_LOUDLY = /\b(?:exit|return)\s+(?:[1-9]\d*|"?\$\?"?|"?\$\{?[A-Za-z_]\w*\}?"?)(?=[\s;})]|$)|\bfalse\b|\bkill\b|\bexit\s*$|\breturn\s*$/;

export interface Invocation {
  identity: string;
  line: string;
  /** How the invocation is prevented from deciding the hook's exit, if it is. */
  state: 'live' | 'neutered' | 'unreachable' | 'comment';
}

/** Whether an added line INSERTS a passing exit: `exit 0`, `exit 0  # done`, `exit 0;`,
 *  bare `exit`, `[ -n "$X" ] || exit 0`. Statement-level: `echo exit 0` is text. */
export function insertsPassingExit(line: string): boolean {
  if (isComment(line)) return false;
  return split(stripComment(line)).segs.some((s) => EXIT_ZERO.test(s.trim().replace(PREFIX, '')));
}

/** Whether an added line opens a guard that can never be true (`if false; then`). */
export function insertsDeadGuard(line: string): boolean {
  if (isComment(line)) return false;
  const m = stripComment(line).trim().match(/^(?:if|elif)\s+(.+?)\s*(?:;\s*then)?\s*$/);
  return !!m && alwaysFalse(m[1]);
}

/**
 * Every check invocation in a hook script, with the state the script leaves it in:
 * live, neutered in place (`|| true`, `; true`, piped into something without
 * pipefail), unreachable (inside an always-false `if`, or after an unconditional
 * `exit`), or commented out. The comparison the detector makes is over the LIVE
 * set — everything else is one spelling or another of "the hook no longer runs it".
 */
export function invocations(lines: string[]): Invocation[] {
  const out: Invocation[] = [];
  const pipefail = lines.some((l) => /\bpipefail\b/.test(stripComment(l)));
  // one frame per open `if`; a frame is dead when its condition can never hold or
  // it already exited. Top-level reachability is the frame at the bottom.
  const frames: { dead: boolean }[] = [{ dead: false }];
  const dead = (): boolean => frames.some((f) => f.dead);

  for (const raw of lines) {
    if (isComment(raw)) {
      const id = checkIdentity(raw.replace(/^\s*#+\s*/, ''));
      if (id) out.push({ identity: id, line: raw, state: 'comment' });
      continue;
    }
    const stmt = stripComment(raw).trim();
    if (!stmt) continue;

    const ifm = stmt.match(/^(if|elif)\s+(.+?)\s*(?:;\s*then)?\s*$/);
    if (ifm) {
      if (ifm[1] === 'if') frames.push({ dead: alwaysFalse(ifm[2]) });
      else if (frames.length > 1) frames[frames.length - 1].dead = alwaysFalse(ifm[2]);
      continue;
    }
    if (/^else\b/.test(stmt)) {
      if (frames.length > 1) frames[frames.length - 1].dead = false;
      continue;
    }
    if (/^fi\b/.test(stmt)) {
      if (frames.length > 1) frames.pop();
      continue;
    }

    const { segs, ops } = split(stmt);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i].trim().replace(PREFIX, '');
      const id = checkIdentity(seg);
      if (!id) {
        // an unconditional exit ends reachability for the enclosing frame
        if (EXIT_ANY.test(seg) && !dead() && (i === 0 || ops[i - 1] === ';')) frames[frames.length - 1].dead = true;
        continue;
      }
      let state: Invocation['state'] = dead() ? 'unreachable' : 'live';
      if (state === 'live' && i > 0) {
        // `false && gate` never runs it; `true || gate` never runs it
        if (ops[i - 1] === '&&' && alwaysFalse(segs[i - 1])) state = 'unreachable';
        if (ops[i - 1] === '||' && alwaysTrue(segs[i - 1])) state = 'unreachable';
      }
      if (state === 'live' && i < ops.length) {
        const after = segs.slice(i + 1).join(' ');
        if (ops[i] === '||' && !FAILS_LOUDLY.test(after)) state = 'neutered';
        else if (ops[i] === '|' && !pipefail) state = 'neutered';
        else if (ops[i] === ';' && segs.slice(i + 1).some((s) => /^(?:true|:)$/.test(s.trim()) || EXIT_ZERO.test(s.trim()))) state = 'neutered';
      }
      out.push({ identity: id, line: raw, state });
    }
  }
  return out;
}

/** Reasons the after-script runs fewer checks than the before-script. */
export function scriptWeakening(before: string[], after: string[]): Array<{ reason: string; evidence: string }> {
  const live = (inv: Invocation[]) => new Set(inv.filter((i) => i.state === 'live').map((i) => i.identity));
  const bl = live(invocations(before));
  const afterInv = invocations(after);
  const al = live(afterInv);
  const out: Array<{ reason: string; evidence: string }> = [];
  for (const id of bl) {
    if (al.has(id)) continue;
    const trace = afterInv.find((i) => i.identity === id);
    const how =
      trace?.state === 'neutered'
        ? 'neutralised in place (its failure can no longer fail the hook)'
        : trace?.state === 'unreachable'
          ? 'made unreachable (behind an always-false guard or an early exit)'
          : trace?.state === 'comment'
            ? 'commented out'
            : 'removed';
    const evidence = (trace?.line ?? before.find((l) => checkIdentity(stripComment(l).trim().replace(PREFIX, '')) === id) ?? id).trim();
    out.push({ reason: `the check invocation \`${id}\` was ${how}`, evidence });
  }
  return out;
}

// ── CODEOWNERS ─────────────────────────────────────────────────────────────────

export const isCodeowners = (path: string): boolean => /(?:^|\/)CODEOWNERS$/.test(path);

/** The paths whose ownership decides whether the gate can be edited without a human. */
export const GATE_CRITICAL = [
  '/.github/workflows/',
  '/.tamperward.yml',
  '/.github/CODEOWNERS',
  '/CODEOWNERS',
  '/docs/CODEOWNERS',
  '/.husky/',
  '/.claude/settings.json',
  '/.claude/settings.local.json',
  '/.pre-commit-config.yaml',
  '/lefthook.yml',
  '/lefthook.yaml',
];

/** Whether a CODEOWNERS pattern covers a critical path (GitHub's rules, the subset
 *  that matters here: `*`, an exact path, a directory prefix, a `/**` suffix). */
function covers(pattern: string, critical: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  let p = pattern.replace(/\/\*\*$/, '/').replace(/\/\*$/, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p === critical) return true;
  if (p.endsWith('/') && critical.startsWith(p)) return true;
  return critical.startsWith(p + '/');
}

/** The owners the file assigns a critical path — the LAST matching rule wins, as
 *  GitHub reads it — or null when no rule matches. */
function ownersOf(content: string, critical: string): string[] | null {
  let owners: string[] | null = null;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [pattern, ...rest] = t.split(/\s+/);
    if (covers(pattern, critical)) owners = rest.filter((o) => !o.startsWith('#'));
  }
  return owners;
}

/** Reasons the after-CODEOWNERS requires a human on fewer gate-critical paths. */
export function codeownersWeakening(before: string, after: string): string[] {
  const out: string[] = [];
  for (const critical of GATE_CRITICAL) {
    const was = ownersOf(before, critical);
    if (!was || was.length === 0) continue;
    const now = ownersOf(after, critical);
    if (!now) out.push(`the code-owner rule covering ${critical} was removed — the gate's own files no longer require a human reviewer`);
    else if (now.length === 0) out.push(`the code-owner rule covering ${critical} lost its owners — the gate's own files no longer require a human reviewer`);
  }
  return out;
}

// ── lefthook / pre-commit / package.json ───────────────────────────────────────

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseDoc(src: string): Doc | null {
  try {
    const v: unknown = parseYaml(src);
    return isDoc(v) ? v : null;
  } catch {
    return null;
  }
}

export const isLefthook = (path: string): boolean => /(?:^|\/)\.?lefthook(?:-local)?\.(?:ya?ml|toml|json)$/.test(path);
export const isPreCommitConfig = (path: string): boolean => /(?:^|\/)\.pre-commit-config\.ya?ml$/.test(path);
export const isPackageJson = (path: string): boolean => /(?:^|\/)package\.json$/.test(path);

const GATE = /\btamperward\b/;
const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(' ') : v == null ? '' : JSON.stringify(v));

interface LefthookEntry { skip: unknown; sectionSkip: unknown; glob: string; exclude: string; only: string }

/** Every lefthook command/script whose `run` invokes the gate, keyed by section and name. */
function lefthookEntries(doc: Doc): Map<string, LefthookEntry> {
  const out = new Map<string, LefthookEntry>();
  for (const [section, v] of Object.entries(doc)) {
    if (!isDoc(v)) continue;
    for (const group of ['commands', 'scripts']) {
      const g = v[group];
      if (!isDoc(g)) continue;
      for (const [name, cfg] of Object.entries(g)) {
        if (!isDoc(cfg) || !GATE.test(str(cfg.run ?? cfg.runner))) continue;
        out.set(`${section}.${group}.${name}`, {
          skip: cfg.skip, sectionSkip: v.skip, glob: str(cfg.glob), exclude: str(cfg.exclude), only: str(cfg.only),
        });
      }
    }
  }
  return out;
}

export function lefthookWeakening(before: Doc, after: Doc): string[] {
  const out: string[] = [];
  const b = lefthookEntries(before);
  const a = lefthookEntries(after);
  for (const [key, was] of b) {
    const now = a.get(key);
    if (!now) { out.push(`lefthook entry ${key} (the gate) was removed`); continue; }
    if (now.skip === true && was.skip !== true) out.push(`lefthook entry ${key} (the gate) is now \`skip: true\``);
    if (now.sectionSkip === true && was.sectionSkip !== true) out.push(`the lefthook hook carrying ${key} (the gate) is now \`skip: true\``);
    if (now.glob !== was.glob && now.glob) out.push(`lefthook entry ${key} (the gate) gained or changed \`glob\` (${now.glob}) — it no longer runs on every commit`);
    if (now.exclude !== was.exclude && now.exclude) out.push(`lefthook entry ${key} (the gate) gained or changed \`exclude\` (${now.exclude})`);
    if (now.only !== was.only && now.only) out.push(`lefthook entry ${key} (the gate) gained or changed \`only\` (${now.only})`);
  }
  return out;
}

interface PreCommitEntry { stages: string[] | null; exclude: string; files: string }
const COMMIT_STAGES = new Set(['commit', 'pre-commit', 'push', 'pre-push', 'commit-msg', 'pre-merge-commit', 'prepare-commit-msg']);

function preCommitEntries(doc: Doc): Map<string, PreCommitEntry> {
  const out = new Map<string, PreCommitEntry>();
  const repos = Array.isArray(doc.repos) ? doc.repos : [];
  for (const repo of repos) {
    if (!isDoc(repo)) continue;
    const hooks = Array.isArray(repo.hooks) ? repo.hooks : [];
    for (const h of hooks) {
      if (!isDoc(h)) continue;
      if (!GATE.test(`${str(repo.repo)} ${str(h.id)} ${str(h.entry)} ${str(h.name)}`)) continue;
      out.set(`${str(repo.repo)}:${str(h.id)}`, {
        stages: Array.isArray(h.stages) ? h.stages.map(String) : null,
        exclude: str(h.exclude),
        files: str(h.files),
      });
    }
  }
  return out;
}

export function preCommitWeakening(before: Doc, after: Doc): string[] {
  const out: string[] = [];
  const b = preCommitEntries(before);
  const a = preCommitEntries(after);
  for (const [key, was] of b) {
    const now = a.get(key);
    if (!now) { out.push(`pre-commit hook ${key} (the gate) was removed`); continue; }
    const wasStages = was.stages ?? [...COMMIT_STAGES];
    if (now.stages && !now.stages.some((s) => COMMIT_STAGES.has(s)) && wasStages.some((s) => COMMIT_STAGES.has(s))) {
      out.push(`pre-commit hook ${key} (the gate) now runs only at stages [${now.stages.join(', ')}] — no commit or push triggers it`);
    } else if (now.stages && was.stages) {
      const lost = was.stages.filter((s) => COMMIT_STAGES.has(s) && !now.stages!.includes(s));
      if (lost.length) out.push(`pre-commit hook ${key} (the gate) no longer runs at stage(s) ${lost.join(', ')}`);
    }
    if (now.exclude !== was.exclude && now.exclude) out.push(`pre-commit hook ${key} (the gate) gained or changed \`exclude\` (${now.exclude})`);
    if (now.files !== was.files && now.files) out.push(`pre-commit hook ${key} (the gate) gained or changed \`files\` (${now.files})`);
  }
  const topB = str(before.exclude);
  const topA = str(after.exclude);
  if (topA && topA !== topB && b.size > 0) out.push(`a top-level pre-commit \`exclude\` was added or changed (${topA}) — it scopes every hook, the gate included`);
  return out;
}

const INSTALLER = /\b(?:husky|lefthook|simple-git-hooks|pre-commit)\b/;
const INSTALL_SCRIPTS = ['prepare', 'postinstall', 'install', 'preinstall'];

/** package.json: the lifecycle script that INSTALLS the git hooks (`prepare: husky`)
 *  losing its installer. Cheap and exact through the JSON, so it is judged here
 *  even though package.json sits in the config class. */
export function packageJsonWeakening(before: string, after: string): string[] {
  let b: unknown;
  let a: unknown;
  try {
    b = JSON.parse(before);
    a = JSON.parse(after);
  } catch {
    return [];
  }
  if (!isDoc(b) || !isDoc(a)) return [];
  const scripts = (d: Doc): string => {
    const sc = d.scripts;
    return isDoc(sc) ? INSTALL_SCRIPTS.map((k) => str(sc[k])).join(' ') : '';
  };
  const was = scripts(b).match(INSTALLER)?.[0];
  if (!was) return [];
  if (INSTALLER.test(scripts(a))) return [];
  return [`the install script that wires the git hooks (\`${was}\`) was removed from package.json scripts — a fresh checkout installs no hooks`];
}

// ── renames within the hooks class ─────────────────────────────────────────────

const GIT_HOOKS = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update',
  'post-receive', 'post-update', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
]);

/** What a hooks-class path IS to its consumer, or null when the consumer would not
 *  read it there. `lefthook.yml` and `lefthook.yaml` are the same file to lefthook;
 *  `.husky/pre-commit` and `.husky/pre-commit.bak` are not the same file to git. */
export function hookIdentity(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  if (isLefthook(path)) return 'lefthook';
  if (isPreCommitConfig(path)) return 'pre-commit-config';
  if (base === 'CODEOWNERS') return 'codeowners';
  const husky = path.match(/(?:^|\/)\.husky\/([^/]+)$/);
  if (husky && GIT_HOOKS.has(husky[1])) return `husky:${husky[1]}`;
  return null;
}

// ── the command surface ────────────────────────────────────────────────────────

const ownerExec = (mode: string): boolean => (parseInt(mode.slice(-3).padStart(3, '0'), 8) & 0o100) !== 0;
const SYMBOLIC = /^[ugoa]*([-+=])([rwxXst]*)$/;

/**
 * Whether a `chmod` DROPS the owner execute bit. Direction-aware: `+x` and `u+x`
 * add it and are the repair, not the tamper. `chmod 0`, `chmod 00644` (any 1–5
 * octal digits: the last three decide) and `--reference=<file>` (a mode read from
 * elsewhere, unknowable here) count as dropping it.
 */
export function chmodDropsExec(toks: string[]): boolean {
  const at = toks.findIndex((t) => t === 'chmod' || t.endsWith('/chmod'));
  if (at === -1) return false;
  for (const tok of toks.slice(at + 1)) {
    if (/^--reference=/.test(tok)) return true;
    if (/^[0-7]{1,5}$/.test(tok)) {
      if (!ownerExec(tok)) return true;
      continue;
    }
    for (const clause of tok.split(',')) {
      const m = clause.match(SYMBOLIC);
      if (!m) continue;
      const [, op, perms] = m;
      if (op === '-' && /[xX]/.test(perms)) return true;
      if (op === '=' && !/[xX]/.test(perms)) return true;
    }
  }
  return false;
}

const WRAPPERS = /^(?:sudo|command|exec|time|nice|env|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;

/**
 * Whether a shell segment WRITES a protected hook, and how — as opposed to reading
 * it. `cat .husky/pre-commit > /tmp/backup` reads the hook and writes a backup;
 * `cp .husky/pre-commit /tmp/` reads it; `sed -n 1,5p .husky/pre-commit` reads it.
 * Only the hook as a write TARGET — redirect target, cp/install/ln destination,
 * either side of mv, tee/sponge/truncate/rm argument, in-place sed/perl/awk
 * target, dd `of=`, or a `git checkout <rev>`/`git restore --source` that puts
 * an older version back — is tampering.
 */
const REDIRECT_TARGET = /(?:^|\s)\d*>{1,2}\|?\s*(\S+)/g;
const hookPath = (t: string): string => t.replace(/^["']|["']$/g, '').replace(/^\.\//, '');

/**
 * The protected hook a shell segment NAMES — the path a shellWritesHook finding is
 * about: the redirect target first, then the arguments in order (`of=` unwrapped
 * for dd). A command-surface finding used to carry no `file`, and the engine's
 * pin on the guarded rule (src/engine.ts isGuardedFinding) is keyed on the file:
 * under a policy that lowered hook-tampering to warn, `rm .claude/settings.json`
 * from the shell was a warn — and, at the hook, an allow — while the same removal
 * through an Edit was pinned to block.
 */
export function shellHookTarget(seg: string, toks: string[], policy: Policy): string | null {
  for (const m of seg.matchAll(REDIRECT_TARGET)) {
    const t = hookPath(m[1]);
    if (isProtected(t, policy, 'hooks')) return t;
  }
  for (const tok of toks) {
    const t = hookPath(tok.replace(/^of=/, ''));
    if (isProtected(t, policy, 'hooks')) return t;
  }
  return null;
}

export function shellWritesHook(seg: string, toks: string[], policy: Policy): string | null {
  const hook = (t: string): boolean => isProtected(t.replace(/^\.\//, ''), policy, 'hooks');
  for (const m of seg.matchAll(REDIRECT_TARGET)) {
    if (hook(m[1].replace(/^["']|["']$/g, ''))) return 'a redirect empties or rewrites a protected hook';
  }
  let at = 0;
  while (at < toks.length && WRAPPERS.test(toks[at])) at++;
  const cmd = (toks[at] ?? '').replace(/^.*\//, '');
  const args = toks.slice(at + 1);
  const positional = args.filter((a) => a !== '--' && !a.startsWith('-'));
  const last = positional[positional.length - 1] ?? '';
  const anyHook = args.some(hook);
  const inPlace = args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a));
  switch (cmd) {
    case 'rm': case 'unlink': case 'shred':
      return anyHook ? 'rm deletes a protected hook' : null;
    case 'truncate':
      return anyHook ? 'truncate empties a protected hook' : null;
    case 'chmod':
      return anyHook && chmodDropsExec(toks) ? 'chmod removes execute permission from a hook — git will skip it' : null;
    case 'mv':
      return anyHook ? 'mv moves a protected hook out of place or overwrites it' : null;
    case 'cp': case 'install': case 'ln':
      return hook(last) ? `${cmd} replaces a protected hook in place` : null;
    case 'tee': case 'sponge':
      return anyHook ? `${cmd} rewrites a protected hook in place` : null;
    case 'dd':
      return args.some((a) => a.startsWith('of=') && hook(a.slice(3))) ? 'dd rewrites a protected hook in place' : null;
    case 'sed': case 'perl':
      return anyHook && inPlace ? `an in-place ${cmd} rewrites a protected hook` : null;
    case 'awk': case 'gawk':
      return anyHook && args.some((a, i) => (a === '-i' && args[i + 1] === 'inplace') || a === '--in-place' || a === '-i=inplace')
        ? 'an in-place awk rewrites a protected hook'
        : null;
    case 'git': {
      // skip the global options (`-C <dir>`, `-c <k=v>`, `--git-dir=…`) to the subcommand
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (!rest.some(hook)) return null;
      if (sub === 'checkout') {
        // `git checkout <rev> [--] <hook>`: a rev between the subcommand and the path.
        // `git checkout -- <hook>` (from the index) restores the trusted state and passes.
        const dd = rest.indexOf('--');
        const before = dd === -1 ? rest : rest.slice(0, dd);
        const revs = before.filter((p) => !p.startsWith('-') && !hook(p));
        return revs.length > 0 ? 'git checkout <rev> -- <hook> puts an older version of a protected hook back' : null;
      }
      if (sub === 'restore' && rest.some((a) => /^--source(?:=|$)/.test(a) || a === '-s')) {
        return 'git restore --source=<rev> <hook> puts an older version of a protected hook back';
      }
      return null;
    }
    default:
      return null;
  }
}
