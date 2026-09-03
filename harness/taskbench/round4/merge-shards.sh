#!/usr/bin/env bash
# Merge sharded mining back into one pool, preserving the registered walk order.
# The pool's tasks are the first N validated repositories in ORIGINAL walk
# order — identical to a sequential walk's output, whatever order the shards
# happened to finish in.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
POOL="${1:-pilot}"; WORKERS="${2:-4}"; NEED="${3:-10}"
DEST="pools/$POOL"; mkdir -p "$DEST/tasks"
: > "$DEST/attrition.jsonl"
for i in $(seq 0 $((WORKERS-1))); do
  [ -f "pools/$POOL-s$i/attrition.jsonl" ] && cat "pools/$POOL-s$i/attrition.jsonl" >> "$DEST/attrition.jsonl"
done
node -e '
const fs=require("fs"),path=require("path");
const [pool,workers,need]=[process.argv[1],+process.argv[2],+process.argv[3]];
const order=JSON.parse(fs.readFileSync(`pools/${pool}/walk.json`)).order;
const rank=new Map(order.map((r,i)=>[r.toLowerCase(),i]));
const found=[];
for(let i=0;i<workers;i++){
  const td=`pools/${pool}-s${i}/tasks`;
  if(!fs.existsSync(td)) continue;
  for(const d of fs.readdirSync(td)){
    try{
      const m=JSON.parse(fs.readFileSync(`${td}/${d}/manifest.json`));
      found.push({dir:`${td}/${d}`,id:d,repo:m.repo,rank:rank.get(m.repo.toLowerCase()) ?? 1e9});
    }catch{}
  }
}
found.sort((a,b)=>a.rank-b.rank);
const chosen=found.slice(0,need);
for(const c of chosen){
  const dst=`pools/${pool}/tasks/${c.id}`;
  fs.mkdirSync(dst,{recursive:true});
  for(const f of fs.readdirSync(c.dir)) fs.copyFileSync(`${c.dir}/${f}`,`${dst}/${f}`);
}
console.log(`validated across shards: ${found.length}; selected first ${chosen.length} in walk order`);
for(const c of chosen) console.log(`  rank ${String(c.rank).padStart(4)}  ${c.repo}`);
if(found.length>chosen.length) console.log(`NOTE: ${found.length-chosen.length} validated beyond the need were NOT selected; they were examined during pilot mining and are pilot_dedup either way.`);
' "$POOL" "$WORKERS" "$NEED"
