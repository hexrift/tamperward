// The committed ts-cast-growth corpus (#383): CI recomputes the labeled replay
// and checks that the shipping severity follows the predeclared decision rule
// against the recorded mainline fire rate in CAST-GROWTH-CORPUS.md.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsCastGrowth } from '../src/detectors/ts-cast-growth';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

type CorpusCase = {
  id: string;
  classification: 'legitimate' | 'growth';
  source: string;
  path: string;
  before: string | null;
  after: string;
  expectedFindings: number;
};

type RepoRecord = {
  repo: string;
  head: string;
  pairs: number;
  pairs_touching_eligible_source: number;
  pairs_with_fire: number;
  findings: number;
};

type Corpus = {
  schema: number;
  provenance: {
    mainline_pairs: number;
    mainline_pairs_with_fire: number;
    mainline_pairs_touching_ts: number;
    mainline_pairs_touching_eligible_source: number;
    mainline_findings: number;
    mainline_by_repo: RepoRecord[];
    recomputed_by: string;
    negative_cases: number;
    positive_cases: number;
  };
  graduation: {
    block_max_mainline_fire_rate: number;
    block_min_precision: number;
    shipping_severity: string;
    block_graduation: string;
  };
  cases: CorpusCase[];
};

const corpus: Corpus = JSON.parse(
  readFileSync(join(__dirname, '..', 'harness', 'fp-study', 'cast-growth-corpus.json'), 'utf8'),
);
const P = defaultPolicy();

function runCase(c: CorpusCase) {
  const change: FileChange = {
    kind: 'file',
    path: c.path,
    oldPath: null,
    op: c.before === null ? 'add' : 'modify',
    before: c.before,
    after: c.after,
    binary: false,
    hunks: [],
  };
  return tsCastGrowth.run([change], P).filter((f) => f.rule === 'ts-cast-growth');
}

describe('ts-cast-growth measured corpus (#383)', () => {
  it('replays every committed labeled case exactly', () => {
    for (const c of corpus.cases) {
      expect(runCase(c), c.id).toHaveLength(c.expectedFindings);
    }
  });

  it('the committed measurement is internally consistent', () => {
    const negatives = corpus.cases.filter((c) => c.classification === 'legitimate');
    const positives = corpus.cases.filter((c) => c.classification === 'growth');
    expect(negatives.length).toBe(corpus.provenance.negative_cases);
    expect(positives.length).toBe(corpus.provenance.positive_cases);
    expect(corpus.provenance.mainline_pairs).toBe(460);
    expect(corpus.provenance.mainline_pairs_with_fire).toBe(40);
    expect(corpus.provenance.mainline_pairs_touching_ts).toBe(228);
    expect(corpus.provenance.mainline_pairs_touching_eligible_source).toBe(220);

    const fires = corpus.cases.filter((c) => runCase(c).length > 0);
    const truePositives = fires.filter((c) => c.classification === 'growth').length;
    const falsePositives = fires.filter((c) => c.classification === 'legitimate').length;
    const precision = fires.length === 0 ? 1 : truePositives / fires.length;
    expect(truePositives).toBe(positives.length);
    expect(falsePositives).toBe(0);
    expect(precision).toBeGreaterThanOrEqual(corpus.graduation.block_min_precision);
  });

  it("the shipping severity follows the study's decision rule: block only under the mainline fire-rate ceiling", () => {
    const allPairsRate = corpus.provenance.mainline_pairs_with_fire / corpus.provenance.mainline_pairs;
    const eligibleRate = corpus.provenance.mainline_pairs_with_fire / corpus.provenance.mainline_pairs_touching_eligible_source;
    // Block is closed on the predeclared basis and on the stricter eligible-source basis alike.
    expect(allPairsRate <= corpus.graduation.block_max_mainline_fire_rate).toBe(false);
    expect(eligibleRate <= corpus.graduation.block_max_mainline_fire_rate).toBe(false);
    expect(corpus.graduation.shipping_severity).toBe('warn');
    expect(P.rules['ts-cast-growth']?.severity).toBe('warn');
    expect(corpus.graduation.block_graduation).toMatch(/separate decision/i);
  });

  // The 460-pair live-fire study is an external measurement recomputed by the
  // cast-growth-evidence workflow, not by this test. What this test CAN check
  // cheaply on every run is that the committed evidence is internally
  // consistent: the per-repository fire records reproduce the totals the
  // record and the severity decision rest on, and the record names the pins.
  it('the committed fire records reproduce the recorded totals and pins', () => {
    const study = join(__dirname, '..', 'harness', 'fp-study');
    const record = readFileSync(join(study, 'CAST-GROWTH-CORPUS.md'), 'utf8');
    let pairs = 0;
    let eligible = 0;
    let fired = 0;
    let findings = 0;
    for (const r of corpus.provenance.mainline_by_repo) {
      expect(r.head, r.repo).toMatch(/^[0-9a-f]{40}$/);
      expect(record, `${r.repo} pin is recorded`).toContain(r.head);
      const fires = readFileSync(join(study, `cast-growth-${r.repo}-fires.jsonl`), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { repo: string; base: string; head: string; file: string | null; evidence: string });
      expect(fires.every((f) => f.repo === r.repo), r.repo).toBe(true);
      expect(fires.length, `${r.repo} findings`).toBe(r.findings);
      expect(new Set(fires.map((f) => `${f.base}...${f.head}`)).size, `${r.repo} fired pairs`).toBe(r.pairs_with_fire);
      expect(r.pairs_with_fire).toBeLessThanOrEqual(r.pairs_touching_eligible_source);
      pairs += r.pairs;
      eligible += r.pairs_touching_eligible_source;
      fired += r.pairs_with_fire;
      findings += r.findings;
    }
    expect(pairs).toBe(corpus.provenance.mainline_pairs);
    expect(eligible).toBe(corpus.provenance.mainline_pairs_touching_eligible_source);
    expect(fired).toBe(corpus.provenance.mainline_pairs_with_fire);
    expect(findings).toBe(corpus.provenance.mainline_findings);
    expect(corpus.provenance.recomputed_by).toContain('cast-growth-evidence.yml');
    expect(existsSync(join(__dirname, '..', '.github', 'workflows', 'cast-growth-evidence.yml'))).toBe(true);
  });

  it('warn never requires sign-off under the default policy', () => {
    const [f] = runCase(corpus.cases.find((c) => c.id === 'pos-01-json-parse-as')!);
    expect(f.severity).toBe('warn');
    expect(f.signoff.required).toBe(false);
  });
});
