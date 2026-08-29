#!/usr/bin/env bash
# Taskbench Phase 0: snapshot the eligible frame per FRAME.md.
# Source: npm-high-impact@1.13.0 (download-ranked package list), mapped to
# GitHub repositories via registry metadata. Outputs: frame/frame.json,
# frame/walk-order.json, frame/mapping-log.jsonl, frame/npm-high-impact.json.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p frame /tmp/tb-frame

if [ ! -s frame/npm-high-impact.json ]; then
  ( cd /tmp/tb-frame && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund npm-high-impact@1.13.0 >/dev/null 2>&1 )
  node - <<'EOF'
const fs = require('fs');
(async () => {
  const m = await import('/tmp/tb-frame/node_modules/npm-high-impact/index.js');
  const list = m.npmHighImpact;
  fs.writeFileSync('frame/npm-high-impact.json',
    JSON.stringify({ source: 'npm-high-impact@1.13.0', count: list.length, packages: list }, null, 1));
  console.log(`package list: ${list.length} packages`);
})();
EOF
fi

node - <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const SEED = 'taskbench-v1-2026-08-29';
const TARGET = 500;
const { packages } = JSON.parse(fs.readFileSync('frame/npm-high-impact.json', 'utf8'));

const normalize = (u) => {
  if (!u) return null;
  const m = String(u).match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
};

(async () => {
  const seen = new Map(); // repo -> {repo, first_pkg, rank}
  const log = fs.createWriteStream('frame/mapping-log.jsonl');
  let rank = 0;
  for (const pkg of packages) {
    rank++;
    if (seen.size >= TARGET) break;
    let repo = null, err = null;
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40','@')}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' } });
      if (!res.ok) throw new Error(`http ${res.status}`);
      // abbreviated doc lacks repository; fall back to full doc only if needed
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
    if (seen.has(repo)) { log.write(JSON.stringify({ rank, pkg, skip: 'monorepo_dedup', repo }) + '\n'); continue; }
    seen.set(repo, { repo, first_pkg: pkg, pkg_rank: rank });
    log.write(JSON.stringify({ rank, pkg, admit: repo }) + '\n');
    if (seen.size % 50 === 0) console.log(`mapped ${seen.size} repos at package rank ${rank}`);
  }
  log.end();
  const frame = [...seen.values()];
  fs.writeFileSync('frame/frame.json', JSON.stringify(
    { seed: SEED, snapshot: '2026-08-29', source: 'npm-high-impact@1.13.0', count: frame.length, repos: frame }, null, 1));
  const key = n => crypto.createHash('sha256').update(`${SEED}:${n}`).digest('hex');
  const order = frame.map(r => r.repo).sort((a, b) => key(a) < key(b) ? -1 : 1);
  fs.writeFileSync('frame/walk-order.json', JSON.stringify({ seed: SEED, order }, null, 1));
  console.log(`frame: ${frame.length} repos; walk order written; first 5: ${order.slice(0, 5).join(', ')}`);
})();
EOF
