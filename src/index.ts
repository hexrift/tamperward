// Public API surface.

export * from './types';
export { parseDiff } from './diff/parse';
export { addedLines, removedLines, isFile, firstAddedMatch } from './diff/select';
export { diffRange, diffStaged, diffWorktree } from './git/build';
export { evaluate, hasBlocking, activeChanges } from './engine';
export { allDetectors } from './detectors';
export { defaultPolicy, isProtected, isIgnored, protectedCategory, matchesAny } from './policy';
export { loadPolicy, parsePolicy } from './policy-load';
export { runCheck } from './cli/check';
export { runHookClaude, runSweepClaude, preToolUseVerdict, stopVerdict } from './cli/hook';
export { changesFromClaudeHook, synthFileChange } from './adapters/claude/changes';
export type { ClaudeHookInput } from './adapters/claude/changes';
export { runAllow } from './cli/allow';
export { fingerprint, fingerprintOf, applyLocalSignoffs, applyOobSignoffs, appendEntry, makeEntry, readLedger } from './signoff';
export type { LedgerEntry } from './signoff';
