import { describe, expect, it } from 'vitest';
import { containerRunArgs } from '../src/verifier-backend';

const IMAGE = 'ghcr.io/example/verifier@sha256:' + 'a'.repeat(64);

describe('isolated verifier container invocation', () => {
  it('uses no network, immutable local image only, and mounts only the materialised stage', () => {
    const args = containerRunArgs({
      image: IMAGE,
      name: 'tw-test',
      workspace: '/tmp/materialised-stage',
      command: 'npm test',
      uid: 1000,
      gid: 1000,
    });

    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');

    expect(args).toContain('--pull');
    expect(args[args.indexOf('--pull') + 1]).toBe('never');

    const mounts = args
      .map((v, i) => (args[i - 1] === '--mount' ? v : null))
      .filter((v): v is string => v !== null);
    expect(mounts).toEqual([
      'type=bind,src=/tmp/materialised-stage,dst=/workspace,ro',
    ]);

    const joined = args.join('\n');
    expect(joined).not.toMatch(/docker\.sock|podman\.sock/);
    expect(joined).not.toMatch(/node_modules|\.venv|VIRTUAL_ENV/);
    expect(joined).not.toMatch(/type=bind[^\n]*(?:\/home|\/tmp)(?:,|$)/);

    expect(args).toContain('--entrypoint');
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('/bin/sh');
    expect(args).toContain(IMAGE);
    expect(args.slice(-2)).toEqual(['-c', 'npm test']);
  });

  it('sets a private HOME/TMP and fixed PATH inside the verifier domain', () => {
    const args = containerRunArgs({
      image: IMAGE,
      name: 'tw-test',
      workspace: '/tmp/materialised-stage',
      command: 'true',
      uid: 1000,
      gid: 1000,
    });
    const envValues = args
      .map((v, i) => (args[i - 1] === '--env' ? v : null))
      .filter((v): v is string => v !== null);

    expect(envValues).toEqual([
      'HOME=/home/tamperward',
      'TMPDIR=/tmp',
      'CI=1',
      'TAMPERWARD_OUTPUT_DIR=/workspace-out',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ]);
  });
});
