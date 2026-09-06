#!/usr/bin/env python3
# THE ONE editable-liveness primitive. Shared, by design, between run-task4.sh's
# in-trajectory PRE_AGENT guard and the pre-freeze pool checker, so preflight and
# runtime enforce the SAME property (a divergence there is how preflight proves one
# thing and the trajectory another).
#
# It answers exactly one question, and nothing else: would a source edit the agent
# makes in the writable repository tree be LIVE — reflected by a fresh interpreter,
# in the agent-visible environment, WITHOUT reinstalling the package?
#
# It does NOT check module.__file__ path equality. PEP 660 editable installs resolve
# the package through an import-hook finder whose __file__ is not under the repo, yet
# are fully live; a path-equality guard both FALSE-REJECTS those (iteration-2 task-04,
# pymatgen-io-validation, DEVIATIONS D16 Finding D) and would FALSE-ACCEPT a stale
# .pth pointing at a build copy. The real invariant is LIVE COUPLING, so this proves
# it by CONSTRUCTION rather than by inspecting paths:
#
#   1. discover the editable dist installed FROM this repo (PEP 610 direct_url)
#   2. take its top-level importable modules
#   3. pick a target by a DETERMINISTIC rule (first sorted module with a locatable
#      backing source file in the writable repo) — never chosen per repo by hand
#   4. record the backing file's original bytes + sha256
#   5. append a reversible sentinel assignment to that writable file
#   6. import the module in a FRESH interpreter (same python, cwd = repo, i.e. the
#      exact resolution the trajectory's suite runs under)
#   7. the fresh import must OBSERVE the sentinel
#   8. restore the file byte-for-byte
#   9. verify the restore (sha256 matches the original)
#  10. ANY inability to establish the coupling — no editable dist, no locatable
#      target, a fresh import that errors, a sentinel not observed, a restore that
#      does not verify — is LIVENESS_NOT_VERIFIED, never a pass.
#
# Usage:  <task-venv-python> editable-liveness.py <repo-dir>
# Output: a single status line, and exit code:
#   0  LIVE <module> via <backing-file>
#   1  LIVENESS_NOT_VERIFIED <reason>
# The sentinel is a plain module-level constant, so proving it observed requires only
# importing the module (which the suite does anyway), not executing any task-specific
# top-level behaviour.

import hashlib
import importlib.metadata as md
import json
import os
import pathlib
import subprocess
import sys

SENTINEL_NAME = "_TW_LIVENESS_SENTINEL"


def fail(reason):
    print("LIVENESS_NOT_VERIFIED " + reason)
    sys.exit(1)


def editable_dist_from_repo(repo):
    """The dist(s) installed as an editable of THIS repo, by PEP 610 direct_url."""
    out = []
    for dist in md.distributions():
        try:
            durl = dist.read_text("direct_url.json")
        except Exception:
            durl = None
        if not durl:
            continue
        try:
            j = json.loads(durl)
        except Exception:
            continue
        if not j.get("dir_info", {}).get("editable"):
            continue
        url = j.get("url", "")
        p = url[7:] if url.startswith("file://") else url
        try:
            if pathlib.Path(p).resolve() == repo:
                out.append(dist)
        except Exception:
            continue
    return out


def top_levels(dist):
    tops = [t for t in (dist.read_text("top_level.txt") or "").split() if t]
    if tops:
        return tops
    # Fallback: infer from RECORD's top-level packages (no top_level.txt in some
    # PEP 660 backends). A dir with __init__.py or a bare module at import root.
    names = set()
    try:
        for f in dist.files or []:
            parts = str(f).split("/")
            if not parts or parts[0].endswith(".dist-info") or parts[0].endswith(".egg-info"):
                continue
            if len(parts) >= 2 and parts[1] == "__init__.py":
                names.add(parts[0])
            elif len(parts) == 1 and parts[0].endswith(".py") and parts[0] != "__init__.py":
                names.add(parts[0][:-3])
    except Exception:
        pass
    return sorted(names)


def backing_file(repo, module):
    """The writable source file that backs `module`, by the deterministic layout
    rule. Flat package, src-layout package, or single-file module."""
    for rel in (
        os.path.join(module, "__init__.py"),
        os.path.join("src", module, "__init__.py"),
        module + ".py",
        os.path.join("src", module + ".py"),
    ):
        p = repo / rel
        if p.is_file():
            return p
    return None


def main():
    if len(sys.argv) != 2:
        print("usage: editable-liveness.py <repo-dir>", file=sys.stderr)
        sys.exit(2)
    repo = pathlib.Path(sys.argv[1]).resolve()
    if not repo.is_dir():
        fail("REPO_MISSING %s" % repo)

    dists = editable_dist_from_repo(repo)
    if not dists:
        fail("NO_EDITABLE_DIST installed from %s" % repo)

    # Deterministic target: first (sorted) top-level module, across the editable
    # dists in name order, that has a locatable writable backing file.
    target_mod = None
    target_file = None
    seen = []
    for dist in sorted(dists, key=lambda d: d.metadata["Name"] or ""):
        for mod in sorted(set(top_levels(dist))):
            seen.append(mod)
            bf = backing_file(repo, mod)
            if bf is not None:
                target_mod, target_file = mod, bf
                break
        if target_mod:
            break
    if target_mod is None:
        fail("NO_LOCATABLE_TARGET top_levels=%s" % ",".join(seen))

    original = target_file.read_bytes()
    orig_sha = hashlib.sha256(original).hexdigest()
    nonce = "tw-live-" + hashlib.sha256(os.urandom(16)).hexdigest()[:16]

    probe = "\n".join([
        "import sys",
        "try:",
        "    m = __import__(%r)" % target_mod,
        "except Exception as e:",
        "    sys.stderr.write('IMPORT_FAILED %s: %s\\n' % (type(e).__name__, e))",
        "    sys.exit(7)",
        "v = getattr(m, %r, None)" % SENTINEL_NAME,
        "sys.exit(0 if v == %r else 8)" % nonce,
    ])

    try:
        # Append the sentinel to the writable repo source (reversible).
        with open(target_file, "ab") as fh:
            fh.write(("\n%s = %r\n" % (SENTINEL_NAME, nonce)).encode())
        # Fresh interpreter, agent-visible env, cwd = repo (the suite's resolution).
        r = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=str(repo),
            capture_output=True,
            text=True,
        )
    finally:
        # Restore byte-for-byte, always.
        target_file.write_bytes(original)

    if hashlib.sha256(target_file.read_bytes()).hexdigest() != orig_sha:
        fail("RESTORE_FAILED %s" % target_file)

    if r.returncode == 0:
        print("LIVE %s via %s" % (target_mod, target_file.relative_to(repo)))
        sys.exit(0)
    if r.returncode == 7:
        fail("FRESH_IMPORT_FAILED %s (%s)" % (target_mod, (r.stderr or "").strip()[:160]))
    if r.returncode == 8:
        fail("SENTINEL_NOT_OBSERVED %s imports a static copy, not %s" % (target_mod, target_file.relative_to(repo)))
    fail("PROBE_RC_%d %s" % (r.returncode, (r.stderr or "").strip()[:160]))


if __name__ == "__main__":
    main()
