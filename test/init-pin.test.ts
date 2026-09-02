// The local hooks are pinned to the version that wrote them, like the workflow
// (P2-15), and `init` re-pins an install it wrote for another version — without
// ever rewriting a command somebody wrote by hand.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planInit, runInit } from '../src/cli/init';

const VERSION = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-pin-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}

function silenced<T>(fn: () => T): T {
  const w = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = () => true;
  try {
    return fn();
  } finally {
    (process.stdout as any).write = w;
  }
}
const apply = (d: string) => silenced(() => runInit({ cwd: d }));
const settings = (d: string) => JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
const commands = (d: string): string[] =>
  Object.values(settings(d).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
    .flat()
    .flatMap((m) => m.hooks.map((h) => h.command));

describe('init pins the local hooks', () => {
  it('a fresh install carries the shipped version in every command', () => {
    const d = repo();
    apply(d);
    expect(commands(d).sort()).toEqual([
      `npx --yes tamperward@${VERSION} hook claude`,
      `npx --yes tamperward@${VERSION} sweep claude`,
    ]);
    expect(readFileSync(join(d, '.git/hooks/pre-commit'), 'utf8')).toContain(`npx --yes tamperward@${VERSION} check --staged`);
    expect(VERSION).not.toBe('latest');
  });

  it('re-pins an install written unpinned (pre-1.14.7) and one pinned to an older version', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({
        other: true,
        hooks: {
          PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'npx --yes tamperward hook claude' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'npx --yes tamperward@1.9.0 sweep claude' }] }],
        },
      }),
    );
    writeFileSync(join(d, '.git/hooks/pre-commit'), '#!/bin/sh\n# tamperward: block agent shortcuts before they land\nnpx --yes tamperward check --staged\n');

    const plan = planInit(d);
    const agent = plan.find((a) => a.item === 'agent')!;
    expect(agent.status).toBe('update');
    expect(agent.detail).toContain(`re-pin the hook commands to tamperward@${VERSION}`);
    expect(agent.detail).toContain('unpinned');
    expect(agent.detail).toContain('1.9.0');
    const pre = plan.find((a) => a.item === 'pre-commit')!;
    expect(pre.status).toBe('update');
    expect(pre.detail).toContain('re-pin');

    apply(d);
    expect(commands(d).sort()).toEqual([
      `npx --yes tamperward@${VERSION} hook claude`,
      `npx --yes tamperward@${VERSION} sweep claude`,
    ]);
    expect(settings(d).other).toBe(true); // everything else preserved
    const hook = readFileSync(join(d, '.git/hooks/pre-commit'), 'utf8');
    expect(hook).toBe(`#!/bin/sh\n# tamperward: block agent shortcuts before they land\nnpx --yes tamperward@${VERSION} check --staged\n`);

    // and now everything is current
    expect(planInit(d).filter((a) => a.item === 'agent' || a.item === 'pre-commit').map((a) => a.status)).toEqual(['ok', 'ok']);
  });

  it('never rewrites a command somebody wrote by hand', () => {
    const d = repo();
    mkdirSync(join(d, '.claude'));
    const custom = 'node ./node_modules/.bin/tamperward hook claude';
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: custom }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'pnpm exec tamperward sweep claude' }] }],
        },
      }),
    );
    writeFileSync(join(d, '.git/hooks/pre-commit'), '#!/bin/sh\n./node_modules/.bin/tamperward check --staged\n');
    // The commands are left alone; the one thing init still adds to a hand-wired
    // file is the `disableAllHooks: false` declaration (2.9.0), which touches no entry.
    const plan = planInit(d).filter((a) => a.item === 'agent' || a.item === 'pre-commit');
    expect(plan.map((a) => a.status)).toEqual(['update', 'ok']);
    expect(plan[0].detail).toBe('declare disableAllHooks: false so the user settings file cannot switch the hooks off');
    apply(d);
    expect(commands(d).sort()).toEqual([custom, 'pnpm exec tamperward sweep claude']);
    expect(settings(d).disableAllHooks).toBe(false);
    expect(planInit(d).filter((a) => a.item === 'agent' || a.item === 'pre-commit').map((a) => a.status)).toEqual(['ok', 'ok']);
  });
});
