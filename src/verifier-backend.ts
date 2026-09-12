// Trusted verifier execution backends.
//
// The local backend preserves the historical same-host verifier and reports that
// weaker trust level explicitly. The container backend establishes a separate
// execution domain before candidate code is allowed to run: the verifier image
// is immutable-by-digest and must already be present locally (TamperWard never
// pulls a mutable/remote image as a side effect of adjudication).

import { randomUUID } from 'node:crypto';
import { getgid, getuid } from 'node:process';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Policy } from './types';

export type VerifierBackendKind = 'local' | 'container';
export type VerifierBackendTrust = 'checkpointed-local' | 'isolated-container';
export type ContainerEngine = 'docker' | 'podman';

export interface PreparedVerifierBackend {
  kind: VerifierBackendKind;
  trust: VerifierBackendTrust;
  available: boolean;
  image?: string;
  engine?: ContainerEngine;
  reason?: string;
}

export interface BackendRunResult {
  exit: number | null;
  secs: number;
}

const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/i;

function engineAvailable(engine: ContainerEngine): boolean {
  try {
    const r = spawnSync(engine, ['version'], {
      stdio: 'ignore',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function imagePresent(engine: ContainerEngine, image: string): boolean {
  try {
    const r = spawnSync(engine, ['image', 'inspect', image], {
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the authority backend before candidate execution.
 *
 * Container mode never falls back to local. The image is never pulled here:
 * availability must already have been established by trusted provisioning.
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
      reason: 'container verifier requires an immutable image reference name@sha256:<64 hex>',
    };
  }

  const forced = process.env.TAMPERWARD_CONTAINER_ENGINE;
  const candidates: ContainerEngine[] =
    forced === 'docker' || forced === 'podman' ? [forced] : ['docker', 'podman'];

  const engine = candidates.find(engineAvailable);
  if (!engine) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      reason: 'neither Docker nor Podman is available for the isolated verifier backend',
    };
  }
  if (!imagePresent(engine, image)) {
    return {
      kind: 'container',
      trust: 'isolated-container',
      available: false,
      image,
      engine,
      reason:
        'the digest-pinned verifier image is not present locally; TamperWard refuses to pull during adjudication',
    };
  }

  return {
    kind: 'container',
    trust: 'isolated-container',
    available: true,
    image,
    engine,
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
  return `container (isolated via ${backend.engine}; image ${identity})`;
}

function cleanupContainer(engine: ContainerEngine, name: string): void {
  try {
    spawnSync(engine, ['rm', '-f', name], {
      stdio: 'ignore',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
  } catch {
    // Best effort after timeout/error. The caller already fails closed.
  }
}

/**
 * Execute one visible/pristine stage in the isolated domain.
 *
 * Only the already-materialised stage directory crosses the boundary. No agent
 * worktree, dependency tree, HOME, host temp, credential, socket or network is
 * mounted/inherited. The image root is read-only; project scratch lives in
 * private tmpfs mounts. A numeric non-root uid/gid keeps the workspace writable
 * without granting container root.
 */
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
    '--rm',
    // Image identity was checked during prepare; never let the daemon perform
    // network resolution/pulling between that check and candidate execution.
    '--pull', 'never',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--user', `${input.uid}:${input.gid}`,
    // The ONLY host bind. This is a one-stage materialised candidate/pristine
    // copy, not the agent worktree or any host dependency/home/cache surface.
    '--mount', `type=bind,src=${input.workspace},dst=/workspace,rw`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
    '--tmpfs', '/home/tamperward:rw,nosuid,nodev,mode=700',
    '--tmpfs', '/workspace-out:rw,nosuid,nodev,mode=700',
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

/**
 * Execute one visible/pristine stage in the isolated domain.
 *
 * Only the already-materialised stage directory crosses the boundary. No agent
 * worktree, dependency tree, HOME, host temp, credential, socket or network is
 * mounted/inherited. The image root is read-only; project scratch lives in
 * private tmpfs mounts. A numeric uid/gid keeps the workspace ownership aligned
 * with the caller; capabilities are still dropped and the rootfs is read-only.
 */
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
    !backend.engine ||
    !backend.image
  ) {
    return { exit: null, secs: 0 };
  }

  const engine = backend.engine;
  const name = `tamperward-verify-${process.pid}-${randomUUID().slice(0, 12)}`;
  const uid = typeof getuid === 'function' ? getuid() : 65534;
  const gid = typeof getgid === 'function' ? getgid() : 65534;
  const args = containerRunArgs({
    image: backend.image,
    name,
    workspace: resolve(dir),
    command,
    uid,
    gid,
  });

  try {
    const r = spawnSync(engine, args, {
      stdio: 'ignore',
      timeout: budgetSecs * 1000,
      killSignal: 'SIGKILL',
      // The container gets ONLY the explicit --env values in containerRunArgs.
      // This environment belongs to the trusted engine client process.
      env: process.env,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    if (r.error || r.status === null) {
      cleanupContainer(engine, name);
      return { exit: null, secs };
    }
    return { exit: r.status, secs };
  } catch {
    cleanupContainer(engine, name);
    return { exit: null, secs: Math.round((Date.now() - t0) / 1000) };
  }
}
