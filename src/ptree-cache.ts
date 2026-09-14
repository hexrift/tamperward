// An in-memory cache for protected-tree snapshot entries, held by the persistent
// hook service (src/cli/hook-service.ts) and by nothing else. The in-process hook
// never has one: snapshotProtected without a cache hashes every protected file,
// every time, exactly as before (src/effect.ts, P1-8).
//
// Why a cache can exist at all without reopening P1-8. That finding was that
// mtime, size and mode are the candidate's to set — `touch -r` restores an mtime
// byte-for-byte, and a same-length rewrite keeps the size — so a hash remembered
// against those three is a hash the candidate can keep alive over content it
// changed. This cache is keyed on something the candidate cannot set from user
// space: the inode's CHANGE time. Every write, rename, chmod and utimes — the
// `touch -r` itself — moves ctime to the kernel's clock, and no unprivileged call
// sets it back. The key is therefore (device, inode, size, mode, mtime, ctime),
// all at nanosecond precision, and an entry is reused only when all six match.
//
// The one honest gap is the racy write: a file changed within the same clock
// tick as the hash was taken has the same ctime as the bytes that were hashed.
// git's index has the same problem and the same answer — an entry whose ctime is
// within a margin of the time it was recorded is "racy" and never trusted. The
// margin here is two seconds, wider than any filesystem timestamp granularity in
// use, so a file is served from cache only once it has been stable for longer
// than any clock could blur. A rewrite after that necessarily lands a later
// ctime (kernel clock, monotone under normal administration) and misses.
//
// Two more limits keep the cache advisory rather than authoritative: the whole
// map is dropped on a fixed interval, so a full content verification is never
// more than that far away; and it lives only in the service's memory, never on
// disk, so a same-UID candidate cannot write an entry into it — its only route
// is the filesystem, which is the thing being measured.

import { BigIntStats, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { PEntry } from './effect';

export const RACY_MARGIN_NS = 2_000_000_000n;
const DEFAULT_FULL_REVALIDATE_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 100_000;

interface Cached {
  key: string;
  ctimeNs: bigint;
  recordedAtNs: bigint;
  entry: PEntry;
}

export interface SnapshotCacheOptions {
  /** Wall-clock nanoseconds; injectable so tests can age entries without sleeping. */
  now?: () => bigint;
  racyMarginNs?: bigint;
  /** Drop every entry this often: the full content walk stays the authority. */
  fullRevalidateMs?: number;
  maxEntries?: number;
}

function keyOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mode}:${st.mtimeNs}:${st.ctimeNs}`;
}

export class SnapshotCache {
  readonly stats = { hits: 0, misses: 0 };
  private readonly map = new Map<string, Cached>();
  private readonly now: () => bigint;
  private readonly racyMarginNs: bigint;
  private readonly fullRevalidateNs: bigint;
  private readonly maxEntries: number;
  private lastFullNs: bigint;

  constructor(opts: SnapshotCacheOptions = {}) {
    this.now = opts.now ?? ((): bigint => BigInt(Date.now()) * 1_000_000n);
    this.racyMarginNs = opts.racyMarginNs ?? RACY_MARGIN_NS;
    this.fullRevalidateNs = BigInt(opts.fullRevalidateMs ?? DEFAULT_FULL_REVALIDATE_MS) * 1_000_000n;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.lastFullNs = this.now();
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.lastFullNs = this.now();
  }

  /** Called once at the top of every snapshot walk: the periodic full re-hash. */
  beginSnapshot(): void {
    if (this.now() - this.lastFullNs >= this.fullRevalidateNs) this.clear();
  }

  /** A path the caller has reason to distrust (an fs event, a sanctioned edit):
   *  its entry is forgotten so the next walk hashes it whatever its stat says. */
  markDirty(cwd: string, rel: string): void {
    this.map.delete(join(cwd, rel));
  }

  /**
   * The snapshot entry for `rel`, from the cache when the six-field stat key
   * matches AND the entry was recorded after the file had been stable for the
   * racy margin; from `compute` otherwise. Only a regular file is ever cached:
   * a link, a FIFO, a device or anything the lstat refuses is computed every
   * time, the way the in-process path treats them.
   */
  entry(cwd: string, rel: string, compute: () => PEntry): PEntry {
    const abs = join(cwd, rel);
    let st: BigIntStats;
    try {
      st = lstatSync(abs, { bigint: true });
    } catch {
      this.map.delete(abs);
      this.stats.misses++;
      return compute();
    }
    if (!st.isFile()) {
      this.map.delete(abs);
      this.stats.misses++;
      return compute();
    }
    const key = keyOf(st);
    const hit = this.map.get(abs);
    if (hit && hit.key === key && hit.recordedAtNs - hit.ctimeNs >= this.racyMarginNs) {
      this.stats.hits++;
      return hit.entry;
    }
    this.stats.misses++;
    const recordedAtNs = this.now();
    const entry = compute();
    // The stat must still describe the bytes that were hashed: a write that
    // landed between the lstat and the read is caught by the second lstat, and
    // the entry is simply not remembered.
    let after: BigIntStats;
    try {
      after = lstatSync(abs, { bigint: true });
    } catch {
      this.map.delete(abs);
      return entry;
    }
    if (!after.isFile() || keyOf(after) !== key) {
      this.map.delete(abs);
      return entry;
    }
    if (this.map.size >= this.maxEntries) this.clear();
    this.map.set(abs, { key, ctimeNs: st.ctimeNs, recordedAtNs, entry });
    return entry;
  }
}
