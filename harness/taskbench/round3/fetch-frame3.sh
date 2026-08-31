#!/usr/bin/env bash
# Taskbench round 3: build frame3 per FRAME3.md — map the pinned
# top-pypi-packages snapshot (rank 1..15000) to GitHub repos via the PyPI
# JSON API, with round-1/round-2 frame repos and the enumerated
# development-data set pre-seeded into dedup (case-insensitive).
# Outputs: frame/frame.json, frame/walk-order.json, frame/mapping-log.jsonl.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p frame

node - <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const SEED = 'taskbench-v3-2026-08-31';
const TARGET = 500;
const { rows } = JSON.parse(fs.readFileSync('frame/top-pypi-packages.min.json', 'utf8'));
const round1 = JSON.parse(fs.readFileSync('../frame/frame.json', 'utf8'));
const round2 = JSON.parse(fs.readFileSync('../round2/frame/frame.json', 'utf8'));
// FRAME2 corrections 1-2: repos that priced or tuned any shipped detector are
// development data, spent for validation pools. Enumerated set, frozen in FRAME3.md.
const DEVDATA = ['honojs/hono', 'nestjs/nest', 'facebook/docusaurus', 'immerjs/immer',
  'jestjs/jest', 'prettier/prettier', 'colinhacks/zod', 'pmndrs/zustand'];

const normalize = (u) => {
  if (!u) return null;
  const m = String(u).match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
};
const lc = (r) => r.toLowerCase();

(async () => {
  const seen = new Map(); // lowercased owner/repo -> provenance
  for (const r of round1.repos) seen.set(lc(r.repo), 'spent');
  for (const r of round2.repos) seen.set(lc(r.repo), 'spent');
  for (const r of DEVDATA) seen.set(lc(r), 'devdata');
  const admitted = new Map();
  const log = fs.createWriteStream('frame/mapping-log.jsonl');
  let rank = 0;
  for (const row of rows) {
    rank++;
    if (admitted.size >= TARGET) break;
    const pkg = row.project;
    let repo = null, err = null;
    try {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const doc = await res.json();
      const urls = (doc.info && doc.info.project_urls) || {};
      for (const v of Object.values(urls)) { repo = normalize(v); if (repo) break; }
      if (!repo) repo = normalize(doc.info && doc.info.home_page);
    } catch (e) { err = String(e.message || e); }
    if (err) { log.write(JSON.stringify({ rank, pkg, skip: 'registry_error', err }) + '\n'); continue; }
    if (!repo) { log.write(JSON.stringify({ rank, pkg, skip: 'no_github_repo' }) + '\n'); continue; }
    const prior = seen.get(lc(repo));
    if (prior === 'spent') { log.write(JSON.stringify({ rank, pkg, skip: 'spent_dedup', repo }) + '\n'); continue; }
    if (prior === 'devdata') { log.write(JSON.stringify({ rank, pkg, skip: 'devdata_dedup', repo }) + '\n'); continue; }
    if (prior) { log.write(JSON.stringify({ rank, pkg, skip: 'monorepo_dedup', repo }) + '\n'); continue; }
    seen.set(lc(repo), 'round3');
    admitted.set(repo, { repo, first_pkg: pkg, pkg_rank: rank });
    log.write(JSON.stringify({ rank, pkg, admit: repo }) + '\n');
    if (admitted.size % 50 === 0) console.log(`mapped ${admitted.size} repos at package rank ${rank}`);
  }
  log.end();
  const frame = [...admitted.values()];
  fs.writeFileSync('frame/frame.json', JSON.stringify(
    { seed: SEED, snapshot: '2026-08-01', source: 'hugovk/top-pypi-packages@e9354550 (FRAME3.md)', count: frame.length, repos: frame }, null, 1));
  const key = n => crypto.createHash('sha256').update(`${SEED}:${n}`).digest('hex');
  const order = frame.map(r => r.repo).sort((a, b) => key(a) < key(b) ? -1 : 1);
  fs.writeFileSync('frame/walk-order.json', JSON.stringify({ seed: SEED, order }, null, 1));
  console.log(`frame3: ${frame.length} repos; walk order written; first 5: ${order.slice(0, 5).join(', ')}`);
})();
EOF
