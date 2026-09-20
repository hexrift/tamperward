// Regression for the live Phase-0 blocker (#618, Work A): the hosted-SDK spike self-bundles the
// neutral adapter to an OS temp ESM file and imports it (harness loadAdapter()). Because the bundled
// `src` graph loads yaml/picomatch LAZILY via `createRequire(import.meta.url)` (src/lazy-deps.ts) and
// esbuild collapses every module's import.meta.url to the OUTPUT file's URL — which lives in the OS
// temp dir with no node_modules — the first policy load threw "Cannot find module 'yaml'" and EVERY
// decision failed closed as `policy-load` (`tamperward-unavailable`), even a plain read. That is the
// fresh live failure (decision_category=fail-closed-unavailable, unavailable_reason=policy-load).
//
// This suite exercises the REAL bundled adapter through the EXACT same bundling path the live
// qualification uses (the exported loadAdapter()), against a valid `.tamperward.yml`, and proves the
// four facts the live run needs: a normal read is NOT tamperward-unavailable; the policy loads; a
// protected weakening reaches the real engine/detector (a real weakening rule, not the unavailable
// sentinel); and the end-of-turn sweep returns a STRUCTURED finding naming the protected file. Before
// the fix (the esbuild import.meta.url anchor in loadAdapter) every assertion here fails on
// `tamperward-unavailable` / `policy-load`.

import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeAdapter } from '../src/adapters/contract';
// @ts-expect-error - the orchestrator is a plain .mjs harness module, no d.ts
import { buildConfig, runEndOfTurnScenario } from '../harness/adapters/copilot-sdk/orchestrator.mjs';
// @ts-expect-error - the fake binding is a plain .mjs test-support module, no d.ts
import { createFakeBinding } from './support/fake-copilot-binding.mjs';

// The harness is ESM .mjs; import it by URL so this TS suite drives the identical live code path.
const spikeUrl = pathToFileURL(resolve(__dirname, '../harness/adapters/copilot-sdk-spike.mjs')).href;
const fixturesUrl = pathToFileURL(resolve(__dirname, '../harness/adapters/copilot-sdk/fixtures.mjs')).href;

interface ScenarioRepo {
  root: string;
  protectedRel: string;
  protectedAbs: string;
  startProtectedHash: string | null;
}

// A weakening of the fixture's protected spec: drop the second test entirely (a canonical
// test-weakening the engine blocks), keeping the file otherwise valid.
const WEAKENED_PROTECTED = `it('keeps one', () => { expect(1).toBe(1); });\n`;

function bindsProtected(file: unknown, repo: ScenarioRepo): boolean {
  if (typeof file !== 'string' || !file) return false;
  if (file === repo.protectedRel) return true;
  const abs = isAbsolute(file) ? file : join(repo.root, file);
  return resolve(abs) === resolve(repo.protectedAbs);
}

let adapter: RuntimeAdapter;
let makeScenarioRepo: (opts?: unknown) => ScenarioRepo;

beforeAll(async () => {
  const spike = await import(spikeUrl);
  const loaded = await spike.loadAdapter();
  adapter = loaded.adapter as RuntimeAdapter;
  expect(typeof adapter?.decide).toBe('function');
  // The bundle really did run from the OS temp dir (the failing condition), not from the checkout.
  expect(typeof loaded.bundleSha).toBe('string');
  ({ makeScenarioRepo } = await import(fixturesUrl));
});

describe('#618 Work A — self-bundled hosted adapter resolves lazy deps from the OS temp dir', () => {
  it('does NOT return tamperward-unavailable for an ordinary in-repo read', () => {
    const repo = makeScenarioRepo();
    const raw = JSON.stringify({ kind: 'read', toolCallId: 'r1', toolName: 'view', fileName: repo.protectedRel, cwd: repo.root });
    const res = adapter.decide(raw, 'pre-action', repo.root);
    expect(res.outcome).toBe('ok');
    expect(res.unavailableReason).toBeUndefined();
    expect(res.decision?.verdict).toBe('allow');
    for (const f of res.decision?.findings ?? []) expect(f.rule).not.toBe('tamperward-unavailable');
  });

  it('loads the policy and routes a protected weakening to the real engine (not policy-load)', () => {
    const repo = makeScenarioRepo();
    const raw = JSON.stringify({
      kind: 'write',
      toolCallId: 'w1',
      toolName: 'edit',
      fileName: repo.protectedRel,
      newFileContents: WEAKENED_PROTECTED,
      intention: 'trim tests',
      cwd: repo.root,
    });
    const res = adapter.decide(raw, 'pre-action', repo.root);
    expect(res.outcome).toBe('ok');
    // The policy loaded and the engine ran: no unavailable sentinel anywhere.
    expect(res.unavailableReason).toBeUndefined();
    expect(res.decision?.verdict).toBe('deny');
    const rules = (res.decision?.findings ?? []).map((f) => f.rule);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).not.toContain('tamperward-unavailable');
  });

  it('exposes a structured end-of-turn finding bound to the protected file (not text, not a byte change)', () => {
    const repo = makeScenarioRepo();
    const sessionId = 'eot-session';
    // Pin the turn-start baseline exactly as production does (a routed pre-action call).
    adapter.decide(
      JSON.stringify({ kind: 'read', toolCallId: 'p0', toolName: 'view', fileName: repo.protectedRel, cwd: repo.root, sessionId }),
      'pre-action',
      repo.root,
    );
    // The weakening LANDS mid-turn (approve-once model): mutate the protected file on disk.
    writeFileSync(repo.protectedAbs, WEAKENED_PROTECTED);
    const stopRaw = JSON.stringify({ cwd: repo.root, sessionId, stopHookActive: false });
    const res = adapter.decide(stopRaw, 'end-of-turn', repo.root);
    expect(res.outcome).toBe('ok');
    expect(res.decision?.verdict).toBe('deny');
    const findings = res.decision?.findings ?? [];
    const bound = findings.find((f) => bindsProtected((f as { file?: unknown }).file, repo));
    expect(bound).toBeDefined();
    expect(bound?.rule).not.toBe('tamperward-unavailable');
  });

  // #618 Work E — the #617 STRUCTURAL end-of-turn binding must survive the temp-bundle path end to end.
  // Before Work A, the bundled adapter's Stop sweep failed policy-load and returned tamperward-unavailable,
  // so `findingBindsTarget` was false and the block bound to the unavailable sentinel rather than the
  // real protected weakening. Run the full orchestrator scenario against the REAL bundled adapter and
  // prove the four structural signals, from Finding.file/rule — not text parsing, not a byte change alone.
  it('runEndOfTurnScenario on the bundled adapter binds a real protected weakening structurally (#618 Work E)', async () => {
    const config = buildConfig({ model: 'gpt-5.4' }, {});
    const r = await runEndOfTurnScenario({ binding: createFakeBinding({ commitProtectedEdit: true, continueOnBlock: true }), adapter, config });
    expect(r.semantic).toBe('PROVEN');
    expect(r.evidence.targetChangedAtStop).toBe(true);
    expect(r.evidence.findingBindsTarget).toBe(true);
    expect(r.evidence.blockReturned).toBe(true);
    expect(r.evidence.continuationObserved).toBe(true);
    expect(r.evidence.landedWeakeningAtStop).toBe(true);
    // The bound finding is a real detector rule naming the protected target, never the unavailable sentinel.
    expect(r.evidence.findingRule).not.toBe('tamperward-unavailable');
    expect(typeof r.evidence.findingFile).toBe('string');
  });
});
