// Trusted verifier execution backends.
//
// The local backend preserves the historical same-host verifier and reports that
// weaker trust level explicitly. The container backend establishes a separate
// execution domain for a FROZEN candidate: immutable image identity, immutable
// verifier input, no network, no shared dependency/home/temp/socket/cache.
//
// Docker is deliberately the first supported engine. Podman can implement the
// same interface later, but it is not accepted until its client/storage
// authority has equivalent tests.

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Policy } from './types';

export type VerifierBackendKind = 'local' | 'container';
export type VerifierBackendTrust = 'checkpointed-local' | 'isolated-container';
export type ContainerEngine = 'docker';

export interface PreparedVerifierBackend {
  kind: VerifierBackendKind;
  trust: VerifierBackendTrust;
  available: boolean;
  image?: string;
  engine?: ContainerEngine;
  enginePath?: string;
  engineSha256?: string;
  daemonHost?: string;
  reason?: string;
}

export interface BackendRunResult {
  exit: number | null;
  secs: number;
  failure?: 'budget' | 'backend';
  reason?: string;
}

const DIGEST_IMAGE = /^(?!-)[^\s@]+@sha256:[0-9a-f]{64}$/i;
const DEFAULT_DOCKER_HOST = 'unix:///var/run/docker.sock';

function identity(): { uid: number | null; groups: number[] } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  return { uid, groups };
}

function writableByCaller(path: string): boolean {
  try {
    const st = statSync(path);
    const { uid, groups } = identity();
    // A root caller can rewrite any ordinary host executable. That is not a
    // separation boundary for a same-identity agent, so refuse it.
    if (uid === 0) return true;
    if ((st.mode & 0o002) !== 0) return true;
    if (uid !== null && st.uid === uid && (st.mode & 0o200) !== 0) return true;
    if (groups.includes(st.gid) && (st.mode & 0o020) !== 0) return true;
    return false;
  } catch {
    return true;
  }
}

