// The Research & Benchmarks docs section (#390) is a presentation layer over the
// committed research record, never a second copy of it. This suite re-derives every
// headline number the section publishes from the sealed / frozen artifacts and checks
// the pages against them, so a page cannot drift from the record it presents:
//
// - rounds 1, 2, 3 and 3.1: pairs, b, c, exact McNemar p, model and trajectory count
//   are recomputed from each round's frozen `results.jsonl` verdict ledger, and the
//   treatment version is read from the round's registered prediction document;
// - round 4: every figure comes from `ROUND4-RESULTS.json`, and the landing-table
//   status is derived from that artifact's sealed completeness/provenance fields;
// - detector precision: counts come from the fp-study corpus JSON files and the
//   `**total**` rows of the study records;
// - performance: the only committed measurements are the CHANGELOG snapshot benchmark
//   rows and the SECURITY-ENVELOPE effect-drift timing;
// - the site wiring: every page is in the sidebar, the landing pages carry the
//   "See the evidence" link, and no page introduces a composite score.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const researchDir = join(root, 'docs', 'research');

const PAGES = [
  'index.md',
  'round-1.md',
  'round-2.md',
  'round-3.md',
  'round-3-1.md',
  'round-4.md',
  'detector-precision.md',
  'performance.md',
  'security-evaluations.md',
  'model-comparisons.md',
  'methodology-limitations-errata.md',
] as const;

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function page(name: (typeof PAGES)[number]): string {
  return readFileSync(join(researchDir, name), 'utf8');
}

// Exact conditional (binomial) McNemar test, two-sided, on the discordant pairs — the
// registered test in every round. Returns 1 for zero discordance.
function exactMcNemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const choose = (nn: number, k: number): number => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (nn - k + i)) / i;
    return r;
  };
  let tail = 0;
  for (let k = Math.max(b, c); k <= n; k++) tail += choose(n, k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

type Verdict = { task: string; arm: string; outcome: string; model: string };

function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.task === 'string' &&
    typeof r.arm === 'string' &&
    typeof r.outcome === 'string' &&
    typeof r.model === 'string'
  );
}

type LedgerSummary = {
  trajectories: number;
  pairs: number;
  b: number;
  c: number;
  p: number;
  rdPp: number;
  model: string;
};

// Recompute the paired FALSE_GREEN discordance the rounds-1..3.1 analyzers report:
// b = ungated FALSE_GREEN with the gated arm clean, c = the reverse, over tasks with
// both arms present. This is the frozen `analyze.mjs` / `analyze3.mjs` prevention
// endpoint, re-derived here so the docs are checked against the ledger itself.
function summarizeLedger(rel: string): LedgerSummary {
  const rows = read(rel)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l): unknown => JSON.parse(l))
    .filter(isVerdict);
  const byTask = new Map<string, { gated?: Verdict; ungated?: Verdict }>();
  const models = new Set<string>();
  for (const r of rows) {
    models.add(r.model);
    const entry = byTask.get(r.task) ?? {};
    if (r.arm === 'gated') entry.gated = r;
    if (r.arm === 'ungated') entry.ungated = r;
    byTask.set(r.task, entry);
  }
  let pairs = 0;
  let b = 0;
  let c = 0;
  for (const { gated, ungated } of byTask.values()) {
    if (!gated || !ungated) continue;
    pairs++;
    const gm = gated.outcome === 'FALSE_GREEN';
    const um = ungated.outcome === 'FALSE_GREEN';
    if (um && !gm) b++;
    if (gm && !um) c++;
  }
  expect(models.size, `${rel} pins exactly one model`).toBe(1);
  return {
    trajectories: rows.length,
    pairs,
    b,
    c,
    p: exactMcNemar(b, c),
    rdPp: ((b - c) / pairs) * 100,
    model: [...models][0],
  };
}

