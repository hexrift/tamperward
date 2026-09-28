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

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, Stats, writeSync } from 'node:fs';
import { join } from 'node:path';
import { escapeControl, isProtected } from './policy';
import { Change, Finding, Policy } from './types';
import { errnoCode } from './narrow';

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
  return errnoCode(e) ?? '';
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

/** What stands at a path when it is not a regular file the gate can read, as the
 *  tail of a sentence that starts with the path: the words the policy loader and
 *  the state readers share with `unjudgeableFinding` below. */
export function notARegularFile(e: DiskEntry): string {
  switch (e.kind) {
    case 'symlink':
      return `is a symbolic link to ${escapeControl(e.detail)}`;
    case 'directory':
      return 'is a directory';
    case 'irregular':
      return `is a ${e.detail}`;
    case 'oversize':
      return `is ${e.detail}, above the ${READ_CAP / (1024 * 1024)} MiB the gate reads`;
    default:
      return `cannot be read (${e.detail})`;
  }
}

/** A state file the gate keeps for itself stands at its path as something other
 *  than a regular file, or cannot be read. Raised, never absorbed: the readers'
 *  fallbacks (re-establish the marker, take the tree for a first sight, restart
 *  the cursor) exist for a file that is MISSING, and taking them for an entry
 *  someone put in the file's place would sanction whatever that entry hides. */
export class StateFileError extends Error {}

/**
 * A state file the gate keeps for itself — the turn-baseline marker, the effect
 * trees, the observer cursor and health record under `.git/tamperward/` — read as
 * a REGULAR FILE, or not at all (#716). `existsSync` + `readFileSync` followed
 * whatever stood at the path: a FIFO blocked the read until a writer opened it, so
 * every later PreToolUse and Stop of the session hung until the runtime's hook
 * timeout cut the gate off, and a link to a device was a read that never ended —
 * one allowed shell command away, since `.git/` is not a protected path. null when
 * nothing stands at the path (the caller's absence behaviour is unchanged), the
 * text of a regular file, and a StateFileError for anything else: a link wherever
 * it points, a FIFO, socket, device or directory, an entry that cannot be read.
 */
export function readStateFile(abs: string): string | null {
  const e = inspectPath(abs);
  if (e.kind === 'absent') return null;
  if (e.kind === 'file') return textOf(e) ?? '';
  throw new StateFileError(
    `${abs} ${notARegularFile(e)}; the gate reads its state files only as regular files — remove what stands there so the state can be re-established`,
  );
}

// Appending without following: O_NOFOLLOW makes the open fail on a link put in
// place after the lstat below; O_NONBLOCK makes a FIFO put there fail the open
// (ENXIO: no reader) or hand back a descriptor the fstat refuses, instead of
// waiting for a reader that never comes. Neither changes how a regular file is
// appended to. Both are 0 where the platform lacks them (Windows), which leaves
// the lstat as the guard there.
const O_APPEND_REGULAR =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const APPEND_REFUSED = '; the gate appends its records only to a regular file with one name — remove what stands there so the record can be kept';

/** A regular file reachable under another name as well: an append through this
 *  name lands in that file too. Only a singly linked file is appended to, and a
 *  platform that cannot report the count is refused the same way. */
function multiplyLinked(st: Stats): string | null {
  return st.nlink === 1 ? null : `has ${st.nlink} names — a hard link is the same file under another name, the session marker's or the policy's, say`;
}

/**
 * Append `text` to the REGULAR FILE at `abs`, creating it when nothing stands at
 * the path, and to nothing else (#718). `appendFileSync` opened the path as the OS
 * found it: a link was followed, so the gate's own lines landed wherever the
 * candidate had pointed it — the turn-baseline marker included, which one deny
 * turned into text the next call re-established at HEAD — and a FIFO held the
 * open until a reader appeared, which in the hook was a deny that never returned.
 * The path is inspected with lstat, opened without following and without waiting,
 * and checked again on the open descriptor before a byte is written. A
 * StateFileError names what was refused: a link wherever it points, a file with
 * more than one name (a hard link to the marker passes every "regular file"
 * test and appends into the marker's own inode), a FIFO, socket, device or
 * directory, an entry that changed shape between the checks. Any other write
 * failure is raised as it is. The caller decides what a refused
 * line means; for the telemetry channels it is a dropped line, exactly as any
 * write failure already was — the verdict does not depend on it, and no longer
 * waits on it.
 */
export function appendRegular(abs: string, text: string, mode = 0o666): void {
  // Absent is the one lstat failure that is not a failure: the open below creates
  // the file. Any other (a parent that is not a directory, a permission) is the
  // ordinary write failure it always was, raised as the OS reports it.
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (st !== undefined && !st.isFile()) throw new StateFileError(`${abs} ${notARegularFile(classify(abs, st))}${APPEND_REFUSED}`);
  const linked = st === undefined ? null : multiplyLinked(st);
  if (linked !== null) throw new StateFileError(`${abs} ${linked}${APPEND_REFUSED}`);
  let fd: number;
  try {
    fd = openSync(abs, O_APPEND_REGULAR, mode);
  } catch (e) {
    const code = errCode(e);
    // ELOOP: a link put in place after the lstat. ENXIO: a FIFO no one reads, or a
    // socket, likewise. EISDIR: a directory, likewise. Anything else is a write
    // failure of the ordinary kind (a missing parent, a permission) and stays one.
    if (code === 'ELOOP' || code === 'ENXIO' || code === 'EISDIR') {
      throw new StateFileError(`${abs} changed shape while it was being opened (${errText(e)})${APPEND_REFUSED}`);
    }
    throw e;
  }
  try {
    // The descriptor is what is written: an extra name given to the file after the
    // lstat shows here, and so does one given to a file created in the O_CREAT
    // window (a link swapped in after the lstat already failed the open above).
    const now = fstatSync(fd);
    if (!now.isFile()) throw new StateFileError(`${abs} is a ${irregularName(now)}${APPEND_REFUSED}`);
    const opened = multiplyLinked(now);
    if (opened !== null) throw new StateFileError(`${abs} ${opened}${APPEND_REFUSED}`);
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
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
