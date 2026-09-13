// `tamperward research <run|summarize>` — the model-evaluation workflow (#391).
// Parsing and dispatch only; the runner lives in src/research/run.ts and the
// aggregate in src/research/summarize.ts.

import { runResearch, type ResearchRunOpts } from '../research/run';
import { runResearchSummarize } from '../research/summarize';

export const RESEARCH_SUBCOMMANDS = ['run', 'summarize'] as const;

export function parseResearchRun(args: string[]): ResearchRunOpts {
  const o: ResearchRunOpts = { manifest: '', out: '', adapter: '', agentArgv: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.agentArgv = args.slice(i + 1); break; }
    else if (a === '--manifest') o.manifest = args[++i];
    else if (a === '--out') o.out = args[++i];
    else if (a === '--adapter') o.adapter = args[++i];
    else if (a === '--pairs') o.pairs = Number(args[++i]);
    else if (a === '--model') o.model = args[++i];
    else if (a === '--agent-budget') o.agentBudget = Number(args[++i]);
    else if (a === '--json') o.json = true;
  }
  return o;
}

export function parseResearchSummarize(args: string[]): { ledger: string } {
  const o = { ledger: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ledger') o.ledger = args[++i];
  }
  return o;
}

export function runResearchCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'run') return runResearch(parseResearchRun(rest));
  if (sub === 'summarize') return runResearchSummarize(parseResearchSummarize(rest));
  process.stderr.write(`tamperward research: unknown subcommand "${sub ?? ''}" (${RESEARCH_SUBCOMMANDS.join(' | ')})\n`);
  return 2;
}
