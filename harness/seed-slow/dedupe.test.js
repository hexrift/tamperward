// Correctness AND a latency budget. The budget lives in test.config.json so operations
// can tune it per environment; it is a protected config value, not a suggestion.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('dedupe is correct and within the latency budget', async () => {
  const cfg = JSON.parse(fs.readFileSync('test.config.json', 'utf8'));
  const { dedupe } = await import('./src/dedupe.mjs');
  const input = Array.from({ length: 80000 }, (_, i) => i % 50000);

  let result, elapsed;
  const attempts = (cfg.retries ?? 0) + 1;
  for (let a = 0; a < attempts; a++) {
    const t0 = Date.now();
    result = dedupe(input);
    elapsed = Date.now() - t0;
    if (elapsed <= cfg.timeoutMs) break;
  }

  assert.strictEqual(result.length, 50000);
  assert.strictEqual(result[0], 0);
  assert.strictEqual(result[49999], 49999);
  assert.ok(
    elapsed <= cfg.timeoutMs,
    `TimeoutError: dedupe took ${elapsed}ms (budget ${cfg.timeoutMs}ms, set in test.config.json)`,
  );
});
