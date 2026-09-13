// ts-cast-growth live-fire replay over a pinned real-repository corpus (#383).
//
// For every adjacent first-parent pair in the corpus checkout, run the candidate
// CLI's `check --diff base...head --json` and record each ts-cast-growth finding.
// The measured quantity is the FIRE RATE on legitimate mainline maintenance —
// the "would this warning annoy a real developer" measure that decides whether a
// block severity is deployable (harness/fp-study/ADJUDICATION-RULE.md). Fails
// closed on CLI spawn/exit/JSON errors like test-skip-ast-delta.mjs.
//
// usage: node cast-growth-fires.mjs <label> <repoDir> <candidateCli> [firesOut.jsonl]
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [label, repoDir, cliRaw, firesOut] = process.argv.slice(2);
if (!label || !repoDir || !cliRaw) {
  console.error('usage: node cast-growth-fires.mjs <label> <repoDir> <candidateCli> [firesOut.jsonl]');
  process.exit(2);
}
const cli = resolve(cliRaw);
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

function verdict(base, head) {
  const r = spawnSync(process.execPath, [cli, 'check', '--diff', `${base}...${head}`, '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const where = `${base.slice(0, 12)}...${head.slice(0, 12)}`;
  const stderr = String(r.stderr || '').trim();
  if (r.error) throw new Error(`CLI spawn failed for ${where}: ${r.error.message}`);
  if (r.signal) throw new Error(`CLI terminated by ${r.signal} for ${where}${stderr ? `: ${stderr}` : ''}`);
  if (r.status !== 0 && r.status !== 1) throw new Error(`unexpected CLI exit ${String(r.status)} for ${where}${stderr ? `: ${stderr}` : ''}`);
  const text = String(r.stdout || '').trim();
  if (!text) throw new Error(`CLI produced no JSON for ${where} (exit ${String(r.status)}${stderr ? `; stderr: ${stderr}` : ''})`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`CLI produced malformed JSON for ${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || !Array.isArray(parsed.findings)) throw new Error(`CLI JSON is missing findings[] for ${where}`);
  return parsed;
}

const commits = git('rev-list', '--first-parent', '--reverse', 'HEAD').trim().split('\n').filter(Boolean);
if (firesOut) writeFileSync(firesOut, '');
let pairs = 0;
let pairsWithFire = 0;
let fires = 0;
let tsPairs = 0;
let eligiblePairs = 0;
const ELIGIBLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/;
const OUT_OF_BUDGET = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|generated|__generated__)\/|\.(?:generated|gen)\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs)$|(?:^|\/)__tests__\//;
const GENERATED_HEADER = /@generated\b|\bAUTO-?GENERATED\b|\bDO NOT EDIT\b/i;
const files = new Set();

for (let i = 1; i < commits.length; i++) {
  const base = commits[i - 1];
  const head = commits[i];
  const touched = git('diff', '--name-only', `${base}...${head}`).trim().split('\n').filter(Boolean);
  const touchesTs = touched.some((f) => /\.(?:ts|tsx|mts|cts)$/.test(f) && !/\.d\.[cm]?ts$/.test(f));
  // The detector's own eligible surface: a code file that is not a declaration,
  // not on a generated/vendored path and not a protected test file under the
  // default policy. This is the denominator on which the rule actually runs.
  // Same trusted-side rule as the detector: a file whose BEFORE header (first
  // 20 lines at `base`) declares itself generated is outside the budget.
  const generatedAtBase = (f) => {
    const r = spawnSync('git', ['show', `${base}:${f}`], { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return false; // added in this pair: only its path can exempt it
    return GENERATED_HEADER.test(String(r.stdout || '').split('\n', 20).join('\n'));
  };
  const touchesEligible = touched.some(
    (f) => ELIGIBLE.test(f) && !DECLARATION.test(f) && !OUT_OF_BUDGET.test(f) && !TEST_FILE.test(f) && !generatedAtBase(f),
  );
  const doc = verdict(base, head);
  pairs++;
  if (touchesTs) tsPairs++;
  if (touchesEligible) eligiblePairs++;
  const hits = (doc.findings || []).filter((f) => f.rule === 'ts-cast-growth');
  if (hits.length) pairsWithFire++;
  for (const f of hits) {
    fires++;
    files.add(f.file || '');
    if (firesOut) {
      appendFileSync(
        firesOut,
        JSON.stringify({
          repo: label,
          base: base.slice(0, 12),
          head: head.slice(0, 12),
          file: f.file || null,
          line: f.line || null,
          message: f.message || '',
          evidence: f.evidence || '',
          verdict: '',
        }) + '\n',
      );
    }
  }
}

console.log(
  JSON.stringify({
    repo: label,
    corpus_head: commits[commits.length - 1],
    pairs,
    pairs_touching_ts: tsPairs,
    pairs_touching_eligible_source: eligiblePairs,
    pairs_with_fire: pairsWithFire,
    fire_rate_all_pairs: pairs ? Number((pairsWithFire / pairs).toFixed(4)) : 0,
    fire_rate_ts_pairs: tsPairs ? Number((pairsWithFire / tsPairs).toFixed(4)) : 0,
    fire_rate_eligible_pairs: eligiblePairs ? Number((pairsWithFire / eligiblePairs).toFixed(4)) : 0,
    findings: fires,
    files_flagged: files.size,
  }),
);
