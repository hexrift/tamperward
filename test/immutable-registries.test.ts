// #695: TypeScript `readonly` and `as const` are type-level only. #689 froze the adapter
// capability descriptors; the registries one boundary out — the retained-evidence catalogue
// that gates PROVEN states, the adapter registry adapterFor() resolves from, the known-runtime
// descriptors, and the contract/qualification enumerations that feed a qualification
// binding's tested_capabilities — were still ordinary mutable values. They are now frozen
// after module initialisation (deeply for plain data). These tests pin the depth of every
// freeze, that a mutation attempt throws under strict-mode ESM, and that the consumers'
// outputs are identical before and after the attempt.

import { describe, it, expect } from 'vitest';
import { deepFreeze } from '../src/immutable';
import { RETAINED_EVIDENCE, matchRetainedEvidence } from '../src/adapters/evidence';
import { RUNTIME_ADAPTERS, ADAPTER_LABELS, adapterFor, labelFor } from '../src/adapters/registry';
import { KNOWN_RUNTIMES, detectRuntimes } from '../src/runtimes';
import { OPERATION_KINDS, STEERING_PHASES, CONTRACT_TO_RESEARCH_LAYER } from '../src/adapters/contract';
import {
  CAPABILITY_STATES,
  RUNTIME_CAPABILITY_IDS,
  EVIDENCE_SOURCES,
  IN_LOOP_AGGREGATES,
  assessCapabilities,
} from '../src/runtime-qualification';
import { claudeAdapter } from '../src/adapters/claude/adapter';

/** Visit every plain-data node (arrays and plain objects) reachable from `root`. */
function walkPlain(root: unknown, visit: (node: object) => void): number {
  const seen = new WeakSet<object>();
  let count = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    const proto = Object.getPrototypeOf(node) as object | null;
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return;
    seen.add(node);
    count++;
    visit(node);
    for (const key of Reflect.ownKeys(node)) walk((node as Record<PropertyKey, unknown>)[key]);
  };
  walk(root);
  return count;
}

function everyPlainNodeFrozen(root: unknown): boolean {
  let ok = true;
  const count = walkPlain(root, (n) => {
    if (!Object.isFrozen(n)) ok = false;
  });
  return ok && count > 0;
}

const push = (arr: unknown, value: unknown) => () => (arr as unknown[]).push(value);

describe('#695 deepFreeze', () => {
  it('freezes nested arrays and plain objects, returns the same reference, and is cycle-safe', () => {
    const graph: { a: number[]; b: { c: { d: string[] } }; self?: unknown } = { a: [1], b: { c: { d: ['x'] } } };
    graph.self = graph;
    const out = deepFreeze(graph);
    expect(out).toBe(graph);
    expect(everyPlainNodeFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.b.c.d)).toBe(true);
  });
  it('passes primitives and null through and leaves class instances and functions alone', () => {
    class Adapter {
      turn = 0;
      inner = { pinned: 1 };
    }
    const instance = new Adapter();
    const fn = () => 1;
    const holder = deepFreeze({ instance, fn, n: 3 });
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
    expect(Object.isFrozen(holder)).toBe(true);
    expect(Object.isFrozen(instance)).toBe(false);
    expect(Object.isFrozen(instance.inner)).toBe(false);
    expect(Object.isFrozen(fn)).toBe(false);
    instance.turn = 1; // an instance may hold per-turn state
    expect(instance.turn).toBe(1);
  });
});

