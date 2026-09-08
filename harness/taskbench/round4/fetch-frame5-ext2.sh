#!/usr/bin/env bash
# FRAME5 amendment 2: append a SECOND newly mapped tail, taking the frame to 3,600.
#
# This is NOT `fetch-frame5-ext.sh` run again with a bigger target. Re-running the
# amendment-1 tool now would read today's pilot-dedup.json (901 repositories, grown
# from the 254 it used) and re-walk ranks 1,306..3,443 against that larger burn set,
# dropping the ~401 amendment-1 admits that have since been burnt — a DIFFERENT
# frame-ext.json, so the frozen 2,000 prefix would no longer be byte-identical. That
# is forbidden. Amendment 2 instead RESUMES beyond amendment 1 (at the rank its ext
# mapping stopped, 3,443) and writes NEW files, leaving every amendment-1 artefact
# byte-for-byte on disk.
#
# Identical rules to FRAME5.md / amendment 1: same pinned snapshot
# (hugovk/top-pypi-packages@6becf8c3, frame/top-pypi-packages.min.json), same PyPI
# project-URL resolution, same github.com-only normalisation, same monorepo dedup,
# same append-by-keyed-shuffle under the unchanged seeds. The dedup pre-seed is
# extended by EVERY repository already in the frame (the original 500 AND the
# amendment-1 tail of 1,500) and EVERY repository in frame/pilot-dedup.json, so the
# new tail cannot duplicate anything already in the frame or anything burnt.
#
# Outputs (all NEW — nothing already frozen is written):
#   frame/frame-ext2.json, frame/mapping-log-ext2.jsonl,
#   frame/walk-order-ext2.json, frame/pilot-walk-order-ext2.json
set -euo pipefail
cd "$(dirname "$0")"
TARGET_TOTAL="${TB_TARGET_TOTAL:-3600}"

node - "$TARGET_TOTAL" <<'EOF'
const fs = require('fs'), crypto = require('crypto');
const TARGET_TOTAL = +process.argv[2];
const SEED = 'taskbench-v4-2026-09-03';           // unchanged from freeze 1 / amendment 1
const { rows } = JSON.parse(fs.readFileSync('frame/top-pypi-packages.min.json', 'utf8'));
const orig  = JSON.parse(fs.readFileSync('frame/frame.json', 'utf8'));        // round-4 500
const ext1  = JSON.parse(fs.readFileSync('frame/frame-ext.json', 'utf8'));    // amendment-1 1,500
const burnt = JSON.parse(fs.readFileSync('frame/pilot-dedup.json', 'utf8'));  // 901, current
const round1 = JSON.parse(fs.readFileSync('../frame/frame.json', 'utf8'));
const round2 = JSON.parse(fs.readFileSync('../round2/frame/frame.json', 'utf8'));
const round3 = JSON.parse(fs.readFileSync('../round3/frame/frame.json', 'utf8'));
const DEVDATA = ['honojs/hono','nestjs/nest','facebook/docusaurus','immerjs/immer',
  'jestjs/jest','prettier/prettier','colinhacks/zod','pmndrs/zustand'];

// Resume where AMENDMENT 1's ext mapping stopped: the highest rank in the ext log.
let resumeFrom = 0;
for (const l of fs.readFileSync('frame/mapping-log-ext.jsonl','utf8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l).rank; if (r > resumeFrom) resumeFrom = r;
}
const CURRENT_TOTAL = orig.count + ext1.count;   // 500 + 1500 = 2000, the frozen frame
const NEED = TARGET_TOTAL - CURRENT_TOTAL;        // 3600 - 2000 = 1600
console.log(`frozen frame ${CURRENT_TOTAL}; resuming at rank ${resumeFrom+1}; admitting ${NEED} more (target ${TARGET_TOTAL})`);

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
  for (const r of orig.repos) seen.set(lc(r.repo), 'original_frame');   // the frozen 500 prefix
  for (const r of ext1.repos) seen.set(lc(r.repo), 'ext1_frame');       // the amendment-1 1,500 tail
  for (const r of burnt.repos) seen.set(lc(r), 'burnt');                // D3 + all pilot iterations
  const admitted = new Map();
  const log = fs.createWriteStream('frame/mapping-log-ext2.jsonl');
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
    if (prior) {
      const tag = prior==='original_frame' ? 'original_frame_dedup'
                : prior==='ext1_frame'     ? 'ext1_frame_dedup'
                : prior==='burnt'          ? 'burnt_dedup'
                : prior+'_dedup';
      log.write(JSON.stringify({rank,pkg,skip:tag,repo})+'\n'); continue;
    }
    seen.set(lc(repo),'ext2');
    admitted.set(repo,{repo,first_pkg:pkg,pkg_rank:rank});
    log.write(JSON.stringify({rank,pkg,admit:repo})+'\n');
    if (admitted.size % 100 === 0) console.log(`  admitted ${admitted.size}/${NEED} at package rank ${rank}`);
  }
  log.end();
  const ext = [...admitted.values()];
  const endRank = ext.length ? ext[ext.length-1].pkg_rank : resumeFrom;
  fs.writeFileSync('frame/frame-ext2.json', JSON.stringify(
    {amendment:'FRAME5-AMENDMENT-2.md', seed:SEED, snapshot:'2026-09-01',
     source:'hugovk/top-pypi-packages@6becf8c3', resumed_at_rank:resumeFrom+1,
     ended_at_rank:endRank, count:ext.length, total_frame:CURRENT_TOTAL+ext.length, repos:ext}, null, 1));

  // Walks EXTEND by appending: the amendment-1 extended order is the prefix, unchanged.
  const appendWalk = (frozenFile, outFile, seed) => {
    const frozen = JSON.parse(fs.readFileSync(frozenFile,'utf8'));
    const key = n => crypto.createHash('sha256').update(`${seed}:${n}`).digest('hex');
    const tail = ext.map(r=>r.repo).sort((a,b)=> key(a) < key(b) ? -1 : 1);
    const order = [...frozen.order, ...tail];
    fs.writeFileSync(outFile, JSON.stringify(
      {seed, derivation:`${frozenFile} unchanged as the prefix, amendment-2 repositories appended in keyed order (FRAME5-AMENDMENT-2.md)`,
       prefix_count:frozen.order.length, appended:tail.length, count:order.length, order}, null, 1));
    return order.length;
  };
  const c = appendWalk('frame/walk-order-ext.json','frame/walk-order-ext2.json',SEED);
  const p = appendWalk('frame/pilot-walk-order-ext.json','frame/pilot-walk-order-ext2.json',`${SEED}-pilot`);
  console.log(`frame-ext2: ${ext.length} appended (ranks ${resumeFrom+1}..${endRank}); total ${CURRENT_TOTAL+ext.length}; counted walk ${c}; pilot walk ${p}`);
})();
EOF
