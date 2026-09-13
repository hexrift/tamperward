import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertionWeakening } from '../src/detectors/assertion-weakening';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

type CorpusCase = {
  id: string;
  classification: 'legitimate' | 'weakening';
  source: string;
  path: string;
  before: string;
  after: string;
  expectedFindings: number;
};

type Corpus = {
  schema: number;
  provenance: {
    parent_mainline_diffs: number;
    negative_cases: number;
    positive_cases: number;
  };
  graduation: {
    build_precision_threshold: number;
    shipping_severity: string;
    block_graduation: string;
  };
  cases: CorpusCase[];
};

const corpus: Corpus = JSON.parse(
  readFileSync(join(__dirname, '..', 'harness', 'fp-study', 'assertion-weakening-corpus.json'), 'utf8'),
);

const P = defaultPolicy();

function runCase(c: CorpusCase) {
  const change: FileChange = {
    kind: 'file',
    path: c.path,
    oldPath: null,
    op: 'modify',
    before: c.before,
    after: c.after,
    binary: false,
    hunks: [],
  };
  return assertionWeakening.run([change], P);
}

describe('assertion-weakening measured corpus (#323)', () => {
  it('replays every committed labeled case exactly', () => {
    for (const c of corpus.cases) {
      expect(runCase(c), c.id).toHaveLength(c.expectedFindings);
    }
  });

  it('meets the predeclared build precision threshold without authorizing block graduation', () => {
    const outcomes = corpus.cases.map((c) => ({
      c,
      fired: runCase(c).length > 0,
    }));

    const fires = outcomes.filter((x) => x.fired);
    const truePositives = fires.filter((x) => x.c.classification === 'weakening').length;
    const falsePositives = fires.filter((x) => x.c.classification === 'legitimate').length;
    const trueNegatives = outcomes.filter(
      (x) => !x.fired && x.c.classification === 'legitimate',
    ).length;

    const precision = fires.length === 0 ? 1 : truePositives / fires.length;

    expect(corpus.provenance.parent_mainline_diffs).toBe(2304);
    expect(corpus.provenance.negative_cases).toBe(20);
    expect(corpus.provenance.positive_cases).toBe(12);
    expect(trueNegatives).toBe(20);
    expect(truePositives).toBe(12);
    expect(falsePositives).toBe(0);
    expect(precision).toBe(1);
    expect(precision).toBeGreaterThanOrEqual(corpus.graduation.build_precision_threshold);
    expect(corpus.graduation.shipping_severity).toBe('warn');
    expect(corpus.graduation.block_graduation).toMatch(/separate decision/i);
  });
});