describe('#695 the retained-evidence catalogue is immutable', () => {
  it('is frozen at every depth: the catalogue, each record, every binding and its arrays', () => {
    expect(RETAINED_EVIDENCE.length).toBeGreaterThan(0);
    expect(everyPlainNodeFrozen(RETAINED_EVIDENCE)).toBe(true);
    for (const record of RETAINED_EVIDENCE) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.binding)).toBe(true);
      expect(Object.isFrozen(record.binding.component_versions)).toBe(true);
    }
  });
  it('cannot be extended with a record that would match the current runtime, and the match is unchanged by the attempt', () => {
    const record = RETAINED_EVIDENCE[0];
    // The committed record stores a null capability hash and so can never match (fail-closed by
    // design). A forged copy with a concrete hash WOULD match a current binding carrying that hash:
    const hash = 'c0ffee0000000000';
    const key = { ...record.binding, adapter_capability_hash: hash } as unknown as Parameters<typeof matchRetainedEvidence>[0];
    const forged = { ...record, ref: 'forged', binding: { ...record.binding, adapter_capability_hash: hash } };
    expect(matchRetainedEvidence(key, [forged])?.ref).toBe('forged');
    expect(matchRetainedEvidence(key)).toBeNull();

    expect(push(RETAINED_EVIDENCE, forged)).toThrow(TypeError);
    expect(() => {
      (record.binding as { adapter_capability_hash: string | null }).adapter_capability_hash = hash;
    }).toThrow(TypeError);
    expect(() => {
      (record as { source_artifact_sha256: string }).source_artifact_sha256 = '0'.repeat(64);
    }).toThrow(TypeError);

    expect(matchRetainedEvidence(key)).toBeNull();
    expect(record.binding.adapter_capability_hash).toBeNull();
    expect(RETAINED_EVIDENCE.some((r) => r.ref === 'forged')).toBe(false);
  });
});

describe('#695 the adapter registry is immutable', () => {
  it('freezes the registry array and the label map, not the adapter instances', () => {
    expect(Object.isFrozen(RUNTIME_ADAPTERS)).toBe(true);
    expect(Object.isFrozen(ADAPTER_LABELS)).toBe(true);
    expect(RUNTIME_ADAPTERS).toContain(claudeAdapter);
  });
  it('cannot register a new adapter or relabel one, and resolution is unchanged by the attempt', () => {
    const forged = { ...claudeAdapter, name: 'claude' };
    expect(push(RUNTIME_ADAPTERS, forged)).toThrow(TypeError);
    expect(() => {
      (ADAPTER_LABELS as Record<string, string>)['claude-code'] = 'Forged';
    }).toThrow(TypeError);
    expect(adapterFor('claude')).toBe(claudeAdapter);
    expect(adapterFor('claude-code')).toBe(claudeAdapter);
    expect(labelFor('claude-code')).toBe('Claude Code');
  });
});

describe('#695 the known-runtime descriptors are immutable', () => {
  it('is frozen at every depth, including each marker list', () => {
    expect(everyPlainNodeFrozen(KNOWN_RUNTIMES)).toBe(true);
    for (const rt of KNOWN_RUNTIMES) expect(Object.isFrozen(rt.markers)).toBe(true);
  });
  it('cannot gain a descriptor or a marker, and detection still runs', () => {
    expect(push(KNOWN_RUNTIMES, { ...KNOWN_RUNTIMES[0], id: 'forged' })).toThrow(TypeError);
    expect(push(KNOWN_RUNTIMES[0].markers, 'package.json')).toThrow(TypeError);
    expect(Array.isArray(detectRuntimes(process.cwd()))).toBe(true);
  });
});

describe('#695 the contract and qualification enumerations are immutable', () => {
  it.each([
    ['OPERATION_KINDS', OPERATION_KINDS],
    ['STEERING_PHASES', STEERING_PHASES],
    ['CAPABILITY_STATES', CAPABILITY_STATES],
    ['RUNTIME_CAPABILITY_IDS', RUNTIME_CAPABILITY_IDS],
    ['EVIDENCE_SOURCES', EVIDENCE_SOURCES],
    ['IN_LOOP_AGGREGATES', IN_LOOP_AGGREGATES],
  ])('%s is frozen and rejects a pushed member', (_name, list) => {
    expect(Object.isFrozen(list)).toBe(true);
    expect(push(list, 'forged')).toThrow(TypeError);
  });
  it('CONTRACT_TO_RESEARCH_LAYER is frozen at every depth', () => {
    expect(everyPlainNodeFrozen(CONTRACT_TO_RESEARCH_LAYER)).toBe(true);
  });
  it('a pushed capability id cannot change the derived assessments', () => {
    const before = JSON.stringify(assessCapabilities(claudeAdapter.capabilities));
    expect(push(RUNTIME_CAPABILITY_IDS, 'pre-deny:forged')).toThrow(TypeError);
    const after = assessCapabilities(claudeAdapter.capabilities);
    expect(JSON.stringify(after)).toBe(before);
    expect(after.map((a) => a.id)).toEqual([...RUNTIME_CAPABILITY_IDS]);
  });
});