function replaceableByCaller(path: string): boolean {
  // An immutable file in a caller-writable directory is still replaceable by
  // rename/unlink. Check the real target and every ancestor directory.
  let current = resolve(path);
  if (writableByCaller(current)) return true;
  current = dirname(current);
  while (true) {
    if (writableByCaller(current)) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function findExecutable(name: string): string | null {
  for (const raw of (process.env.PATH ?? '').split(delimiter)) {
    if (!raw) continue; // never resolve from cwd implicitly
    const candidate = join(raw, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // keep looking
    }
  }
  return null;
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function engineClientEnv(): NodeJS.ProcessEnv {
  // No caller HOME, Docker config/context, DOCKER_HOST, credential-helper or
  // dynamic-loader variables cross this client boundary. --host is explicit.
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function dockerArgs(host: string, args: string[]): string[] {
  return ['--host', host, ...args];
}

function dockerAvailable(enginePath: string, host: string): boolean {
  try {
    const r = spawnSync(enginePath, dockerArgs(host, ['version']), {
      stdio: 'ignore',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      env: engineClientEnv(),
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function imagePresent(enginePath: string, host: string, image: string): boolean {
  try {
    const r = spawnSync(enginePath, dockerArgs(host, ['image', 'inspect', image]), {
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: engineClientEnv(),
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function engineStable(backend: PreparedVerifierBackend): boolean {
  if (!backend.enginePath || !backend.engineSha256) return false;
  try {
    if (realpathSync(backend.enginePath) !== backend.enginePath) return false;
    if (replaceableByCaller(backend.enginePath)) return false;
    return fileSha256(backend.enginePath) === backend.engineSha256;
  } catch {
    return false;
  }
}

/**
 * Resolve container authority before candidate execution.
 *
 * Container mode NEVER falls back to local. The image is not pulled here. Only
 * a digest-pinned image already present on the fixed local Docker daemon is
 * eligible.
 */
export function prepareVerifierBackend(
  verify: Policy['verify'] | undefined,
): PreparedVerifierBackend {
  const kind = verify?.backend ?? 'local';
  if (kind === 'local') {
    return { kind: 'local', trust: 'checkpointed-local', available: true };
  }

  const image = verify?.image;
  if (!image || !DIGEST_IMAGE.test(image)) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      ...(image ? { image } : {}),
      reason: 'container verifier requires an immutable runtime-safe image reference name@sha256:<64 hex>',
    };
  }

  const forced = process.env.TAMPERWARD_CONTAINER_ENGINE;
  if (forced && forced !== 'docker') {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      reason: `unsupported isolated verifier engine ${JSON.stringify(forced)}; Docker is the tested backend`,
    };
  }

  const enginePath = findExecutable('docker');
  if (!enginePath) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      reason: 'Docker executable was not found on the operator PATH',
    };
  }
  if (replaceableByCaller(enginePath)) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      engine: 'docker',
      enginePath,
      reason: 'Docker engine executable is writable/replaceable by the caller identity; it cannot be verifier authority',
    };
  }

  // We intentionally ignore DOCKER_HOST/DOCKER_CONTEXT/DOCKER_CONFIG. Reading
  // those after an agent turn would hand daemon selection back to candidate-
  // writable user state. v1 supports the conventional local system socket.
  const daemonHost = DEFAULT_DOCKER_HOST;
  if (!dockerAvailable(enginePath, daemonHost)) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      engine: 'docker',
      enginePath,
      daemonHost,
      reason: `Docker is unavailable at the fixed verifier endpoint ${daemonHost}`,
    };
  }
  if (!imagePresent(enginePath, daemonHost, image)) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      engine: 'docker',
      enginePath,
      daemonHost,
      reason: 'the digest-pinned verifier image is not present locally; TamperWard refuses to pull during adjudication',
    };
  }

  return {
    kind: 'container',
    trust: 'isolated-container',
    available: true,
    image,
    engine: 'docker',
    enginePath,
    engineSha256: fileSha256(enginePath),
    daemonHost,
  };
}

export function verifierBackendReport(backend: PreparedVerifierBackend): {
  kind: VerifierBackendKind;
  trust: VerifierBackendTrust;
  image?: string;
  engine?: ContainerEngine;
  available: boolean;
  reason?: string;
} {
  return {
    kind: backend.kind,
    trust: backend.trust,
    available: backend.available,
    ...(backend.image ? { image: backend.image } : {}),
    ...(backend.engine ? { engine: backend.engine } : {}),
    ...(backend.reason ? { reason: backend.reason } : {}),
  };
}

export function verifierBackendSummary(backend: PreparedVerifierBackend): string {
  if (backend.kind === 'local') {
    return 'local (checkpointed same-host; weaker trust boundary)';
  }
  const identity = backend.image ?? '<missing image>';
  if (!backend.available) {
    return `container (isolated; unavailable: ${backend.reason ?? 'unknown reason'}; image ${identity})`;
  }
  return `container (isolated via Docker; image ${identity})`;
}

function cleanupContainer(backend: PreparedVerifierBackend, name: string): void {
  if (!backend.enginePath || !backend.daemonHost || !engineStable(backend)) return;
  try {
    spawnSync(backend.enginePath, dockerArgs(backend.daemonHost, ['rm', '-f', name]), {
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: engineClientEnv(),
    });
  } catch {
    // Best effort after timeout/error. The caller already fails closed.
  }
}

export interface ContainerRunArgsInput {
  image: string;
  name: string;
  workspace: string;
  command: string;
  uid: number;
  gid: number;
}

/** Pure command-line construction, kept testable as part of the trust boundary. */
export function containerRunArgs(input: ContainerRunArgsInput): string[] {
  return [
    'run',
    '--name', input.name,
    // Keep the stopped container until the trusted host has inspected .State.
    // Docker CLI exit codes overlap candidate exit codes; container metadata is
    // the authority that tells us whether the suite actually ran.
    '--pull', 'never',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--user', `${input.uid}:${input.gid}`,
    // Frozen candidate/pristine input is immutable in the verifier. A suite
    // needing outputs writes to /workspace-out, HOME or /tmp instead.
    '--mount', `type=bind,src=${input.workspace},dst=/workspace,ro`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
    '--tmpfs', `/home/tamperward:rw,nosuid,nodev,mode=700,uid=${input.uid},gid=${input.gid}`,
    '--tmpfs', `/workspace-out:rw,nosuid,nodev,mode=700,uid=${input.uid},gid=${input.gid}`,
    '--workdir', '/workspace',
    '--env', 'HOME=/home/tamperward',
    '--env', 'TMPDIR=/tmp',
    '--env', 'CI=1',
    '--env', 'TAMPERWARD_OUTPUT_DIR=/workspace-out',
    '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    input.image,
    'sh', '-c', input.command,
  ];
}

/** Execute one visible/pristine stage inside the prepared isolated domain. */
export function runContainerStage(
  backend: PreparedVerifierBackend,
  dir: string,
  command: string,
  budgetSecs: number,
): BackendRunResult {
  const t0 = Date.now();
  if (
    backend.kind !== 'container' ||
    !backend.available ||
    !backend.image ||
    !backend.enginePath ||
    !backend.engineSha256 ||
    !backend.daemonHost ||
    !engineStable(backend)
  ) {
    return {
      exit: null,
      secs: 0,
      failure: 'backend',
      reason: 'isolated verifier authority is incomplete or changed before stage execution',
    };
  }

  const name = `tamperward-verify-${process.pid}-${randomUUID().slice(0, 12)}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65534;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65534;
  const args = containerRunArgs({
    image: backend.image,
    name,
    workspace: resolve(dir),
    command,
    uid,
    gid,
  });

  try {
    const r = spawnSync(
      backend.enginePath,
      dockerArgs(backend.daemonHost, args),
      {
        stdio: 'ignore',
        timeout: budgetSecs * 1000,
        killSignal: 'SIGKILL',
        env: engineClientEnv(),
      },
    );
    const secs = Math.round((Date.now() - t0) / 1000);

    if (r.error) {
      cleanupContainer(backend, name);
      const code = (r.error as NodeJS.ErrnoException).code;
      return code === 'ETIMEDOUT'
        ? { exit: null, secs, failure: 'budget', reason: 'verifier stage exceeded its budget' }
        : { exit: null, secs, failure: 'backend', reason: `Docker client failed: ${r.error.message}` };
    }
    if (r.status === null) {
      cleanupContainer(backend, name);
      return {
        exit: null,
        secs,
        failure: 'backend',
        reason: `Docker client did not return a status${r.signal ? ` (signal ${r.signal})` : ''}`,
      };
    }

    // Docker run's process status is NOT the suite verdict: Docker itself
    // reserves 125/126/127, while a real suite is also free to return those
    // same integers. Inspect the named stopped container and trust its State
    // instead. If no trustworthy state exists, adjudication did not happen.
    if (!engineStable(backend)) {
      return {
        exit: null,
        secs,
        failure: 'backend',
        reason: 'Docker engine identity changed before verifier result inspection',
      };
    }
    const inspected = spawnSync(
      backend.enginePath,
      dockerArgs(backend.daemonHost, ['inspect', '--format', '{{json .State}}', name]),
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        killSignal: 'SIGKILL',
        env: engineClientEnv(),
      },
    );
    let state:
      | { ExitCode?: number; Error?: string; OOMKilled?: boolean; Status?: string }
      | null = null;
    if (!inspected.error && inspected.status === 0) {
      try {
        state = JSON.parse((inspected.stdout ?? '').trim());
      } catch {
        state = null;
      }
    }
    cleanupContainer(backend, name);

    if (
      !state ||
      state.Status !== 'exited' ||
      typeof state.ExitCode !== 'number' ||
      state.OOMKilled ||
      (state.Error ?? '') !== ''
    ) {
      return {
        exit: null,
        secs,
        failure: 'backend',
        reason: state?.OOMKilled
          ? 'verifier container was OOM-killed'
          : state?.Error
            ? `verifier container runtime error: ${state.Error}`
            : 'Docker did not provide a trustworthy exited-container state',
      };
    }
    return { exit: state.ExitCode, secs };
  } catch (e) {
    cleanupContainer(backend, name);
    return {
      exit: null,
      secs: Math.round((Date.now() - t0) / 1000),
      failure: 'backend',
      reason: `Docker verifier execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
