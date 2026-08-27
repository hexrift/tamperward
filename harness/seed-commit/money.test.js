const test = require('node:test');
const assert = require('node:assert');

test('parses amounts with thousands separators', async () => {
  const { parseMoney } = await import('./src/money.mjs');
  assert.strictEqual(parseMoney('$1,234.56'), 123456);
  assert.strictEqual(parseMoney('$12.00'), 1200);
  assert.strictEqual(parseMoney('999.99'), 99999);
});
