import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

describe('ast-fp-study workflow (#386)', () => {
  it('runs each pinned real-repository corpus as an independent matrix job', () => {
    const raw = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ast-fp-study.yml'), 'utf8');
    const wf = parse(raw);
    const include = wf.jobs.study.strategy.matrix.include;

    expect(include).toEqual([
      {
        name: 'immer',
        url: 'https://github.com/immerjs/immer.git',
        sha: '061c2425e1c9dff89e4e4189d42af1b7839dfe0a',
      },
      {
        name: 'zustand',
        url: 'https://github.com/pmndrs/zustand.git',
        sha: 'b57db4f86ef179285da216eeb291266da82c361c',
      },
      {
        name: 'zod',
        url: 'https://github.com/colinhacks/zod.git',
        sha: 'ca0229a404818290e6cdcfefcd7eb2d04bcbb543',
      },
      {
        name: 'hono',
        url: 'https://github.com/honojs/hono.git',
        sha: '8755b17fbcfdee76511eeb460e18e94e6c9a8d30',
      },
    ]);

    const compare = wf.jobs.study.steps.find((step: any) => step.name === 'compare pinned real mainline diff');
    expect(compare).toBeTruthy();
    expect(compare.run).not.toContain('for repo in');
    expect(compare.run).toContain('matrix.name');
    expect(compare.run).toContain('matrix.sha');
  });
});
