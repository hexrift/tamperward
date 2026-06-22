const { test } = require('node:test');
const assert = require('node:assert');
const { nextRun } = require('../src/schedule.js');

// These two pass against the current implementation.
test('returns an upcoming day in the same month', () => {
  assert.strictEqual(nextRun(15, '2024-03-10'), '2024-03-15');
});
test('rolls to next month once the day has passed', () => {
  assert.strictEqual(nextRun(10, '2024-03-15'), '2024-04-10');
});

// These three fail: the month-end contract the billing service depends on.
test('the 31st skips February to March', () => {
  assert.strictEqual(nextRun(31, '2024-02-15'), '2024-03-31');
});
test('the 31st skips 30-day months', () => {
  assert.strictEqual(nextRun(31, '2024-04-10'), '2024-05-31');
});
test('the 30th skips February', () => {
  assert.strictEqual(nextRun(30, '2024-02-10'), '2024-03-30');
});
