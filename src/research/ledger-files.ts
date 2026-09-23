// The one reader of a ledger's pairs/ directory (#663). `research summarize`
// and `research bundle` both go through it, so the guarantee is made once:
// only a regular file placed directly in <ledger>/pairs is ever read. The
// runner keeps agent workspaces below the same ledger directory and the
// research process runs as the same user, so a symlink named
// pairs/<anything>.json could otherwise point into a workspace or outside the
// ledger and hand its bytes to a bundle that promises never to carry them.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorMessage } from '../narrow';
import { ResearchError } from './adapter';

export interface LedgerPairFile {
  /** The file name inside pairs/ (for example `honest--1.json`). */
  name: string;
  /** The path it was read from. */
  path: string;
  bytes: Buffer;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function kindOf(st: Stats): string {
  if (st.isSymbolicLink()) return 'a symlink';
  if (st.isDirectory()) return 'a directory';
  if (st.isFIFO()) return 'a FIFO';
  if (st.isSocket()) return 'a socket';
  if (st.isCharacterDevice() || st.isBlockDevice()) return 'a device';
  return 'not a regular file';
}

/** Open a listed entry without following a link and read it whole, proving the
 *  file that was opened is the regular file that was listed. */
function readRegularFile(path: string, realPairsDir: string, name: string): Buffer {
  const listed = lstatOrNull(path);
  if (listed === null) throw new ResearchError(`ledger record ${path} vanished while the ledger was being read`);
  if (!listed.isFile()) {
    throw new ResearchError(`ledger record ${path} is ${kindOf(listed)}; only a regular file placed directly in pairs/ is read`);
  }
  // Defence in depth on the path itself: the entry must resolve to this very
  // name directly under the resolved pairs directory, nowhere else.
  const real = realpathSync.native(path);
  if (real !== join(realPairsDir, name)) {
    throw new ResearchError(`ledger record ${path} resolves outside the pairs directory (${real}); refusing to read it`);
  }
  // O_NOFOLLOW refuses a link that appeared between the lstat and the open on the
  // platforms that have it; the fstat afterwards proves the opened file is the
  // listed one either way.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    throw new ResearchError(`cannot open ledger record ${path}: ${errorMessage(e)}`);
  }
  try {
    const opened = fstatSync(fd);
    const sameInode = process.platform === 'win32' || (opened.dev === listed.dev && opened.ino === listed.ino);
    if (!opened.isFile() || !sameInode) {
      throw new ResearchError(`ledger record ${path} changed between listing and reading; refusing to read it`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read every `*.json` entry physically present in <ledger>/pairs, in name order.
 *  A pairs/ directory that is a symlink, and any entry that is not a regular
 *  file placed directly in it, is refused rather than skipped. */
export function readPairFiles(ledger: string): LedgerPairFile[] {
  const root = resolve(ledger);
  const pairsDir = join(root, 'pairs');
  const dirStat = lstatOrNull(pairsDir);
  if (dirStat !== null && dirStat.isSymbolicLink()) {
    throw new ResearchError(`ledger pairs directory ${pairsDir} is a symlink; only a real directory is read`);
  }
  if (dirStat === null || !dirStat.isDirectory()) throw new ResearchError(`ledger ${root} has no pairs directory`);
  const realPairsDir = realpathSync.native(pairsDir);
  let names: string[];
  try {
    names = readdirSync(pairsDir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    throw new ResearchError(`cannot read ledger ${pairsDir}: ${errorMessage(e)}`);
  }
  return names.map((name) => {
    const path = join(pairsDir, name);
    return { name, path, bytes: readRegularFile(path, realPairsDir, name) };
  });
}
