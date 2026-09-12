import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileAt } from '../src/git/build';
import { loadPolicyAt } from '../src/policy-load';
import { treeFingerprint } from '../src/fingerprint';
import { defaultPolicy, isProtected } from '../src/policy';
import { HOOK_CMD, NPX_AUTHORITY, PRECOMMIT_CMD, SWEEP_CMD, TW_VERSION } from '../src/wiring';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(): string {
  const cwd = tmp('tw-sec-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@b');
  git('config', 'user.name', 'tb');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'test', 'a.test.js'), "it('a', () => {});\n");
  writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: node trusted-runner.js\n');
  git('add', '-A');
  git('commit', '-qm', 'trusted base');
  return cwd;
}

describe('candidate npm configuration cannot start the authority under injected code', () => {
  it('excludes HOME and its selected global rc while starting a pinned package', () => {
    const cwd = tmp('tw-rc-sources-');
    const userHome = tmp('tw-rc-home-');
    const prefix = tmp('tw-rc-prefix-');
    const globalRc = join(prefix, 'operator.npmrc');
    writeFileSync(join(userHome, '.npmrc'), `fetch-retries=37\nglobalconfig=${globalRc}\n`);
    writeFileSync(globalRc, 'fetch-retries=37\n');
    const pkg = join(cwd, 'node_modules', 'tamperward');
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(cwd, 'node_modules', '.bin'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'tamperward', version: TW_VERSION, bin: { tamperward: 'cli.cjs' } }));
    const cli = '#!/usr/bin/env node\nconsole.log(JSON.stringify({started:true,user:process.env.npm_config_userconfig,global:process.env.npm_config_globalconfig,registry:process.env.npm_config_registry}));\n';
    writeFileSync(join(cwd, 'node_modules', '.bin', 'tamperward'), cli);
    chmodSync(join(cwd, 'node_modules', '.bin', 'tamperward'), 0o755);
    writeFileSync(join(pkg, 'cli.cjs'), cli);
    chmodSync(join(pkg, 'cli.cjs'), 0o755);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
    const r = spawnSync('/bin/sh', ['-c', `${NPX_AUTHORITY} tamperward@${TW_VERSION} hook claude`], {
      cwd, encoding: 'utf8', timeout: 15000,
      env: { ...env, HOME: userHome },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({started:true,user:'/dev/null'});
    // npm does not rewrite every inherited npm_config_* in the child environment.
    // Query its effective configuration rather than confusing that with an env echo.
    const config = spawnSync('/bin/sh', ['-c', `${NPX_AUTHORITY.replace('npx --yes', 'npm')} config get fetch-retries`], {
      cwd, encoding: 'utf8', env: { ...env, HOME: userHome },
    });
    expect(config.status, config.stderr).toBe(0);
    expect(config.stdout.trim()).toBe('2');
  });
  it('keeps every generated local npx call out of project configuration', () => {
    for (const cmd of [HOOK_CMD, SWEEP_CMD, PRECOMMIT_CMD]) {
      expect(cmd).toContain('--global');
      expect(cmd).toContain('--registry=https://registry.npmjs.org/');
      expect(cmd).toContain("--node-options=' '");
      expect(cmd).toContain('--script-shell=');
      expect(cmd).toContain('--ignore-scripts');
      expect(cmd).toContain('--offline=false');
      expect(cmd).toContain('--prefer-online');
      expect(cmd.indexOf('--node-options')).toBeLessThan(cmd.indexOf('tamperward@'));
    }
    expect(HOOK_CMD).toContain('authority failed to start');
    expect(SWEEP_CMD).toContain('authority failed to start');
    expect(PRECOMMIT_CMD).not.toContain('authority failed to start');
  });

  it('the npx controls override a hostile project .npmrc before its child Node starts', () => {
    const cwd = tmp('tw-npmrc-');
    const preload = join(cwd, 'preload.cjs');
    const marker = join(cwd, 'loaded');
    writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')\n`);
    writeFileSync(join(cwd, '.npmrc'), `node-options=--require=${preload}\n`);

    // Control: the project setting reaches the Node program npm launches.
    execFileSync('npx', ['--yes', '-c', 'node -e "process.exit(0)"'], { cwd, stdio: 'ignore' });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    execFileSync(
      'npx',
      [
        '--yes',
        '--global',
        '--registry=https://registry.npmjs.org/',
        '--node-options= ',
        '--script-shell=',
        '--ignore-scripts',
        '--offline=false',
        '--prefer-online',
        '-c',
        'node -e "process.exit(0)"',
      ],
      { cwd, stdio: 'ignore' },
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('ignores project call, workspace, proxy and CA settings as one namespace', () => {
    const cwd = tmp('tw-npmrc-all-');
    const seen = join(cwd, 'seen.json');
    const callMarker = join(cwd, 'call-marker');
    const preloadMarker = join(cwd, 'preload-marker');
    const preload = join(cwd, 'preload.cjs');
    const inspect = join(cwd, 'inspect.cjs');
    const sentinelProxy = 'http://127.0.0.1:9';
    const sentinelCa = '/definitely/candidate-ca.pem';
    writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'loaded')\n`);
    writeFileSync(
      inspect,
      `require('fs').writeFileSync(process.env.TW_SEEN, JSON.stringify({\n` +
        `  call: process.env.npm_config_call,\n` +
        `  workspace: process.env.npm_config_workspace,\n` +
        `  proxy: process.env.npm_config_proxy,\n` +
        `  httpsProxy: process.env.npm_config_https_proxy,\n` +
        `  cafile: process.env.npm_config_cafile,\n` +
        `  nodeOptions: process.env.npm_config_node_options,\n` +
        `}))\n`,
    );
    writeFileSync(
      join(cwd, '.npmrc'),
      [
        `call=sh -c 'printf injected > ${callMarker}'`,
        'workspace=definitely-not-a-workspace',
        `proxy=${sentinelProxy}`,
        `https-proxy=${sentinelProxy}`,
        `cafile=${sentinelCa}`,
        `node-options=--require=${preload}`,
        '',
      ].join('\n'),
    );

    execFileSync(
      'npx',
      [
        '--yes',
        '--global',
        '--registry=https://registry.npmjs.org/',
        '--node-options= ',
        '--script-shell=',
        '--ignore-scripts',
        '--offline=false',
        '--prefer-online',
        '-c',
        `node "${inspect}"`,
      ],
      { cwd, env: { ...process.env, TW_SEEN: seen }, stdio: 'ignore' },
    );

    const effective = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string | undefined>;
    expect(effective.call).toContain('inspect.cjs');
    expect(effective.workspace).toBeUndefined();
    expect(effective.proxy).not.toBe(sentinelProxy);
    expect(effective.httpsProxy).not.toBe(sentinelProxy);
    expect(effective.cafile).not.toBe(sentinelCa);
    expect(effective.nodeOptions).toBe('');
    expect(existsSync(callMarker)).toBe(false);
    expect(existsSync(preloadMarker)).toBe(false);
  });

  it.each([HOOK_CMD, SWEEP_CMD])('maps launcher failure to Claude\'s blocking exit channel', (command) => {
    const cwd = tmp('tw-npx-fail-');
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const npx = join(bin, 'npx');
    writeFileSync(npx, '#!/bin/sh\nexit 1\n');
    chmodSync(npx, 0o755);
    const r = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('tamperward: authority failed to start');
  });
});

describe('generic trusted git reads ignore replace objects', () => {
  it('fileAt and loadPolicyAt read the real base object under a pre-existing replace ref', () => {
    const cwd = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const base = git('rev-parse', 'HEAD');
    const trustedBranch = git('branch', '--show-current');

    git('switch', '--orphan', 'attacker');
    writeFileSync(join(cwd, '.tamperward.yml'), 'version: 1\nverify:\n  command: "true"\n');
    git('add', '-A');
    git('commit', '-qm', 'attacker replacement');
    const replacement = git('rev-parse', 'HEAD');
    git('switch', '-q', trustedBranch);
    git('replace', base, replacement);

    // Exploit control: ordinary git follows the replacement object.
    expect(git('show', `${base}:.tamperward.yml`)).toContain('command: "true"');
    expect(fileAt(base, '.tamperward.yml', { cwd })).toContain('node trusted-runner.js');
    expect(loadPolicyAt(base, cwd)?.verify?.command).toBe('node trusted-runner.js');
  });
});

describe('quiescence fingerprints filesystem identity and protected ignored state', () => {
  it('changes on a chmod-only transition with identical bytes', () => {
    const cwd = repo();
    const path = join(cwd, 'test', 'a.test.js');
    const beforeBytes = readFileSync(path);
    const before = treeFingerprint(cwd);
    chmodSync(path, 0o755);
    expect(readFileSync(path)).toEqual(beforeBytes);
    expect(treeFingerprint(cwd)).not.toBe(before);
  });

  it('includes ignored protected files but leaves unrelated ignored output out', () => {
    const cwd = repo();
    const policy = defaultPolicy();
    writeFileSync(join(cwd, '.gitignore'), 'test/local.test.js\nbuild.log\n');
    writeFileSync(join(cwd, 'test', 'local.test.js'), "it('local', () => {});\n");
    writeFileSync(join(cwd, 'build.log'), 'one\n');
    const keep = (rel: string) => isProtected(rel, policy);
    const before = treeFingerprint(cwd, keep);
    writeFileSync(join(cwd, 'build.log'), 'two\n');
    expect(treeFingerprint(cwd, keep)).toBe(before);
    writeFileSync(join(cwd, 'test', 'local.test.js'), "it.skip('local', () => {});\n");
    expect(treeFingerprint(cwd, keep)).not.toBe(before);
  });
});
