// The AgentAdapter contract (#391): how an agent runtime plugs into
// `tamperward research` without learning the harness internals.
//
// An adapter answers exactly two questions for one trajectory:
//   1. what process runs the agent in the fresh workspace (`launch`), and
//   2. what it needs done to that workspace before the GATED arm starts
//      (`prepareGated`, optional) — e.g. wiring in-loop hooks.
//
// Everything else — the fresh clone, the trusted base, the `tamperward run`
// envelope around the gated arm, the neutral post-agent outcome observation
// (verify + check against the base) and the ledger record — is owned by the
// runner (src/research/run.ts), identically for every adapter. An adapter can
// therefore never adjudicate itself, and TamperWard's own findings are always
// recorded separately from the outcome truth.
//
// The `layers` an adapter declares say which of TamperWard's controls are LIVE
// in its gated arm. The envelope is always live (the runner supplies it); the
// in-loop PreToolUse deny and the Stop sweep exist only where a runtime has a
// hook contract for them (Claude Code today). An adapter without them simply
// gets the effect-layer view — the record says which layers were live, so a
// comparison across runtimes never silently compares different treatments.

import { isAbsolute, resolve } from 'node:path';
import { runInit } from '../cli/init';

export const ADAPTER_LAYERS = ['envelope', 'pre-tool-use', 'stop-sweep'] as const;
export type AdapterLayer = (typeof ADAPTER_LAYERS)[number];

export const RESEARCH_ARMS = ['ungated', 'gated'] as const;
export type ResearchArm = (typeof RESEARCH_ARMS)[number];

export const BUILTIN_ADAPTERS = ['claude-code', 'command'] as const;
export type BuiltinAdapterName = (typeof BUILTIN_ADAPTERS)[number];

/** One trajectory's inputs, as the adapter sees them. */
export interface AdapterTask {
  /** The task id from the manifest. */
  id: string;
  /** The task prompt, verbatim from the manifest. */
  prompt: string;
  /** The fresh workspace (a clone at the trusted base). The agent works here. */
  cwd: string;
  /** The trusted base commit SHA the trajectory starts from. */
  base: string;
  arm: ResearchArm;
  /** The model identifier pinned for this run, when the operator gave one. */
  model?: string;
}

/** The process an adapter asks the runner to launch for one trajectory. */
export interface AdapterLaunch {
  argv: string[];
  /** Extra environment for the agent process, merged over the runner's. */
  env: Record<string, string>;
}

export interface AgentAdapter {
  name: string;
  /** Which TamperWard layers are live in this adapter's gated arm. */
  layers: readonly AdapterLayer[];
  /** Prepare the fresh workspace for the gated arm (wire hooks, settings…).
   *  Anything it writes is committed by the runner BEFORE the trusted base is
   *  resolved, so the treatment is part of the base, never agent work. */
  prepareGated?(task: AdapterTask): void;
  /** The process that runs the agent for this trajectory. */
  launch(task: AdapterTask): AdapterLaunch;
}

/** A research-workflow failure that is the operator's to fix: one line on
 *  stderr at exit 2, never a stack trace. */
export class ResearchError extends Error {}

/** The environment every adapter's agent receives, so a runtime that cannot
 *  take the task on its argv can still read it. */
export function taskEnv(task: AdapterTask): Record<string, string> {
  return {
    TAMPERWARD_RESEARCH_TASK: task.id,
    TAMPERWARD_RESEARCH_PROMPT: task.prompt,
    TAMPERWARD_RESEARCH_ARM: task.arm,
    TAMPERWARD_RESEARCH_BASE: task.base,
    TAMPERWARD_RESEARCH_CWD: task.cwd,
    ...(task.model !== undefined ? { TAMPERWARD_RESEARCH_MODEL: task.model } : {}),
  };
}

const PLACEHOLDERS: Record<string, (task: AdapterTask) => string> = {
  '{prompt}': (t) => t.prompt,
  '{task}': (t) => t.id,
  '{cwd}': (t) => t.cwd,
  '{base}': (t) => t.base,
  '{arm}': (t) => t.arm,
  '{model}': (t) => t.model ?? '',
};

/**
 * The generic adapter: any argv (a relative path with a slash in argv[0] is
 * anchored to the operator's cwd). `{prompt}`, `{task}`, `{cwd}`, `{base}`,
 * `{arm}` and `{model}` are substituted verbatim in each argument, and the
 * same values travel as TAMPERWARD_RESEARCH_* environment variables. Only
 * the effect layer is live in its gated arm: the envelope wraps the command,
 * the tree it leaves is re-adjudicated, and nothing steers it mid-turn.
 */
export function normalizeCommandArgv(argv: string[], cwd: string = process.cwd()): string[] {
  if (argv.length === 0) {
    throw new ResearchError('the command adapter needs an agent command after "--"');
  }
  // The agent runs inside the fresh workspace, so `./agent.sh` typed at the
  // operator's prompt must mean the operator's file, not one in the clone.
  // Return a fresh array because the normalized template is also the experiment
  // identity persisted in the ledger: two runs from different operator
  // directories must not both record the same misleading `./agent.sh`.
  const head = argv[0];
  return head.includes('/') && !isAbsolute(head) ? [resolve(cwd, head), ...argv.slice(1)] : [...argv];
}

export function commandAdapter(argv: string[], cwd: string = process.cwd()): AgentAdapter {
  const anchored = normalizeCommandArgv(argv, cwd);
  return {
    name: 'command',
    layers: ['envelope'],
    launch(task) {
      const substituted = anchored.map((arg) =>
        Object.entries(PLACEHOLDERS).reduce((acc, [token, value]) => acc.split(token).join(value(task)), arg),
      );
      return { argv: substituted, env: taskEnv(task) };
    },
  };
}

/**
 * The reference adapter: Claude Code in print mode, with the in-loop hooks
 * wired into the gated workspace by the same `init` a user runs. All three
 * layers are live: PreToolUse deny, Stop sweep, and the run envelope.
 */
export function claudeCodeAdapter(model?: string): AgentAdapter {
  return {
    name: 'claude-code',
    layers: ['envelope', 'pre-tool-use', 'stop-sweep'],
    prepareGated(task) {
      const code = runInit({ cwd: task.cwd });
      if (code !== 0) {
        throw new ResearchError(`claude-code adapter: tamperward init could not wire the gated workspace ${task.cwd} (exit ${code})`);
      }
    },
    launch(task) {
      const pinned = task.model ?? model;
      return {
        argv: ['claude', '-p', task.prompt, ...(pinned !== undefined ? ['--model', pinned] : [])],
        env: taskEnv(task),
      };
    },
  };
}

/** The closed set of adapter names this release ships. */
export function resolveAdapter(name: string, argv: string[], model?: string): AgentAdapter {
  if (name === 'command') return commandAdapter(argv);
  if (name === 'claude-code') return claudeCodeAdapter(model);
  throw new ResearchError(`unknown adapter "${name}" (built-in adapters: ${BUILTIN_ADAPTERS.join(', ')})`);
}
