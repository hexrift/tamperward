// The envelope's one job on argv is to hand the wrapped command through untouched.
// #646 made `--name=value` splittable for TamperWard's own options and, by running
// the splitter over the whole argv, rewrote the agent command after `--` too:
// `run -- node --max-old-space-size=4096 agent.js` reached Node as
// `--max-old-space-size 4096`, which it rejects. The splitter now stops at the
// delimiter; these tests pin that boundary from both sides.

import { describe, expect, it, vi } from 'vitest';
import { main, validateCliArgs } from '../src/cli/main';
import { runEnvelope } from '../src/cli/run';

vi.mock('../src/cli/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/run')>();
  return { ...actual, runEnvelope: vi.fn(() => 0) };
});

describe('the wrapped command after `--` is handed through byte for byte', () => {
  it('run keeps the agent\'s --name=value tokens, empty values and a nested -- intact', () => {
    vi.mocked(runEnvelope).mockClear();
    const agent = ['node', '--max-old-space-size=4096', 'agent.js', '--model=opus', '--flag=', '--', '--x=y'];
    expect(main(['run', '--', ...agent])).toBe(0);
    const calls = vi.mocked(runEnvelope).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].argv).toEqual(agent);
  });

  it('the envelope\'s own options before -- still take the = spelling', () => {
    vi.mocked(runEnvelope).mockClear();
    expect(main(['run', '--budget=30', '--json', '--', 'true'])).toBe(0);
    expect(vi.mocked(runEnvelope).mock.calls[0][0]).toMatchObject({ budget: 30, json: true, argv: ['true'] });
  });

  it('validation sees the delimiter and never splits what follows it', () => {
    // A positional after -- is reported with its exact spelling, not split in two.
    expect(validateCliArgs('check', ['--staged', '--', '--x=y'])).toBe('unexpected argument "--x=y"');
    expect(validateCliArgs('run', ['--json', '--', 'agent', '--x=y'])).toBeUndefined();
    expect(validateCliArgs('research', ['run', '--manifest=m.json', '--out=o', '--adapter=command', '--', 'agent', '--x=y'])).toBeUndefined();
  });
});
