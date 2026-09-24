// The shipped RuntimeAdapter registry: the single place that lists every adapter so a
// reporting surface (e.g. `tamperward runtime verify`, src/cli/runtime.ts) can resolve one
// by id without importing each adapter module itself. Detection ids (src/runtimes.ts) do not
// all equal adapter names, so a small alias map bridges the two vocabularies.

import { RuntimeAdapter } from './contract';
import { claudeAdapter } from './claude/adapter';
import { codexAdapter } from './codex/adapter';
import { copilotAdapter } from './copilot/adapter';
import { copilotSdkAdapter } from './copilot-sdk/adapter';

/** Every shipped adapter, in priority order (Claude Code leads — it is the one with a
 *  fully proven in-loop surface today). */
export const RUNTIME_ADAPTERS: readonly RuntimeAdapter[] = [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  copilotSdkAdapter,
];

/** Human labels for the qualification narrative, keyed by adapter name. */
export const ADAPTER_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'github-copilot-cli': 'GitHub Copilot CLI',
  'github-copilot-sdk-hosted': 'GitHub Copilot SDK (hosted)',
};

/** Detection ids / friendly spellings → shipped adapter name. */
const ADAPTER_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  copilot: 'github-copilot-cli',
  'copilot-cli': 'github-copilot-cli',
  'copilot-sdk': 'github-copilot-sdk-hosted',
};

/** Resolve an adapter by its name or a known alias, or null when nothing ships for it. */
export function adapterFor(id: string): RuntimeAdapter | null {
  const name = ADAPTER_ALIASES[id] ?? id;
  return RUNTIME_ADAPTERS.find((a) => a.name === name) ?? null;
}

/** The canonical adapter name for an id or alias (unchanged when already canonical). */
export function canonicalRuntimeId(id: string): string {
  return ADAPTER_ALIASES[id] ?? id;
}

/** The label for an adapter name, falling back to the name itself. */
export function labelFor(name: string): string {
  return ADAPTER_LABELS[name] ?? name;
}
