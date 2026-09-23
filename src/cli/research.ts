// `tamperward research` — the model-evaluation workflow (#391/#481).
// Parsing and dispatch only; the runner lives in src/research/run.ts and the
// aggregate in src/research/summarize.ts.

import { runResearch, type ResearchRunOpts } from '../research/run';
import { runResearchSummarize } from '../research/summarize';
import { runResearchInit, type ResearchInitOpts } from '../research/init';
import { runResearchReport } from '../research/report';
import { runResearchBundle, type ResearchBundleOpts } from '../research/bundle';

export const RESEARCH_SUBCOMMANDS = ['init', 'run', 'summarize', 'report', 'bundle', 'validate'] as const;

export function parseResearchInit(args: string[]): ResearchInitOpts {
  const o: ResearchInitOpts = { out: '', repo: '', prompt: '', verifyCommand: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') o.out = args[++i];
    else if (args[i] === '--repo') o.repo = args[++i];
    else if (args[i] === '--base') o.base = args[++i];
    else if (args[i] === '--id') o.id = args[++i];
    else if (args[i] === '--prompt') o.prompt = args[++i];
    else if (args[i] === '--verify-command') o.verifyCommand = args[++i];
    else if (args[i] === '--verify-budget') o.verifyBudget = Number(args[++i]);
  }
  return o;
}

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
    else if (a === '--break-lock') o.breakLock = true;
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

export function parseResearchReport(args: string[]): { ledger: string; json?: boolean } {
  const o: { ledger: string; json?: boolean } = { ledger: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ledger') o.ledger = args[++i];
    else if (args[i] === '--json') o.json = true;
  }
  return o;
}

export function parseResearchBundle(args: string[]): ResearchBundleOpts {
  const o: ResearchBundleOpts = { ledger: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ledger') o.ledger = args[++i];
    else if (args[i] === '--out') o.out = args[++i];
    else if (args[i] === '--manifest') o.manifest = args[++i];
    else if (args[i] === '--validate') o.validate = args[++i];
    else if (args[i] === '--bundle') o.validate = args[++i];
  }
  return o;
}

export function runResearchCommand(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'init') return runResearchInit(parseResearchInit(rest));
  if (sub === 'run') return runResearch(parseResearchRun(rest));
  if (sub === 'summarize') return runResearchSummarize(parseResearchSummarize(rest));
  if (sub === 'report') return runResearchReport(parseResearchReport(rest));
  if (sub === 'bundle') return runResearchBundle(parseResearchBundle(rest));
  if (sub === 'validate') {
    const bundle = parseResearchBundle(rest);
    return runResearchBundle({ ledger: '', validate: bundle.validate ?? bundle.out });
  }
  process.stderr.write(`tamperward research: unknown subcommand "${sub ?? ''}" (${RESEARCH_SUBCOMMANDS.join(' | ')})\n`);
  return 2;
}
