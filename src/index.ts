// Public API surface.

export * from './types';
export { parseDiff } from './diff/parse';
export { addedLines, removedLines, isFile, firstAddedMatch } from './diff/select';
export { diffRange, diffStaged, diffWorktree } from './git/build';
export { evaluate, hasBlocking } from './engine';
export { allDetectors } from './detectors';
export { defaultPolicy, isProtected, protectedCategory, matchesAny } from './policy';
