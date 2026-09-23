// Human-readable research output. Keep the four evidence families separate:
// there is deliberately no composite score (#481).

import { ResearchError } from './adapter';
import { summarizeLedger, type ResearchSummary } from './summarize';

const n = (value: number): string => String(value);

export function renderResearchReport(summary: ResearchSummary): string {
  const u = summary.model_behaviour.ungated;
  const g = summary.model_behaviour.gated;
  const uo = summary.independent_outcome.ungated;
  const go = summary.independent_outcome.gated;
  const lines = [
    'MODEL BEHAVIOUR',
    `  model: ${summary.model ?? '(unspecified)'}`,
    `  adapter: ${summary.adapter.name} [${summary.adapter.layers.join(', ')}]`,
    `  pairs: ${n(summary.pairs)} (measured: ${n(summary.measured_pairs)}, unmeasurable: ${n(summary.unmeasurable_pairs)})`,
    `  ungated: ${n(u.trajectories)} trajectories; masked failures ${n(u.masked_failure)}; surviving mutations ${n(u.surviving_protected_mutations)}`,
    `  gated: ${n(g.trajectories)} trajectories; masked failures ${n(g.masked_failure)}; surviving mutations ${n(g.surviving_protected_mutations)}`,
    '',
    'CONTROL RESPONSE',
    '  not measured by this adapter/ledger; denial-to-fix, surrender, and alternative-bypass responses are not inferred.',
    '',
    'INDEPENDENT OUTCOME',
    `  ungated: visible green ${n(uo.visible_green)}, pristine green ${n(uo.pristine_green)}, masked failure ${n(uo.masked_failure)}, honest completion ${n(uo.honest_completion)}, released green ${n(uo.released_green)}`,
    `  gated: visible green ${n(go.visible_green)}, pristine green ${n(go.pristine_green)}, masked failure ${n(go.masked_failure)}, honest completion ${n(go.honest_completion)}, released green ${n(go.released_green)}`,
    '',
    'TAMPERWARD PERFORMANCE',
    `  caught: ${n(summary.tamperward.caught)}`,
    `  escapes: ${n(summary.tamperward.escapes)}`,
    `  false refusals: ${n(summary.tamperward.false_refusals)}`,
    `  cannot adjudicate: ${n(summary.tamperward.cannot_adjudicate)}`,
    `  paired masked failure: ungated-only ${n(summary.paired.masked_failure.ungated_only)}, gated-only ${n(summary.paired.masked_failure.gated_only)}, both ${n(summary.paired.masked_failure.both)}, neither ${n(summary.paired.masked_failure.neither)}`,
  ];
  return lines.join('\n') + '\n';
}

export function runResearchReport(opts: { ledger: string; json?: boolean }): number {
  try {
    const summary = summarizeLedger(opts.ledger);
    process.stdout.write(opts.json ? JSON.stringify(summary, null, 2) + '\n' : renderResearchReport(summary));
    return 0;
  } catch (e) {
    if (e instanceof ResearchError) {
      process.stderr.write(`tamperward research: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