function registeredTreatment(preregRel: string): string {
  const m = read(preregRel).match(/[Tt]amperward \*{0,2}v?(\d+\.\d+\.\d+)\*{0,2}/);
  expect(m, `${preregRel} names a registered treatment version`).not.toBeNull();
  return m![1];
}

type Round4 = {
  provenance: {
    treatment_version: string;
    model: string;
    counted_state_commit: string;
    input_verification: { mode: string; verified: boolean };
  };
  counts: { trajectories: number; verdicts: number; adjudicated: number; measured: number };
  completeness_ok: boolean;
  primary: {
    primary_tasks: number;
    valid_pairs: number;
    excluded_pairs: number;
    b_prevention: number;
    c_induced_harm: number;
    a_both_mf: number;
    d_both_clean: number;
    exact_mcnemar_p_two_sided: number;
    reject_H0: boolean;
    interpretation_floor_required: number;
    ungated_opportunities_a_plus_b: number;
    realized_discordant_pairs: number;
    planning_assumed_discordant_approx: number;
    predicted: { b: number; c: number };
  };
  integrity: {
    measured: number;
    envelope_escape: number;
    strict_tamper_bypass: number;
    masked_failures_pooled: number;
    gated_landed_tampering: {
      measured_gated: number;
      landed_count: number;
      landed_flagged_count: number;
      landed_certified_clean_count: number;
      surviving_count: number;
    };
    masked_failure_mechanism: {
      pooled: { with_landed_weakening: number; no_landed_weakening: number };
    };
  };
  denominators: {
    pre_sampling_adjudicated_exclusions: number;
    post_sampling_invalid_measurement_exclusions: number;
  };
  secondary: {
    completion: {
      gated: number;
      ungated: number;
      gated_pct: number;
      ungated_pct: number;
      paired_RD_pp_gated_minus_ungated: number;
      newcombe_paired_95ci_pp: [number, number];
    };
    final_state_blind_repository_unit: {
      gated: { num: number; denom: number };
      ungated: { num: number; denom: number };
    };
    denial_response: { gated_with_denials: number };
  };
  duplicates: { arm_level_comparisons: number; mfAgree: number; outcomeAgree: number };
};

const round4: Round4 = JSON.parse(read('harness/taskbench/round4/ROUND4-RESULTS.json'));

// Landing-table rows keyed by the study name in the first cell.
function landingRows(): Map<string, string[]> {
  const md = page('index.md');
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^\|\s*Study\s*\|/.test(l));
  expect(start, 'index.md has the landing table').toBeGreaterThanOrEqual(0);
  const rows = new Map<string, string[]>();
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i]
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const study = cells[0].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*/g, '');
    rows.set(study, cells);
  }
  return rows;
}

const ROUNDS = [
  {
    study: 'Round 1',
    page: 'round-1.md',
    ledger: 'harness/taskbench/runs-phase3/results.jsonl',
    prereg: 'harness/taskbench/PREDICTION-taskbench.md',
  },
  {
    study: 'Round 2',
    page: 'round-2.md',
    ledger: 'harness/taskbench/round2/runs-phase3/results.jsonl',
    prereg: 'harness/taskbench/round2/PREDICTION2-taskbench.md',
  },
  {
    study: 'Round 3',
    page: 'round-3.md',
    ledger: 'harness/taskbench/round3/runs-phase3/results.jsonl',
    prereg: 'harness/taskbench/round3/PREDICTION3-taskbench.md',
  },
  {
    study: 'Round 3.1',
    page: 'round-3-1.md',
    ledger: 'harness/taskbench/round3.1/runs-phase3/results.jsonl',
    prereg: 'harness/taskbench/round3.1/PREDICTION3.1-taskbench.md',
  },
] as const;

const sign = (pp: number): string => (pp >= 0 ? '+' : '−') + Math.abs(pp).toFixed(1);

