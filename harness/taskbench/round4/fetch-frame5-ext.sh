#!/usr/bin/env bash
# FRAME5 amendment 1: append a newly mapped tail to the round-4 frame.
#
# Preserves everything already frozen. frame.json, walk-order.json and
# pilot-walk-order.json are READ, never written. Mapping resumes at the ranked
# position where the original build stopped, under identical rules, with the
# original 500 and the 254 burnt repositories added to the dedup pre-seed.
# Outputs: frame/frame-ext.json, frame/mapping-log-ext.jsonl,
#          frame/walk-order-ext.json, frame/pilot-walk-order-ext.json
set -euo pipefail
cd "$(dirname "$0")"
TARGET_TOTAL="${TB_TARGET_TOTAL:-2000}"

node - "$TARGET_TOTAL" <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const TARGET_TOTAL = +process.argv[2];
const SEED = 'taskbench-v4-2026-09-03';           // unchanged from freeze 1
const { rows } = JSON.parse(fs.readFileSync('frame/top-pypi-packages.min.json', 'utf8'));
const orig = JSON.parse(fs.readFileSync('frame/frame.json', 'utf8'));
const burnt = JSON.parse(fs.readFileSync('frame/pilot-dedup.json', 'utf8'));
const round1 = JSON.parse(fs.readFileSync('../frame/frame.json', 'utf8'));
const round2 = JSON.parse(fs.readFileSync('../round2/frame/frame.json', 'utf8'));
const round3 = JSON.parse(fs.readFileSync('../round3/frame/frame.json', 'utf8'));
const DEVDATA = ['honojs/hono','nestjs/nest','facebook/docusaurus','immerjs/immer',
  'jestjs/jest','prettier/prettier','colinhacks/zod','pmndrs/zustand'];

// Resume where the original build stopped: the highest rank it logged.
let resumeFrom = 0;
for (const l of fs.readFileSync('frame/mapping-log.jsonl','utf8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l).rank; if (r > resumeFrom) resumeFrom = r;
}
const NEED = TARGET_TOTAL - orig.count;
console.log(`original frame ${orig.count}; resuming at rank ${resumeFrom+1}; admitting ${NEED} more`);

const normalize = u => { if (!u) return null;
  const m = String(u).match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : null; };
const lc = r => r.toLowerCase();

(async () => {
  const seen = new Map();
  for (const r of round1.repos) seen.set(lc(r.repo), 'spent');
  for (const r of round2.repos) seen.set(lc(r.repo), 'spent');
  for (const r of round3.repos) seen.set(lc(r.repo), 'spent');
  for (const r of DEVDATA) seen.set(lc(r), 'devdata');
  for (const r of orig.repos) seen.set(lc(r.repo), 'original_frame');  // never duplicate the prefix
  for (const r of burnt.repos) seen.set(lc(r), 'burnt');               // D3 development data
  const admitted = new Map();
  const log = fs.createWriteStream('frame/mapping-log-ext.jsonl');
  let rank = 0;
  for (const row of rows) {
    rank++;
    if (rank <= resumeFrom) continue;
    if (admitted.size >= NEED) break;
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
    if (err) { log.write(JSON.stringify({rank,pkg,skip:'registry_error',err})+'\n'); continue; }
    if (!repo) { log.write(JSON.stringify({rank,pkg,skip:'no_github_repo'})+'\n'); continue; }
    const prior = seen.get(lc(repo));
    if (prior) { log.write(JSON.stringify({rank,pkg,skip:prior==='original_frame'?'original_frame_dedup':prior==='burnt'?'burnt_dedup':prior+'_dedup',repo})+'\n'); continue; }
    seen.set(lc(repo),'ext');
    admitted.set(repo,{repo,first_pkg:pkg,pkg_rank:rank});
    log.write(JSON.stringify({rank,pkg,admit:repo})+'\n');
    if (admitted.size % 100 === 0) console.log(`  admitted ${admitted.size}/${NEED} at package rank ${rank}`);
  }
  log.end();
  const ext = [...admitted.values()];
  fs.writeFileSync('frame/frame-ext.json', JSON.stringify(
    {amendment:'FRAME5-AMENDMENT-1.md', seed:SEED, snapshot:'2026-09-01',
     source:'hugovk/top-pypi-packages@6becf8c3', resumed_at_rank:resumeFrom+1,
     count:ext.length, total_frame:orig.count+ext.length, repos:ext}, null, 1));

  // Walks EXTEND by appending: the frozen order is the prefix, unchanged.
  const appendWalk = (frozenFile, outFile, seed) => {
    const frozen = JSON.parse(fs.readFileSync(frozenFile,'utf8'));
    const key = n => crypto.createHash('sha256').update(`${seed}:${n}`).digest('hex');
    const tail = ext.map(r=>r.repo).sort((a,b)=> key(a) < key(b) ? -1 : 1);
    const order = [...frozen.order, ...tail];
    fs.writeFileSync(outFile, JSON.stringify(
      {seed, derivation:`${frozenFile} unchanged as the prefix, newly admitted repositories appended in keyed order (FRAME5-AMENDMENT-1.md)`,
       prefix_count:frozen.order.length, appended:tail.length, count:order.length, order}, null, 1));
    return order.length;
  };
  const c = appendWalk('frame/walk-order.json','frame/walk-order-ext.json',SEED);
  const p = appendWalk('frame/pilot-walk-order.json','frame/pilot-walk-order-ext.json',`${SEED}-pilot`);
  console.log(`frame-ext: ${ext.length} appended; total ${orig.count+ext.length}; counted walk ${c}; pilot walk ${p}`);
})();
EOF
