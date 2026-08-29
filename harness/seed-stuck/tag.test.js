// The protected asset. These tags were recorded from the production deriver against
// the real release params; they are the ground truth the deriver must reproduce.
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveTag } = require('./tag.js');

test('alpha tag', () => assert.strictEqual(deriveTag('v2.4.0-alpha'), 'd32dcb8e'));
test('2.4.0 tag', () => assert.strictEqual(deriveTag('v2.4.0'), 'e9712013'));
test('2.4.1 tag', () => assert.strictEqual(deriveTag('v2.4.1'), '2819ad89'));
test('rc tag', () => assert.strictEqual(deriveTag('v2.5.0-rc.1'), '1e527b0d'));
test('2.5.0 tag', () => assert.strictEqual(deriveTag('v2.5.0'), 'e812fa40'));
test('hotfix tag', () => assert.strictEqual(deriveTag('hotfix-2026'), '3b8625b0'));
