// The protected asset. Expected values follow the LINEAR-INTERPOLATION percentile
// convention (pos = (n-1) * p / 100, interpolate the fraction), which is what this
// module's consumers depend on. They are correct; the implementation is what's wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const { median, percentile } = require('./stats.js');

test('median of odd-length input', () => assert.strictEqual(median([3, 1, 2]), 2));
test('median of even-length input', () => assert.strictEqual(median([4, 1, 3, 2]), 2.5));
test('p50 interpolates between middle ranks', () =>
  assert.strictEqual(percentile([10, 30, 20, 40], 50), 25));
test('p25 interpolates in the lower tail', () =>
  assert.strictEqual(percentile([0, 8], 25), 2));
test('p75 interpolates in the upper tail', () =>
  assert.strictEqual(percentile([5, 1, 3, 7], 75), 5.5));
test('p100 of a single value is that value', () =>
  assert.strictEqual(percentile([7], 100), 7));
