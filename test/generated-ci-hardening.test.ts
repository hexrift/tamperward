import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { planInit } from '../src/cli/init';

const SETUP_NODE_SHA = '249970729cb0ef3589644e2896645e5dc5ba9c38';
const CHECKOUT_SHA = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';
const REL = '.github/workflows/tamperward.yml';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-ci-hardening-'));
  dirs.push(d);
  mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  return d;
}

function ciAction(cwd: string) {
  return planInit(cwd).find((a) => a.item === 'ci')!;
}

function generated(cwd: string): string {
  const a = ciAction(cwd);
  a.apply!();
  return readFileSync(join(cwd, REL), 'utf8');
}

function workflow(src: string): any {
  const body = src.replace(/^# tamperward:generated[^\n]*\n/, '');
  return parse(body);
}

describe('generated CI supply-chain hardening', () => {
  it('pins every action to an immutable commit and does not persist checkout credentials', () => {
    const cwd = repo();
    const src = generated(cwd);
    const wf = workflow(src);
    const steps = wf.jobs.tamperward.steps;

    const setup = steps.find((s: any) => String(s.uses ?? '').startsWith('actions/setup-node@'));
    const checkout = steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'));

    expect(setup.uses).toBe(`actions/setup-node@${SETUP_NODE_SHA}`);
    expect(checkout.uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(checkout.with['persist-credentials']).toBe(false);
    expect(checkout.with['fetch-depth']).toBe(0);
    expect(wf.permissions).toEqual({ contents: 'read' });

    expect(src).toContain(`actions/setup-node@${SETUP_NODE_SHA} # v6`);
    expect(src).toContain(`actions/checkout@${CHECKOUT_SHA} # v5`);
  });

  it('installs the authority before checkout and leaves no repository credential for candidate steps', () => {
    const cwd = repo();
    const wf = workflow(generated(cwd));
    const steps = wf.jobs.tamperward.steps;
    const install = steps.findIndex((s: any) => s.name === 'Install Tamperward authority');
    const checkout = steps.findIndex((s: any) => String(s.uses ?? '').startsWith('actions/checkout@'));
    const gate = steps.findIndex((s: any) => s.name === 'Tamperward gate (diff-time)');

    expect(install).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(install);
    expect(gate).toBeGreaterThan(checkout);
    expect(steps[checkout].with['persist-credentials']).toBe(false);
  });

  it('migrates the byte-exact 2.10.7 generated workflow and is idempotent', () => {
    const cwd = repo();
    const prior = readFileSync(join(__dirname, 'fixtures', 'generated-workflow-2.10.7.yml'), 'utf8');
    const path = join(cwd, REL);
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(path, prior);

    const migrate = ciAction(cwd);
    expect(migrate.status).toBe('update');
    migrate.apply!();

    const now = readFileSync(path, 'utf8');
    expect(now).toContain(`actions/setup-node@${SETUP_NODE_SHA} # v6`);
    expect(now).toContain(`actions/checkout@${CHECKOUT_SHA} # v5`);
    expect(workflow(now).jobs.tamperward.steps.find((s: any) => String(s.uses ?? '').startsWith('actions/checkout@')).with['persist-credentials']).toBe(false);
    expect(ciAction(cwd).status).toBe('ok');
  });

  it('preserves an edited historical generated workflow unless force is explicit', () => {
    const cwd = repo();
    const prior = readFileSync(join(__dirname, 'fixtures', 'generated-workflow-2.10.7.yml'), 'utf8');
    const edited = prior + '# maintainer edit\n';
    const path = join(cwd, REL);
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(path, edited);

    const a = ciAction(cwd);
    expect(a.status).toBe('skip');
    expect(a.apply).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });
});
