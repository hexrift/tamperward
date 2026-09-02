// Every read of a repository path the gate did not write itself goes through here.
//
// A path in a git view is a NAME the agent chose; what stands at it on disk is
// the agent's too. `readFileSync` follows a symbolic link and reads until EOF,
// so a protected path linked to `/dev/zero` (or to a FIFO nobody writes) held
// the PreToolUse hook and the Stop sweep for as long as the device kept
// answering — every disk read in the untracked, ignored and worktree views
// followed it, and the verdict never came. (Pass 3c, P0-1.)
//
// The stance here is git's own: a regular file is its bytes, a symbolic link is
// a blob holding its target text, and nothing else is content. The link is
// never followed — the target is read with readlink, and a regular file is
// opened O_NOFOLLOW so a link swapped in between the lstat and the open fails
// the open instead of being read through — and a regular file is read up to a
// cap and not one byte past it. What cannot be read that way (a link, a FIFO,
// a socket, a device, a directory where a file is expected, a file above the
// cap, a read error) is not judged by content: the caller reports it BY NAME
// as `hidden-drift`, fail closed, the way the effect layer already treated a
// file it could not read.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, Stats } from 'node:fs';
import { join } from 'node:path';
import { escapeControl, isProtected } from './policy';
import { Change, Finding, Policy } from './types';

/** The most a protected file is read for judgement. A larger one is judged by name. */
export const READ_CAP = 64 * 1024 * 1024;

export type DiskKind = 'file' | 'symlink' | 'directory' | 'irregular' | 'oversize' | 'unreadable' | 'absent';

export interface DiskEntry {
  kind: DiskKind;
  /** What git would record for the path — the bytes of a regular file, the target
   *  text of a symbolic link — and null for everything else. */
  content: Buffer | null;
  mode: number;
  size: number;
  mtimeMs: number;
  /** The link target, the irregular file type, the size past the cap, or the read error. */
  detail: string;
}

const NO_META = { mode: 0, size: 0, mtimeMs: 0 };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string {
  return String((e as { code?: unknown })?.code ?? '');
}

function irregularName(st: Stats): string {
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isCharacterDevice()) return 'character device';
  if (st.isBlockDevice()) return 'block device';
  return 'unknown file type';
}

function meta(st: Stats): { mode: number; size: number; mtimeMs: number } {
  return { mode: st.mode, size: st.size, mtimeMs: st.mtimeMs };
}

// O_NOFOLLOW makes the open fail on a link swapped in after the lstat; O_NONBLOCK
// makes it return at once on a FIFO swapped in, instead of waiting for a writer.
// Both are 0 where the platform lacks them (Windows), which leaves the lstat as
// the guard there.
const O_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** A regular file, read through a descriptor that was checked AFTER opening, so
 *  the bytes are those of the file the descriptor refers to whatever the path
 *  has become since. Reads exactly the size fstat reports, never past the cap. */
function readRegular(abs: string, st: Stats): DiskEntry {
  let fd: number;
  try {
    fd = openSync(abs, O_READ);
  } catch (e) {
    // ELOOP: the path turned into a link between the lstat and the open.
    if (errCode(e) === 'ELOOP') return inspectOnce(abs);
    return { kind: 'unreadable', content: null, ...meta(st), detail: errText(e) };
  }
  try {
    const now = fstatSync(fd);
    if (!now.isFile()) return { kind: 'irregular', content: null, ...meta(now), detail: irregularName(now) };
    if (now.size > READ_CAP) return { kind: 'oversize', content: null, ...meta(now), detail: `${now.size} bytes` };
    const buf = Buffer.allocUnsafe(now.size);
    let off = 0;
    while (off < now.size) {
      const n = readSync(fd, buf, off, now.size - off, off);
      if (n === 0) break; // truncated under us: what is there is what there is
      off += n;
    }
    return { kind: 'file', content: off === now.size ? buf : buf.subarray(0, off), mode: now.mode, size: off, mtimeMs: now.mtimeMs, detail: '' };
  } catch (e) {
    return { kind: 'unreadable', content: null, ...meta(st), detail: errText(e) };
  } finally {
    closeSync(fd);
  }
}

