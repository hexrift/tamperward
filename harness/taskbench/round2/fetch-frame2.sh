#!/usr/bin/env bash
# Taskbench round 2: build frame2 per FRAME2.md — tranche continuation of the
# pinned npm-high-impact@1.13.0 list from package rank 608, round-1 repos
# pre-seeded for dedup. Outputs: frame/frame.json, frame/walk-order.json,
# frame/mapping-log.jsonl (round-2's own copies, under round2/).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p frame

node - <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const SEED = 'taskbench-v2-2026-08-30';
const TARGET = 500;
const START_RANK = 608; // round 1 consumed ranks 1..607 (../frame/mapping-log.jsonl)
const { packages } = JSON.parse(fs.readFileSync('../frame/npm-high-impact.json', 'utf8'));
const round1 = JSON.parse(fs.readFileSync('../frame/frame.json', 'utf8'));

const normalize = (u) => {
  if (!u) return null;
  const m = String(u).match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
};

(async () => {
  const seen = new Map();
  for (const r of round1.repos) seen.set(r.repo, 'round1'); // spent repos never re-enter
  const admitted = new Map();
  const log = fs.createWriteStream('frame/mapping-log.jsonl');
  let rank = 0;
  for (const pkg of packages) {
    rank++;
    if (rank < START_RANK) continue;
    if (admitted.size >= TARGET) break;
    let repo = null, err = null;
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40','@')}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' } });
      if (!res.ok) throw new Error(`http ${res.status}`);
      let doc = await res.json();
      let url = doc.repository && (doc.repository.url || doc.repository);
      if (!url) {
        const res2 = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40','@')}`);
        doc = await res2.json();
        url = doc.repository && (doc.repository.url || doc.repository);
      }
      repo = normalize(url);
    } catch (e) { err = String(e.message || e); }
    if (err) { log.write(JSON.stringify({ rank, pkg, skip: 'registry_error', err }) + '\n'); continue; }
    if (!repo) { log.write(JSON.stringify({ rank, pkg, skip: 'no_github_repo' }) + '\n'); continue; }
    if (seen.get(repo) === 'round1') { log.write(JSON.stringify({ rank, pkg, skip: 'round1_dedup', repo }) + '\n'); continue; }
    if (seen.has(repo)) { log.write(JSON.stringify({ rank, pkg, skip: 'monorepo_dedup', repo }) + '\n'); continue; }
    seen.set(repo, 'round2');
    admitted.set(repo, { repo, first_pkg: pkg, pkg_rank: rank });
    log.write(JSON.stringify({ rank, pkg, admit: repo }) + '\n');
    if (admitted.size % 50 === 0) console.log(`mapped ${admitted.size} repos at package rank ${rank}`);
  }
  log.end();
  const frame = [...admitted.values()];
  fs.writeFileSync('frame/frame.json', JSON.stringify(
    { seed: SEED, snapshot: '2026-08-30', source: 'npm-high-impact@1.13.0 tranche from rank 608 (FRAME2.md)', count: frame.length, repos: frame }, null, 1));
  const key = n => crypto.createHash('sha256').update(`${SEED}:${n}`).digest('hex');
  const order = frame.map(r => r.repo).sort((a, b) => key(a) < key(b) ? -1 : 1);
  fs.writeFileSync('frame/walk-order.json', JSON.stringify({ seed: SEED, order }, null, 1));
  console.log(`frame2: ${frame.length} repos; walk order written; first 5: ${order.slice(0, 5).join(', ')}`);
})();
EOF
