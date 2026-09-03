#!/usr/bin/env bash
# Taskbench round 4: build frame5 per FRAME5.md — map the pinned
# top-pypi-packages snapshot (rank 1..15000) to GitHub repos via the PyPI
# JSON API, with the round-1/2/3 frame repos and the enumerated
# development-data set pre-seeded into dedup (case-insensitive). Round 3.1
# reused round 3's pairs, so round 3's frame covers it.
# Pilot repositories are added to `frame/pilot-dedup.json` as they are drawn and
# are excluded here too — they are disclosed development data (FRAME5.md).
# Outputs: frame/frame.json, frame/walk-order.json, frame/mapping-log.jsonl.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p frame

node - <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const SEED = 'taskbench-v4-2026-09-03';
const TARGET = 500;
const { rows } = JSON.parse(fs.readFileSync('frame/top-pypi-packages.min.json', 'utf8'));
const round1 = JSON.parse(fs.readFileSync('../frame/frame.json', 'utf8'));
const round2 = JSON.parse(fs.readFileSync('../round2/frame/frame.json', 'utf8'));
const round3 = JSON.parse(fs.readFileSync('../round3/frame/frame.json', 'utf8'));
// FRAME2 corrections 1-2: repos that priced or tuned any shipped detector are
// development data, spent for validation pools. Enumerated set, frozen in FRAME3.md.
const DEVDATA = ['honojs/hono', 'nestjs/nest', 'facebook/docusaurus', 'immerjs/immer',
  'jestjs/jest', 'prettier/prettier', 'colinhacks/zod', 'pmndrs/zustand'];
// Pilot repositories are burnt on draw (FRAME5.md); the file may not exist yet.
let PILOT = [];
try { PILOT = JSON.parse(fs.readFileSync('frame/pilot-dedup.json', 'utf8')).repos || []; } catch {}

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
  for (const r of round3.repos) seen.set(lc(r.repo), 'spent');
  for (const r of DEVDATA) seen.set(lc(r), 'devdata');
  for (const r of PILOT) seen.set(lc(r), 'pilot');
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
    if (prior === 'pilot') { log.write(JSON.stringify({ rank, pkg, skip: 'pilot_dedup', repo }) + '\n'); continue; }
    if (prior) { log.write(JSON.stringify({ rank, pkg, skip: 'monorepo_dedup', repo }) + '\n'); continue; }
    seen.set(lc(repo), 'round4');
    admitted.set(repo, { repo, first_pkg: pkg, pkg_rank: rank });
    log.write(JSON.stringify({ rank, pkg, admit: repo }) + '\n');
    if (admitted.size % 50 === 0) console.log(`mapped ${admitted.size} repos at package rank ${rank}`);
  }
  log.end();
  const frame = [...admitted.values()];
  fs.writeFileSync('frame/frame.json', JSON.stringify(
    { seed: SEED, snapshot: '2026-09-01', source: 'hugovk/top-pypi-packages@6becf8c3 (FRAME5.md)', count: frame.length, repos: frame }, null, 1));
  const key = n => crypto.createHash('sha256').update(`${SEED}:${n}`).digest('hex');
  const order = frame.map(r => r.repo).sort((a, b) => key(a) < key(b) ? -1 : 1);
  fs.writeFileSync('frame/walk-order.json', JSON.stringify({ seed: SEED, order }, null, 1));
  // The PILOT walk is a distinct keyed shuffle of the SAME frame, so the counted
  // walk is untouched by what the pilot draws (PILOT4.md).
  const pkey = n => crypto.createHash('sha256').update(`${SEED}-pilot:${n}`).digest('hex');
  const porder = frame.map(r => r.repo).sort((a, b) => pkey(a) < pkey(b) ? -1 : 1);
  fs.writeFileSync('frame/pilot-walk-order.json', JSON.stringify({ seed: `${SEED}-pilot`, order: porder }, null, 1));
  console.log(`frame5: ${frame.length} repos; walk orders written; first 5 counted: ${order.slice(0, 5).join(', ')}`);
})();
EOF
