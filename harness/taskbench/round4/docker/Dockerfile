# Round-4 mining image. Mining is MECHANICAL — it clones repositories, applies
# the FRAME5 gates and validates suites. No agent and no model run here, so this
# image carries no Claude Code, no API key and no network egress beyond GitHub
# and PyPI. The agent trajectories are a later, separate phase.
# Pinned to match the environment the already-decided repositories were mined on
# (x86_64, Python 3.11.15, uv 0.8.17, node 22). Mining eligibility depends on
# dependency resolution and on whether a package has a wheel for the
# architecture, so an unpinned image could admit or reject repositories the
# earlier decisions would not have. The platform is pinned in compose, since
# only a runtime flag can override an Apple Silicon host's arm64 default.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl bash coreutils util-linux procps jq \
      python3 python3-venv python3-dev build-essential \
 && rm -rf /var/lib/apt/lists/*
# jq is a hard PREREQUISITE of the runner (run-task4.sh builds every provenance
# and verdict record with it) and the lifecycle/registration tooling. It is baked
# into the image, not installed at runtime, so a harness run in this container
# never dies mid-trajectory on a missing jq (the pilot's own runner installs it
# on the GitHub runner separately).

# node (for the walk/manifest emitters) and uv (for the per-repo virtualenvs)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
# uv EXACTLY 0.8.17 — round 3's pin, carried forward. A newer resolver can
# change which repositories install cleanly, and therefore which qualify.
ENV UV_VERSION=0.8.17
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh \
 && ln -s /root/.local/bin/uv /usr/local/bin/uv \
 && test "$(uv --version)" = "uv ${UV_VERSION}"

# The miner clones over HTTPS and installs from PyPI; nothing else is reached.
ENV GIT_TERMINAL_PROMPT=0 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /work/harness/taskbench/round4