describe('Research & Benchmarks docs present the committed record (#390)', () => {
  it('ships every page the section declares and wires each into the sidebar and nav', () => {
    const config = read('docs/.vitepress/config.mts');
    expect(config).toContain("'/research/'");
    expect(config).toMatch(/text: 'Research'/);
    for (const p of PAGES) {
      expect(existsSync(join(researchDir, p)), p).toBe(true);
      const link = p === 'index.md' ? '/research/' : `/research/${p.replace(/\.md$/, '')}`;
      expect(config, `sidebar links ${link}`).toContain(`link: '${link}'`);
    }
  });

  it('is reachable from the docs landing page and the README without becoming a leaderboard', () => {
    const home = read('docs/index.md');
    expect(home).toMatch(/text: See the evidence →\s*\n\s*link: \/research\//);
    const readme = read('README.md');
    expect(readme).toMatch(/\*\*\[See the evidence →\]\(\.\/docs\/research\/index\.md\)\*\*/);
    // The home page's hero keeps its three jobs (what, why, how to start); the evidence
    // link is one action, not a results table.
    expect(home).not.toMatch(/^\|\s*Study\s*\|/m);
  });

  it('never introduces an aggregate score or a ranking', () => {
    for (const p of PAGES) {
      const md = page(p);
      expect(md, p).not.toMatch(/tamperward score/i);
      expect(md, p).not.toMatch(/leaderboard(?! —| is not| and)/i);
    }
  });

  it('links limitations and errata from every result page', () => {
    for (const p of PAGES) {
      if (p === 'methodology-limitations-errata.md') continue;
      const md = page(p);
      expect(md, `${p} links the errata`).toMatch(/\.\.\/blog\/errata(\.md)?/);
      expect(md, `${p} links the limitations`).toMatch(/\.\.\/blog\/limitations(\.md)?/);
    }
  });

  describe.each(ROUNDS)('$study', ({ study, page: pageName, ledger, prereg }) => {
    const s = summarizeLedger(ledger);
    const treatment = registeredTreatment(prereg);

    it('landing row carries model, runtime, sample, treatment, result and status from the ledger', () => {
      const row = landingRows().get(study);
      expect(row, `${study} row present`).toBeDefined();
      const [, model, sample, treat, result, status] = row!;
      expect(model).toContain(s.model);
      expect(model).toContain('Claude Code');
      expect(sample).toContain(`${s.pairs} pairs`);
      expect(sample).toContain(`${s.trajectories} trajectories`);
      expect(treat).toContain(treatment);
      expect(result).toContain(`b=${s.b}`);
      expect(result).toContain(`c=${s.c}`);
      expect(result).toContain(`p = ${s.p.toFixed(4)}`);
      expect(status).toMatch(/^complete/);
    });

    it('detail page states the same figures and links its registration, ledger, errata and limitations', () => {
      const md = page(pageName);
      expect(md).toContain(s.model);
      expect(md).toContain('Claude Code');
      expect(md).toContain(`**${treatment}**`);
      expect(md).toContain(`${s.pairs} pairs`);
      expect(md).toContain(`${s.trajectories} trajectories`);
      expect(md).toContain(`b=${s.b}`);
      expect(md).toContain(`c=${s.c}`);
      expect(md).toContain(`p = ${s.p.toFixed(4)}`);
      expect(md).toContain(`RD ${sign(s.rdPp)}pp`);
      expect(md).toContain(prereg);
      expect(md).toContain(ledger);
    });
  });

  it('Round 1 keeps the lost prevention headline and the corrected, refuted transfer bet visible', () => {
    const md = page('round-1.md');
    const s = summarizeLedger('harness/taskbench/runs-phase3/results.jsonl');
    expect(s.p).toBe(1);
    expect(md).toMatch(/prevention bet \*\*lost\*\*/);
    expect(md).toContain('9/27');
    expect(md).toContain('refuted');
    expect(md).toContain('harness/taskbench/reanalysis/TRANSFER-REANALYSIS.md');
    expect(landingRows().get('Round 1')![4]).toMatch(/lost/);
  });

  it('Round 3.1 states the non-replication and its b ≤ 3 ceiling as its own finding', () => {
    const md = page('round-3-1.md');
    expect(md).toContain('did not replicate');
    expect(md).toContain('b ≤ 3');
    expect(md).toContain('harness/taskbench/round3.1/BETS3.1-SCORECARD.md');
    expect(landingRows().get('Round 3.1')![4]).toContain('did not replicate');
  });

  it('Round 4 landing row and status are derived from the sealed results artifact', () => {
    const row = landingRows().get('Round 4');
    expect(row).toBeDefined();
    const [, model, sample, treat, result, status] = row!;
    const p4 = round4.primary;
    expect(model).toContain(round4.provenance.model);
    expect(model).toContain('Claude Code');
    expect(sample).toContain(`${p4.valid_pairs} / ${p4.primary_tasks} valid pairs`);
    expect(sample).toContain(`${round4.counts.trajectories} trajectories`);
    expect(treat).toContain(round4.provenance.treatment_version);
    expect(result).toContain(`b=${p4.b_prevention}`);
    expect(result).toContain(`c=${p4.c_induced_harm}`);
    expect(result).toContain(`p = ${p4.exact_mcnemar_p_two_sided.toFixed(3)}`);
    expect(result).toContain(p4.reject_H0 ? 'reject H₀' : 'not rejected');
    expect(result).toContain(`${round4.integrity.strict_tamper_bypass} strict tamper bypasses`);
    const sealed =
      round4.completeness_ok &&
      round4.provenance.input_verification.mode === 'authoritative' &&
      round4.provenance.input_verification.verified;
    expect(status).toContain(sealed ? 'complete — sealed' : 'registered');
  });

  it('Round 4 detail page reproduces the sealed primary, integrity, secondary and denominator figures', () => {
    const md = page('round-4.md');
    const { provenance, counts, primary: p4, integrity, denominators, secondary, duplicates } = round4;
    for (const s of [
      provenance.model,
      `**${provenance.treatment_version}**`,
      provenance.counted_state_commit.slice(0, 8),
      `${counts.trajectories} planned trajectories`,
      `${counts.verdicts} verdicts`,
      `${counts.adjudicated} adjudicated`,
      `${counts.measured} measured`,
      `${p4.valid_pairs} / ${p4.primary_tasks}`,
      `b=${p4.b_prevention}`,
      `c=${p4.c_induced_harm}`,
      `a=${p4.a_both_mf}`,
      `d=${p4.d_both_clean}`,
      `p = ${p4.exact_mcnemar_p_two_sided.toFixed(3)}`,
      `predicted b=${p4.predicted.b}`,
      `c=${p4.predicted.c}`,
      `a + b = ${p4.ungated_opportunities_a_plus_b}`,
      `floor ${p4.interpretation_floor_required}`,
      `${p4.realized_discordant_pairs} realized discordant pairs`,
      `${p4.planning_assumed_discordant_approx} assumed`,
      `${integrity.strict_tamper_bypass} strict tamper bypasses`,
      `${integrity.measured} measured trajectories`,
      `${integrity.envelope_escape} frozen \`envelope_escape\` events`,
      `${integrity.masked_failures_pooled} masked failures`,
      `${integrity.masked_failure_mechanism.pooled.with_landed_weakening} tampering-related`,
      `${integrity.masked_failure_mechanism.pooled.no_landed_weakening} correctness`,
      `${integrity.gated_landed_tampering.landed_count} gated trajectories`,
      `${integrity.gated_landed_tampering.landed_flagged_count} were flagged`,
      `${integrity.gated_landed_tampering.landed_certified_clean_count} was certified clean`,
      `−${denominators.pre_sampling_adjudicated_exclusions} pre-sampling`,
      `−${denominators.post_sampling_invalid_measurement_exclusions} post-sampling`,
      `${secondary.completion.gated_pct.toFixed(1)}% (${secondary.completion.gated}/${p4.valid_pairs})`,
      `${secondary.completion.ungated_pct.toFixed(1)}% (${secondary.completion.ungated}/${p4.valid_pairs})`,
      `RD ${sign(secondary.completion.paired_RD_pp_gated_minus_ungated)} pp`,
      `[${sign(secondary.completion.newcombe_paired_95ci_pp[0])}, ${sign(secondary.completion.newcombe_paired_95ci_pp[1])}] pp`,
      `${secondary.final_state_blind_repository_unit.gated.num}/${secondary.final_state_blind_repository_unit.gated.denom}`,
      `${secondary.final_state_blind_repository_unit.ungated.num}/${secondary.final_state_blind_repository_unit.ungated.denom}`,
      `${secondary.denial_response.gated_with_denials} gated trajectories recorded`,
      `${duplicates.mfAgree}/${duplicates.arm_level_comparisons}`,
      `${duplicates.outcomeAgree}/${duplicates.arm_level_comparisons}`,
      'harness/taskbench/round4/PREDICTION4-taskbench.md',
      'harness/taskbench/round4/ROUND4-RESULTS.json',
      'harness/taskbench/round4/ROUND4-ANALYSIS.md',
      'harness/taskbench/round4/DEVIATIONS.md',
      'harness/taskbench/round4/COUNTED-EXECUTION-MANIFEST.json',
    ]) {
      expect(md, s).toContain(s);
    }
    expect(md).toContain(p4.reject_H0 ? 'H₀ rejected' : 'H₀ not rejected');
    expect(integrity.gated_landed_tampering.surviving_count).toBe(0);
    expect(md).toContain('not "every landed case was flagged"');
  });

  it('detector-precision page carries the fp-study corpus counts and severities', () => {
    const md = page('detector-precision.md');
    type CastCorpus = {
      provenance: { mainline_pairs: number; mainline_pairs_with_fire: number; negative_cases: number; positive_cases: number };
      graduation: { shipping_severity: string; block_max_mainline_fire_rate: number };
    };
    type AwCorpus = {
      provenance: { parent_mainline_diffs: number; negative_cases: number; positive_cases: number };
      graduation: { shipping_severity: string; build_precision_threshold: number };
    };
    const cast: CastCorpus = JSON.parse(read('harness/fp-study/cast-growth-corpus.json'));
    const aw: AwCorpus = JSON.parse(read('harness/fp-study/assertion-weakening-corpus.json'));
    const castRate = ((cast.provenance.mainline_pairs_with_fire / cast.provenance.mainline_pairs) * 100).toFixed(1);
    for (const s of [
      `${cast.provenance.mainline_pairs_with_fire} / ${cast.provenance.mainline_pairs}`,
      `${castRate}%`,
      `${cast.graduation.block_max_mainline_fire_rate * 100}% ceiling`,
      `${cast.provenance.negative_cases} negative`,
      `${cast.provenance.positive_cases} positive`,
      `\`${cast.graduation.shipping_severity}\``,
      `${aw.provenance.parent_mainline_diffs.toLocaleString('en-US')}`,
      `${aw.provenance.positive_cases}/${aw.provenance.positive_cases}`,
      `0/${aw.provenance.negative_cases}`,
      `${aw.graduation.build_precision_threshold * 100}% precision`,
      `\`${aw.graduation.shipping_severity}\``,
    ]) {
      expect(md, s).toContain(s);
    }

    // The `**total**` rows of the study records are the published headline counts.
    const totals = (rel: string): string[] => {
      const line = read(rel)
        .split('\n')
        .find((l) => /^\|\s*\*\*total\*\*/.test(l));
      expect(line, `${rel} has a total row`).toBeDefined();
      return line!
        .split('|')
        .slice(2, -1)
        .map((c) => c.replace(/\*/g, '').trim())
        .filter((c) => c !== '—');
    };
    const [tcrDiffs, tcrFiring, tcrFindings] = totals('harness/fp-study/TCR-CORPUS.md');
    expect(md).toContain(`${tcrDiffs} adjacent mainline diffs`);
    expect(md).toContain(`${tcrFiring} firing`);
    expect(md).toContain(`${tcrFindings} findings`);
    const [snapCommits, snapTouching, , snapCoTouch] = totals('harness/fp-study/PREDICTION-snapshot-fp.md');
    expect(md).toContain(`${snapCommits} first-parent`);
    expect(md).toContain(snapTouching);
    expect(md).toContain(snapCoTouch);
    const [skipPairs, skipNew] = totals('harness/fp-study/TEST-SKIP-AST-CORPUS.md');
    expect(md).toContain(`${skipNew}/${skipPairs}`);
    const [castPairs, , , castFire] = totals('harness/fp-study/CAST-GROWTH-CORPUS.md');
    expect(Number(castPairs)).toBe(cast.provenance.mainline_pairs);
    expect(Number(castFire)).toBe(cast.provenance.mainline_pairs_with_fire);
  });

  it('performance page reports only the committed measurements and says what is missing', () => {
    const md = page('performance.md');
    const changelog = read('CHANGELOG.md');
    const rows = changelog.match(/^\| (small|medium|large) \| [\d,]+ \| [\d,]+ \| [\d.]+ ms \|$/gm);
    expect(rows, 'CHANGELOG snapshot benchmark table').not.toBeNull();
    expect(rows!.length).toBe(3);
    for (const r of rows!) {
      const [, fixture, files, bytes, ms] = r.split('|').map((c) => c.trim());
      expect(md, fixture).toContain(`| ${fixture} | ${files} | ${bytes} | ${ms} |`);
    }
    const drift = read('SECURITY-ENVELOPE.md').match(/Measured cost ([\d.]+ms) → ([\d.]+ms) on a ([^,]+),/);
    expect(drift, 'SECURITY-ENVELOPE effect-drift timing').not.toBeNull();
    expect(md).toContain(`${drift![1]} → ${drift![2]}`);
    expect(md).toContain('No production-pilot');
    expect(md).toMatch(/not (universal )?performance guarantees/);
  });

  it('security page states the strict-bypass result precisely and the verifier bypass window from the record', () => {
    const md = page('security-evaluations.md');
    expect(md).toContain(`${round4.integrity.strict_tamper_bypass} strict tamper bypasses`);
    expect(md).toContain(`${round4.integrity.measured} measured trajectories`);
    // The 1.14.1 verifier bypass was present from 1.9.0 through 1.14.0 (errata, 2026-09-01).
    expect(read('docs/blog/errata.md')).toMatch(/reproduces from \*\*v1\.9\.0\*\*[\s\S]*through \*\*v1\.14\.0\*\*/);
    expect(md).toMatch(/1\.9\.0[^\n]*1\.14\.0[^\n]*1\.14\.1|1\.14\.1[^\n]*1\.9\.0[^\n]*1\.14\.0/);
    expect(md).toMatch(/not proof|not a proof/);
    expect(md).toContain('SECURITY-ENVELOPE.md');
    expect(md).toContain('## Current open residuals');
  });

  it('model-comparisons page uses the errata-corrected common-16 denominator and no composite', () => {
    const md = page('model-comparisons.md');
    expect(md).toContain('9/16');
    expect(md).toContain('4/16');
    expect(md).toMatch(/MODEL BEHAVIOUR[\s\S]*OUTCOME INTEGRITY[\s\S]*CONTROL RESPONSE[\s\S]*TAMPERWARD PERFORMANCE/);
    expect(md).toMatch(/not (directly )?comparable/);
  });
});
