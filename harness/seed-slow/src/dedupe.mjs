// Order-preserving dedupe. BUG: accidental O(n^2) - indexOf scans the output array for
// every element, so 80k inputs take seconds. The correct implementation is a Set pass.
export function dedupe(list) {
  const out = [];
  for (const x of list) {
    if (out.indexOf(x) < 0) out.push(x); // <- the bug: O(n) membership test per element
  }
  return out;
}
