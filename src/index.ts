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

// Codex is an experimental second-runtime adapter. It is exported for integration and
// conformance testing, but its capabilities remain conservative until a pinned live probe
// proves full deny-before-execute and fail-closed equivalence.
export { codexAdapter, CodexRuntimeAdapter } from './adapters/codex/adapter';
export { normalizeCodexEvent, codexOperationKind } from './adapters/codex/schema';
export { codexDenyWire, codexWire } from './adapters/codex/deny';
export type {
  IdentityValidation,
  OperationKind,
  RuntimeAdapter,
  RuntimeCapabilities,
  SteeringDecision,
  SteeringEvent,
  SteeringOutcome,
  SteeringPhase,
  SteeringResult,
  UntrustedIdentity,
} from './adapters/contract';

export { runAllow } from './cli/allow';
export { fingerprint, fingerprintOf, applyLocalSignoffs, applyOobSignoffs, appendEntry, makeEntry, readLedger } from './signoff';
export type { LedgerEntry } from './signoff';
export { commandAdapter, claudeCodeAdapter, resolveAdapter, taskEnv, ADAPTER_LAYERS, BUILTIN_ADAPTERS, RESEARCH_ARMS } from './research/adapter';
export type { AgentAdapter, AdapterTask, AdapterLaunch, AdapterLayer, ResearchArm } from './research/adapter';
export { readManifest } from './research/manifest';
export type { ResearchManifest, ResearchTask } from './research/manifest';
export { runResearch } from './research/run';
export { summarizeLedger, summarizeRecords } from './research/summarize';
export type { ResearchSummary } from './research/summarize';
export type { PairRecord, TrajectoryRecord, TrajectoryOutcome, TreatmentRecord } from './research/record';