function classify(abs: string, st: Stats): DiskEntry {
  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(abs);
      return { kind: 'symlink', content: Buffer.from(target, 'utf8'), ...meta(st), detail: target };
    } catch (e) {
      return { kind: 'unreadable', content: null, ...meta(st), detail: errText(e) };
    }
  }
  if (st.isDirectory()) return { kind: 'directory', content: null, ...meta(st), detail: 'directory' };
  if (!st.isFile()) return { kind: 'irregular', content: null, ...meta(st), detail: irregularName(st) };
  if (st.size > READ_CAP) return { kind: 'oversize', content: null, ...meta(st), detail: `${st.size} bytes` };
  return readRegular(abs, st);
}

/** The lstat-only classification: no open, no retry. The fallback for a path that
 *  changed shape under the regular read. */
function inspectOnce(abs: string): DiskEntry {
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent', content: null, ...NO_META, detail: '' };
    return { kind: 'unreadable', content: null, ...NO_META, detail: errText(e) };
  }
  if (st.isSymbolicLink() || !st.isFile()) return classify(abs, st);
  return { kind: 'unreadable', content: null, ...meta(st), detail: 'the path changed shape while it was being read' };
}

/** What stands at `abs`, without following a link and without reading past the cap. */
export function inspectPath(abs: string): DiskEntry {
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent', content: null, ...NO_META, detail: '' };
    return { kind: 'unreadable', content: null, ...NO_META, detail: errText(e) };
  }
  return classify(abs, st);
}

/** `inspectPath` for a repository-relative path. */
export function inspectRel(cwd: string, rel: string): DiskEntry {
  return inspectPath(join(cwd, rel));
}

/** What stands at the END of the link chain from `abs` — for a caller that must
 *  see the content a tool is about to edit, where the path may honestly be a
 *  link (a dotfiles-managed settings file). The chain is resolved by name; the
 *  final target is then read under the same guards as any other path, so a link
 *  to a device is a device here, not a read that never returns. */
export function inspectResolved(abs: string): DiskEntry {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent', content: null, ...NO_META, detail: '' };
    return { kind: 'unreadable', content: null, ...NO_META, detail: errText(e) };
  }
  return inspectPath(real);
}

/** The entry's content as text, or null when it has none. */
export function textOf(e: DiskEntry): string | null {
  return e.content == null ? null : e.content.toString('utf8');
}

function describe(e: DiskEntry, shown: string): string {
  switch (e.kind) {
    case 'symlink':
      return `Protected path ${shown} is a symbolic link to ${escapeControl(e.detail)}. The gate never follows a link, so what the runner will read there cannot be judged.`;
    case 'directory':
      return `Protected path ${shown} is a directory where a file is expected, so it cannot be judged.`;
    case 'irregular':
      return `Protected path ${shown} is a ${e.detail}, not a regular file, so it cannot be read to judge it.`;
    case 'oversize':
      return `Protected file ${shown} is ${e.detail}, above the ${READ_CAP / (1024 * 1024)} MiB the gate reads, so it is judged by name.`;
    default:
      return `Protected file ${shown} cannot be read to judge it (${e.detail}).`;
  }
}

/**
 * The finding for a protected path the gate cannot judge by content, or null
 * when the path is a readable regular file or is absent. `hidden-drift`: not a
 * policy rule, never disabled or excluded, blocks by name — the stance the
 * effect layer already took on a file it could not read.
 */
export function unjudgeableFinding(cwd: string, rel: string): Finding | null {
  const e = inspectRel(cwd, rel);
  if (e.kind === 'file' || e.kind === 'absent') return null;
  const shown = escapeControl(rel);
  return {
    rule: 'hidden-drift',
    severity: 'block',
    file: rel,
    message: describe(e, shown),
    evidence: `${shown}: ${e.kind}${e.detail ? ` (${escapeControl(e.detail)})` : ''}`,
    remediation:
      'Put a regular file the gate can read at the path — no symbolic link, FIFO, socket or device, and under 64 MiB — through a tool call the gate can see, or remove it.',
    signoff: { required: true, command: `tamperward allow hidden-drift --file ${shown} --reason "..."` },
  };
}

/** `unjudgeableFinding` over every protected path a view says is present. */
export function unjudgeableProtected(cwd: string, policy: Policy, changes: Change[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (c.kind !== 'file' || c.op === 'delete' || seen.has(c.path)) continue;
    seen.add(c.path);
    if (!isProtected(c.path, policy)) continue;
    const f = unjudgeableFinding(cwd, c.path);
    if (f) out.push(f);
  }
  return out;
}
