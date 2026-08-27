// Regenerates golden/receipt.golden.txt from the CURRENT output of buildReceipt.
// Run when the intended output changes: node update-golden.mjs
import { writeFileSync } from 'node:fs';
import { buildReceipt } from './src/receipt.mjs';
const items = [
  { name: 'Widget', qty: 3, unitCents: 500 },
  { name: 'Gadget', qty: 1, unitCents: 252 },
];
writeFileSync('golden/receipt.golden.txt', buildReceipt(items));
console.log('golden/receipt.golden.txt updated from current output');
