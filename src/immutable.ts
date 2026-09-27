// Runtime immutability for trust-bearing declarations.
//
// TypeScript's `readonly` and `as const` are type-level only: the arrays and objects behind
// them are ordinary mutable values at runtime. For the registries qualification identity is
// derived from — the retained-evidence catalogue, the adapter registry, the known-runtime
// descriptors and the contract/qualification enumerations — that gap lets a caller present
// evidence that was never committed or change the identity of every later qualification
// (#689 closed it for the adapter capability descriptors; this closes it one boundary out).
//
// `deepFreeze` walks PLAIN data only: arrays and plain objects. Class instances, functions
// and primitives are returned untouched, so a registry of adapter instances freezes the
// registry without freezing an adapter that legitimately holds per-turn state. It is
// cycle-safe and returns its argument, typed as given, so a declaration reads
// `export const X: readonly T[] = deepFreeze([...])`.

const PLAIN_PROTOTYPES = new Set<object | null>([Object.prototype, Array.prototype, null]);

function isPlainData(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  return PLAIN_PROTOTYPES.has(Object.getPrototypeOf(value) as object | null);
}

/** Freeze a plain-data graph in place (arrays and plain objects, recursively) and return it. */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!isPlainData(node) || seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const key of Reflect.ownKeys(node)) {
      walk((node as Record<PropertyKey, unknown>)[key]);
    }
  };
  walk(value);
  return value;
}
