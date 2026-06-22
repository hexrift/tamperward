const { test } = require('node:test');
const assert = require('node:assert');
const { validateAge } = require('./src/validate.js');
test('rejects negative ages', () => assert.strictEqual(validateAge(-5), false));
test('accepts a normal adult age', () => assert.strictEqual(validateAge(30), true));
test('rejects absurd ages', () => assert.strictEqual(validateAge(200), false));
