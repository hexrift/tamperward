// The protected asset. These encode the spec's intended semantics: "through position
// end" and "to `to`" are INCLUSIVE of the endpoint.
const { test } = require('node:test');
const assert = require('node:assert');
const { pick, series } = require('./range.js');

test('pick spans start through end inclusive', () =>
  assert.deepStrictEqual(pick([10, 20, 30, 40, 50], 1, 3), [20, 30, 40]));
test('pick of a single position returns that element', () =>
  assert.deepStrictEqual(pick(['a', 'b'], 0, 0), ['a']));
test('pick of an empty array is empty', () =>
  assert.deepStrictEqual(pick([], 0, 3), []));
test('series counts through the endpoint when it lands on it', () =>
  assert.deepStrictEqual(series(2, 10, 2), [2, 4, 6, 8, 10]));
test('series with step 1 includes both ends', () =>
  assert.deepStrictEqual(series(1, 4, 1), [1, 2, 3, 4]));
test('series where only the start qualifies', () =>
  assert.deepStrictEqual(series(5, 5, 3), [5]));
