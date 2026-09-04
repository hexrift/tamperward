#!/usr/bin/env python3
"""Regenerate and CHECK the pilot burn set from preserved evidence.

The burn rule (FRAME5.md) makes a repository development data the moment the
pilot draws it — including repositories attrited or abandoned mid-processing,
which may have no ledger line at all. Two sets follow from that rule, and they
are NOT the same shape:

  * the D3 INCIDENT set, `incident-D3/burnt-254.json` — the 254 repositories the
    failed mining episode burnt. Reconstructed from incident evidence alone
    (shard `[walk]` entries UNION every repo named in a pre-purge ledger). It is
    history: frozen, and it must regenerate byte-for-byte for ever.

  * the CUMULATIVE set, `frame/pilot-dedup.json` — the incident set UNION every
    repository the live pilot has since drawn. It GROWS while the pilot runs, by
    design; the counted frame applies its final value (`pilot_dedup`) before the
    counted draw.

Asserting the cumulative set is constant is therefore wrong, and cost a false
selftest failure once: the resumed pilot had legitimately burnt 12 more
repositories. What is invariant is that the incident set still regenerates and
that nothing ever LEAVES the burn set — no repository is un-burnt.

  --check            verify both invariants (the check the selftest runs)
  --write-incident   (re)write the frozen incident file; run only to establish it
  (no flag)          publish the cumulative set to frame/pilot-dedup.json
"""
import json, re, glob, sys, os

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
INCIDENT = 'incident-D3/burnt-254.json'
CUMULATIVE = 'frame/pilot-dedup.json'

order = json.load(open('frame/pilot-walk-order.json'))['order']
rank = {r.lower(): i for i, r in enumerate(order)}


def sort_repos(burn):
    return sorted(burn.values(), key=lambda r: rank.get(r.lower(), 10**9))


def envelope(repos, rule, source):
    ranks = [rank[r.lower()] for r in repos if r.lower() in rank]
    return {"rule": rule, "source": source,
            "generated_by": "incident-D3/build-burn-list.py",
            "count": len(repos), "max_rank_reached": max(ranks) if ranks else None,
            "frontier_depth": (max(ranks) + 1) if ranks else 0,
            "of_frame": len(order), "repos": repos}


def incident_set():
    """The D3 episode's burn set, from incident evidence only."""
    burn = {}
    for f in sorted(glob.glob('incident-D3/mine-pilot-s*.log')):
        for l in open(f, errors='ignore'):
            m = re.search(r'\[walk\] (\S+)', l)
            if m:
                burn.setdefault(m.group(1).lower(), m.group(1))
    for f in sorted(glob.glob('incident-D3/pre-purge-ledgers/*.jsonl')):
        for l in open(f, errors='ignore'):
            try:
                d = json.loads(l)
            except Exception:
                continue
            if d.get('repo'):
                burn.setdefault(d['repo'].lower(), d['repo'])
    return sort_repos(burn)


def cumulative_set():
    """The incident set plus everything the live pilot has drawn since."""
    burn = {r.lower(): r for r in incident_set()}
    for f in sorted(glob.glob('pools/pilot*/attrition.jsonl')):
        for l in open(f, errors='ignore'):
            try:
                d = json.loads(l)
            except Exception:
                continue
            if d.get('repo'):
                burn.setdefault(d['repo'].lower(), d['repo'])
    return sort_repos(burn)


INCIDENT_RULE = (
    "FRAME5.md provenance: a repository becomes development data the moment the "
    "pilot draws it. This is the D3 episode's own burn set — every repository "
    "that failed mining run STARTED, whether or not it reached a terminal "
    "verdict. Frozen history: it never changes.")
INCIDENT_SOURCE = ("incident-D3 shard [walk] entries UNION every repo named in a "
                   "pre-purge ledger; no live ledger is consulted")
CUMULATIVE_RULE = (
    "FRAME5.md provenance: a repository becomes development data the moment the "
    "pilot draws it. This is the pilot's full exclusion set — the D3 incident "
    "burn plus every repository the live pilot has since drawn. It grows while "
    "the pilot runs; its final value is the counted frame's pilot_dedup.")
CUMULATIVE_SOURCE = ("incident-D3/burnt-254.json UNION every repo named in a live "
                     "pilot ledger (pools/pilot*/attrition.jsonl)")

# Argument validation, BEFORE anything can write. An unrecognised flag used to be
# ignored, so `--help` fell through to the default branch and REPUBLISHED the
# cumulative burn set — an informational flag silently mutating registered state.
# The write it performed was deterministic and correct, so nothing was corrupted,
# but "harmless this time" is not a property to rely on before counted mining.
# Now: --help/-h prints this module's docstring and writes nothing, and ANY
# unrecognised argument refuses outright rather than falling through to a write.
KNOWN_FLAGS = {'--check', '--write-incident'}
if '--help' in sys.argv[1:] or '-h' in sys.argv[1:]:
    print(__doc__ or '')
    sys.exit(0)
unknown = [a for a in sys.argv[1:] if a not in KNOWN_FLAGS]
if unknown:
    print(f"REFUSING: unrecognised argument(s): {' '.join(unknown)}", file=sys.stderr)
    print(f"  known flags: {' '.join(sorted(KNOWN_FLAGS))}; no arguments republishes "
          f"the cumulative burn set.", file=sys.stderr)
    sys.exit(2)

if '--write-incident' in sys.argv:
    repos = incident_set()
    json.dump(envelope(repos, INCIDENT_RULE, INCIDENT_SOURCE), open(INCIDENT, 'w'), indent=1)
    print(f"incident burn set: {len(repos)} repositories -> {INCIDENT}")
    sys.exit(0)

if '--check' in sys.argv:
    ok = True
    inc = incident_set()
    frozen = json.load(open(INCIDENT))
    same = sorted(x.lower() for x in frozen['repos']) == sorted(x.lower() for x in inc)
    print(("MATCH" if same else "MISMATCH") +
          f": D3 incident set — frozen {frozen['count']}, regenerated {len(inc)}")
    ok &= same
    cum = {x.lower() for x in cumulative_set()}
    published = json.load(open(CUMULATIVE))
    pub = {x.lower() for x in published['repos']}
    lost = sorted(pub - cum)
    if lost:
        print(f"UN-BURNT: {len(lost)} repositories left the burn set: {lost[:5]}")
        ok = False
    else:
        print(f"MONOTONE: cumulative set {len(cum)}, published {len(pub)}, "
              f"{len(cum) - len(pub)} drawn since the last publish")
    sys.exit(0 if ok else 1)

repos = cumulative_set()
json.dump(envelope(repos, CUMULATIVE_RULE, CUMULATIVE_SOURCE), open(CUMULATIVE, 'w'), indent=1)
print(f"burnt {len(repos)}; frontier depth {envelope(repos, '', '')['frontier_depth']} of {len(order)}")
