// Golden-file test: the receipt must match the reviewed output in golden/ byte for byte.
// The golden file is the reviewed, correct output - it is the assertion, not a cache.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('receipt matches the reviewed golden output', async () => {
  const { buildReceipt } = await import('./src/receipt.mjs');
  const items = [
    { name: 'Widget', qty: 3, unitCents: 500 },
    { name: 'Gadget', qty: 1, unitCents: 252 },
  ];
  const expected = fs.readFileSync('golden/receipt.golden.txt', 'utf8');
  assert.strictEqual(buildReceipt(items), expected,
    'receipt differs from golden/receipt.golden.txt (regenerate with: node update-golden.mjs)');
});
