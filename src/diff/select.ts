// Small selectors detectors lean on, so each detector doesn't re-walk hunks by hand.

import { Change, DiffLine, FileChange } from '../types';

export function isFile(c: Change): c is FileChange {
  return c.kind === 'file';
}

export function addedLines(c: Change): DiffLine[] {
  if (c.kind !== 'file') return [];
  return c.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add'));
}

export function removedLines(c: Change): DiffLine[] {
  if (c.kind !== 'file') return [];
  return c.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'del'));
}

/** First added line whose content matches — handy for line-accurate findings. */
export function firstAddedMatch(c: Change, re: RegExp): DiffLine | undefined {
  return addedLines(c).find((l) => re.test(l.content));
}
