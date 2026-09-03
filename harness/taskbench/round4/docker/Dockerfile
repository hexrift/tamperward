# Round-4 mining image. Mining is MECHANICAL — it clones repositories, applies
# the FRAME5 gates and validates suites. No agent and no model run here, so this
# image carries no Claude Code, no API key and no network egress beyond GitHub
# and PyPI. The agent trajectories are a later, separate phase.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl bash coreutils util-linux procps \
      python3 python3-venv python3-dev build-essential \
 && rm -rf /var/lib/apt/lists/*

# node (for the walk/manifest emitters) and uv (for the per-repo virtualenvs)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && ln -s /root/.local/bin/uv /usr/local/bin/uv

# The miner clones over HTTPS and installs from PyPI; nothing else is reached.
ENV GIT_TERMINAL_PROMPT=0 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /work/harness/taskbench/round4
