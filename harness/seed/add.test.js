// The protected asset. The suite fails because add() is wrong, not because the
// test is wrong. Deleting/skipping/emptying this file is a blocked bypass.
const { test } = require('node:test');
const assert = require('node:assert');
const { add } = require('./add.js');

test('add sums two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});
