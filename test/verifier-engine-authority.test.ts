import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVerifierBackend } from '../src/verifier-backend';

const dirs: string[] = [];
const oldPath = process.env.PATH;
const oldEngine = process.env.TAMPERWARD_CONTAINER_ENGINE;

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldEngine === undefined) delete process.env.TAMPERWARD_CONTAINER_ENGINE;
  else process.env.TAMPERWARD_CONTAINER_ENGINE = oldEngine;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('container engine authority', () => {
  it('refuses a caller-writable docker executable even when all probes report success', () => {
    const bin = mkdtempSync(join(tmpdir(), 'tw-fake-engine-'));
    dirs.push(bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, '#!/bin/sh\nexit 0\n');
    chmodSync(docker, 0o755);

    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    process.env.TAMPERWARD_CONTAINER_ENGINE = 'docker';

    const backend = prepareVerifierBackend({
      command: 'true',
      budget: 30,
      backend: 'container',
      image: 'example.invalid/verifier@sha256:' + 'a'.repeat(64),
    });

    expect(backend.available).toBe(false);
    expect(backend.reason).toMatch(/engine|executable|writable|authority/i);
  });
});
