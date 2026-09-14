// coverage-exclusion live-fire replay over a pinned real-repository corpus (#438).
//
// For the last N adjacent first-parent pairs ending at a pinned head, run the
// candidate CLI's `check --diff base...head --json` and record each
// coverage-exclusion finding. The measured quantity is the FIRE RATE on legitimate
// mainline maintenance — the "would this warning annoy a real developer" measure
// that decides whether a block severity is deployable
// (harness/fp-study/ADJUDICATION-RULE.md). The pair frame is the one the
// ts-cast-growth study used (cast-growth-fires.mjs): the same four repositories at
// the same heads, so the two warn rules are measured on the same denominator.
// Fails closed on CLI spawn/exit/JSON errors like test-skip-ast-delta.mjs.
//
// Only pairs whose diff ADDS a line carrying one of the rule's raw spellings are
// handed to the CLI: the rule fires on nothing else, so the skipped pairs are
// non-fires by construction and the count is exact. The raw scan is a superset of
// the rule (no language, path, string or comment reading).
//
// usage: node coverage-exclusion-fires.mjs <label> <repoDir> <head> <pairs> <candidateCli> [firesOut.jsonl]
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [label, repoDir, head, pairsRaw, cliRaw, firesOut] = process.argv.slice(2);
if (!label || !repoDir || !head || !pairsRaw || !cliRaw) {
  console.error('usage: node coverage-exclusion-fires.mjs <label> <repoDir> <head> <pairs> <candidateCli> [firesOut.jsonl]');
  process.exit(2);
}
const cli = resolve(cliRaw);
const want = Number(pairsRaw);
const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const RAW = /\/\*\s*(?:istanbul|c8|v8)\s+ignore\b|\/\*\s*node:coverage\s+(?:ignore|disable)\b|#\s*pragma[:\s]\s*no\s*cover\b|coverage\s*\(\s*off\s*\)|^\s*\/\/\s*(?:go:build\b|\+build\b)/im;
const ELIGIBLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|pyw?|go|rs)$/;

function verdict(base, to) {
  const r = spawnSync(process.execPath, [cli, 'check', '--diff', `${base}...${to}`, '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const where = `${base.slice(0, 12)}...${to.slice(0, 12)}`;
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

// The last `want` first-parent pairs ending at `head`: want + 1 commits.
const commits = git('rev-list', '--first-parent', `--max-count=${want + 1}`, head).trim().split('\n').filter(Boolean).reverse();
if (commits.length !== want + 1) throw new Error(`${label}: wanted ${want} pairs, history holds ${commits.length - 1}`);
if (commits[commits.length - 1] !== head) throw new Error(`${label}: history does not end at ${head}`);
if (firesOut) writeFileSync(firesOut, '');

let pairs = 0;
let eligiblePairs = 0;
let candidatePairs = 0;
let pairsWithFire = 0;
let fires = 0;
const files = new Set();

for (let i = 1; i < commits.length; i++) {
  const base = commits[i - 1];
  const to = commits[i];
  pairs++;
  const touched = git('diff', '--name-only', `${base}...${to}`).trim().split('\n').filter(Boolean);
  if (touched.some((f) => ELIGIBLE.test(f))) eligiblePairs++;
  // Added lines only (`+` but not `+++`), over the whole pair.
  const patch = git('diff', '--unified=0', '--no-color', `${base}...${to}`);
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  if (!added.some((l) => RAW.test(l.slice(1)))) continue;
  candidatePairs++;
  const doc = verdict(base, to);
  const hits = (doc.findings || []).filter((f) => f.rule === 'coverage-exclusion');
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
          head: to.slice(0, 12),
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
    corpus_head: head,
    pairs,
    pairs_touching_eligible_source: eligiblePairs,
    pairs_with_candidate_line: candidatePairs,
    pairs_with_fire: pairsWithFire,
    fire_rate_all_pairs: pairs ? Number((pairsWithFire / pairs).toFixed(4)) : 0,
    fire_rate_eligible_pairs: eligiblePairs ? Number((pairsWithFire / eligiblePairs).toFixed(4)) : 0,
    findings: fires,
    files_flagged: files.size,
  }),
);
