// #438 coverage-exclusion — the CI-replayed labeled corpus behind the warn decision.
// The record (harness/fp-study/COVERAGE-EXCLUSION-CORPUS.md) is the measurement; this
// test pins the corpus's decision rule and replays every labeled case against the
// detector, so a change to the rule that moves a label fails here.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverageExclusion } from '../src/detectors/coverage-exclusion';
import { parseDiff } from '../src/diff/parse';
import { defaultPolicy } from '../src/policy';
import type { FileChange } from '../src/types';

type CorpusCase = {
  id: string;
  classification: 'legitimate' | 'exclusion';
  source: string;
  path: string;
  before: string | null;
  after: string;
  expectedFindings: number;
};

type Corpus = {
  schema: number;
  provenance: {
    mainline_pairs: number;
    mainline_pairs_with_fire: number;
    mainline_by_repo: Array<{ repo: string; pairs: number; pairs_with_fire: number }>;
    deep_frame_first_parent_commits: number;
    deep_frame_commits_adding_a_spelling: number;
    deep_frame_honest_adds: Array<{ repo: string; commit: string }>;
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

const corpus: Corpus = JSON.parse(readFileSync(join(__dirname, '..', 'harness', 'fp-study', 'coverage-exclusion-corpus.json'), 'utf8'));

const P = defaultPolicy();

/** The corpus stores full before/after; the rule reads added lines, so the hunks are
 *  built the way the CLI builds them (a real git diff). */
function change(c: CorpusCase): FileChange {
  const dir = mkdtempSync(join(tmpdir(), 'tw-covx-corpus-'));
  writeFileSync(join(dir, 'a'), c.before ?? '');
  writeFileSync(join(dir, 'b'), c.after);
  let raw = '';
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-color', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8' });
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? '');
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = parseDiff(raw)[0];
  return {
    kind: 'file',
    path: c.path,
    oldPath: null,
    op: c.before == null ? 'add' : 'modify',
    before: c.before,
    after: c.after,
    binary: false,
    hunks: parsed?.kind === 'file' ? parsed.hunks : [],
  };
}

const runCase = (c: CorpusCase) => coverageExclusion.run([change(c)], P);

describe('coverage-exclusion measured corpus (#438)', () => {
  it('replays every committed labeled case exactly', () => {
    for (const c of corpus.cases) {
      expect(runCase(c), c.id).toHaveLength(c.expectedFindings);
    }
  });

  it('the labeled counts match the cases', () => {
    const negatives = corpus.cases.filter((c) => c.classification === 'legitimate');
    const positives = corpus.cases.filter((c) => c.classification === 'exclusion');
    expect(negatives).toHaveLength(corpus.provenance.negative_cases);
    expect(positives).toHaveLength(corpus.provenance.positive_cases);
    expect(negatives.every((c) => c.expectedFindings === 0)).toBe(true);
    expect(positives.every((c) => c.expectedFindings >= 1)).toBe(true);
    expect(new Set(corpus.cases.map((c) => c.id)).size).toBe(corpus.cases.length);
  });

  it('records the mainline frame and the decision that keeps the rule at warn', () => {
    const p = corpus.provenance;
    expect(p.mainline_by_repo.reduce((n, r) => n + r.pairs, 0)).toBe(p.mainline_pairs);
    expect(p.mainline_by_repo.reduce((n, r) => n + r.pairs_with_fire, 0)).toBe(p.mainline_pairs_with_fire);
    expect(p.mainline_pairs).toBe(460);
    expect(p.mainline_pairs_with_fire).toBe(0);
    expect(p.deep_frame_honest_adds).toHaveLength(p.deep_frame_commits_adding_a_spelling);
    expect(p.mainline_pairs_with_fire / p.mainline_pairs).toBeLessThanOrEqual(corpus.graduation.block_max_mainline_fire_rate);
    // Every real fire the histories hold is an honest exclusion: the precision floor
    // for block is not met, whatever the fire rate says.
    expect(p.deep_frame_honest_adds.length).toBeGreaterThan(0);
    expect(corpus.graduation.shipping_severity).toBe('warn');
    expect(P.rules['coverage-exclusion']?.severity).toBe('warn');
    expect(corpus.graduation.block_graduation).toMatch(/not authorized/i);
    expect(corpus.graduation.block_graduation).toMatch(/separate decision/i);
  });

  it('meets the labeled-corpus precision bar without authorizing block graduation', () => {
    const outcomes = corpus.cases.map((c) => ({ c, fired: runCase(c).length > 0 }));
    const fires = outcomes.filter((x) => x.fired);
    const truePositives = fires.filter((x) => x.c.classification === 'exclusion').length;
    const falsePositives = fires.filter((x) => x.c.classification === 'legitimate').length;
    expect(truePositives).toBe(corpus.provenance.positive_cases);
    expect(falsePositives).toBe(0);
    expect(truePositives / fires.length).toBeGreaterThanOrEqual(corpus.graduation.block_min_precision);
  });
});
