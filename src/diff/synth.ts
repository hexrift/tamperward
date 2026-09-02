// Hunks for a change git never produced: a file that is new to the tree (untracked)
// or one git was told to stop looking at. A Change with `hunks: []` reaches the
// hunk-based rules (test-skip, ci-tampering, the added-line half of hook-tampering)
// as an EMPTY edit — full content in `after`, nothing in the hunks they read — so an
// untracked conftest.py carrying `collect_ignore` was invisible to test-skip even
// once the untracked view handed it over. An add's hunk is fully determined by its
// content; no git process is needed to build it.

import { Hunk } from '../types';

function linesOf(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** The single hunk `git diff` would emit for a brand-new file with `content`. */
export function addHunks(content: string): Hunk[] {
  const lines = linesOf(content);
  if (lines.length === 0) return [];
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((l, i) => ({ type: 'add', content: l, oldLine: null, newLine: i + 1 })),
    },
  ];
}

/** The single hunk `git diff` would emit for deleting a file that held `content`. */
export function deleteHunks(content: string): Hunk[] {
  const lines = linesOf(content);
  if (lines.length === 0) return [];
  return [
    {
      oldStart: 1,
      oldLines: lines.length,
      newStart: 0,
      newLines: 0,
      lines: lines.map((l, i) => ({ type: 'del', content: l, oldLine: i + 1, newLine: null })),
    },
  ];
}
