// The shape of the wiring `init` writes — shared by init (which writes it) and
// hook-tampering (which judges an edit to it against that shape).
//
// The comparators used to ask whether a token was PRESENT: a `command` string
// carrying `tamperward … hook claude`, a hook line carrying `tamperward check`.
// Presence is not what the runtime does. `npx --yes tamperward@2.5.0 hook claude
// | head -c0` is present and runs nothing the runtime can read; `"async": true`
// beside a perfect command means its verdict is never awaited; a pin of `0.1.0`
// is present, live, and a gate with every bypass since fixed. So the wiring init
// writes is judged by CANONICAL SHAPE — exactly what init would write, modulo a
// pin that only ever goes up — and the liveness model is kept only as the
// fallback for wiring somebody wrote by hand.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gate resolves ITSELF from the registry at gate time, so it is pinned to
// the version that wrote the wiring: an unpinned `npx --yes tamperward` is a
// floating dependency in the one component whose job is integrity.
// (P2-15, external review.)
function shippedVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../package.json', '../../package.json', '../../../package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'tamperward' && pkg.version) return pkg.version;
      } catch {
        /* keep looking */
      }
    }
  } catch {
    /* fall through */
  }
  return 'latest'; // unknown: prefer a working gate over a broken pin
}
export const TW_VERSION = shippedVersion();

// The tools whose calls the PreToolUse gate must see. NotebookEdit was added in
// 1.13; an install wired before that has a matcher without it (see init's repair).
export const PRE_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const PRE_MATCHER = PRE_TOOLS.join('|');
export const MARKER = '# tamperward: block agent shortcuts before they land';

// PINNED, like the workflow (see init.ts for the history).
export const HOOK_CMD = `npx --yes tamperward@${TW_VERSION} hook claude`;
export const SWEEP_CMD = `npx --yes tamperward@${TW_VERSION} sweep claude`;
export const PRECOMMIT_CMD = `npx --yes tamperward@${TW_VERSION} check --staged`;

/** The exact `npx --yes tamperward[@v] <ours>` form init writes; group 1 is the
 *  pin, group 2 the subcommand. */
export const OURS = /^\s*npx\s+(?:--yes|-y)\s+tamperward(?:@(\S+))?\s+(hook claude|sweep claude|check --staged)\s*$/;

/** A plain release version: what init pins. Tags (`latest`), ranges, git URLs,
 *  pre-releases and leading zeros (`02.5.0`, `2.5.00000000000000000001` — npm
 *  resolves them loosely, to a version this comparator cannot name) are not pins
 *  the gate can reason about, so they are not accepted. */
export const PLAIN_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** -1 / 0 / 1 over two plain versions; null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  if (!PLAIN_SEMVER.test(a) || !PLAIN_SEMVER.test(b)) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Whether pin `now` is at least pin `floor` — a downgrade of the gate is a
 *  weakening, whatever else the edit did. An unpinned `now` is not "at least". */
export function pinNotBelow(now: string | null | undefined, floor: string): boolean {
  if (!now) return false;
  const c = compareVersions(now, floor);
  return c !== null && c >= 0;
}

/** The pre-commit script init creates from nothing: shebang, marker, the pinned
 *  staged check. Group 1 is the pin ('' when unpinned, as init wrote before 1.14.7). */
const INIT_SCRIPT = /^#!\/bin\/sh\n# tamperward: block agent shortcuts before they land\nnpx --yes tamperward(?:@(\S+))? check --staged\n?$/;

/** The pin a script carries when it is byte-equal to what init writes (modulo the
 *  pin): a version, '' for unpinned, or null when the script is not init's shape. */
export function initScriptPin(src: string): string | null {
  const m = src.match(INIT_SCRIPT);
  return m ? (m[1] ?? '') : null;
}

/** The user's home directory as the shell would expand `~`: `HOME` (or
 *  `USERPROFILE`) from the environment, else the OS's answer. Forward slashes. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const h = (env.HOME ?? env.USERPROFILE ?? '').trim() || homedir();
  return h.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '');
}

/** The directory the runtime keeps the user settings in: `CLAUDE_CONFIG_DIR` when
 *  the environment sets it (the documented relocation), else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').trim().replace(/\\/g, '/').replace(/(?<=.)\/+$/, '');
  return dir || `${homeDir(env)}/.claude`;
}

/** Claude Code settings, in every location the runtime reads hooks from: the
 *  project file, its local override, the user file (`~/.claude/settings.json`, or
 *  `$CLAUDE_CONFIG_DIR/settings.json` when the environment relocates it) and
 *  managed settings. The tool-call layer sees absolute paths for the last two,
 *  and none of them need be in `protected.hooks` to be the enforcement. A
 *  `.claude/settings*.json` at ANY depth is settings-shaped: the runtime reads
 *  the one at the root of whatever directory it was started in, and the gate
 *  cannot know which directory that is. Backslashes are separators. */
export const CLAUDE_SETTINGS = /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|managed-settings\.json)$/;
export function isClaudeSettings(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = path.replace(/\\/g, '/');
  if (CLAUDE_SETTINGS.test(p)) return true;
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').trim().replace(/\\/g, '/').replace(/(?<=.)\/+$/, '');
  return dir !== '' && (p === `${dir}/settings.json` || p === `${dir}/settings.local.json`);
}

/** The path with every symlink in it resolved — the deepest ancestor that exists
 *  through `realpath`, the rest appended — so that `/tmp/cfg/settings.json` with
 *  `/tmp/cfg -> ~/.claude`, or `/tmp/xlink/.claude/settings.json` with `/tmp/xlink
 *  -> <repo>`, is judged as the file it writes. The input when nothing resolves. */
export function canonicalPath(path: string): string {
  const tail: string[] = [];
  let cur = path;
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync(cur).replace(/\\/g, '/');
      return tail.length ? posix.join(real, ...tail.reverse()) : real;
    } catch {
      /* not there: climb */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.push(basename(cur));
    cur = parent;
  }
  return path;
}

/** Whether a path names a Claude settings file — as spelled, or once its symlinks
 *  are resolved (an absolute path only: a relative one is read against the repo). */
export function resolvesToClaudeSettings(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isClaudeSettings(path, env)) return true;
  return isAbsolute(path) && isClaudeSettings(canonicalPath(path), env);
}
