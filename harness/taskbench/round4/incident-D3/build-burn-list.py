#!/usr/bin/env python3
"""Regenerate and CHECK frame/pilot-dedup.json from the preserved incident evidence.

The burn rule (FRAME5.md) makes a repository development data the moment the
pilot draws it — including repositories attrited or abandoned mid-processing,
which may have no ledger line at all. The burn set is therefore:

    every repo in a shard log's [walk] entries   UNION   every repo named in any
    pre-purge or post-purge pilot ledger

Run with --check to verify the committed list still matches the evidence.
"""
import json, re, glob, sys, os
os.chdir(os.path.join(os.path.dirname(__file__), '..'))
order = json.load(open('frame/pilot-walk-order.json'))['order']
rank = {r.lower(): i for i, r in enumerate(order)}
burn = {}
for f in glob.glob('incident-D3/mine-pilot-s*.log'):
    for l in open(f, errors='ignore'):
        m = re.search(r'\[walk\] (\S+)', l)
        if m: burn.setdefault(m.group(1).lower(), m.group(1))
for f in glob.glob('incident-D3/pre-purge-ledgers/*.jsonl') + glob.glob('pools/pilot*/attrition.jsonl'):
    for l in open(f, errors='ignore'):
        try: d = json.loads(l)
        except Exception: continue
        if d.get('repo'): burn.setdefault(d['repo'].lower(), d['repo'])
repos = sorted(burn.values(), key=lambda r: rank.get(r.lower(), 10**9))
ranks = [rank[r.lower()] for r in repos if r.lower() in rank]
out = {"rule": "FRAME5.md provenance: a repository becomes development data the moment the pilot draws it. Every repository the pilot walk STARTED is burnt, whether or not it reached a terminal verdict.",
       "source": "shard [walk] entries UNION every repo named in any pilot ledger (pre- or post-purge)",
       "generated_by": "incident-D3/build-burn-list.py",
       "count": len(repos), "max_rank_reached": max(ranks) if ranks else None,
       "frontier_depth": (max(ranks) + 1) if ranks else 0, "of_frame": len(order), "repos": repos}
if '--check' in sys.argv:
    cur = json.load(open('frame/pilot-dedup.json'))
    same = sorted(x.lower() for x in cur['repos']) == sorted(x.lower() for x in repos)
    print(("MATCH" if same else "MISMATCH") + f": committed {cur['count']}, regenerated {len(repos)}")
    sys.exit(0 if same else 1)
json.dump(out, open('frame/pilot-dedup.json', 'w'), indent=1)
print(f"burnt {len(repos)}; frontier depth {out['frontier_depth']} of {len(order)}")
