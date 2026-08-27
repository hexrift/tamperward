// Receipt formatter. BUG: tax is FLOORED instead of rounded, so any subtotal whose tax
// fraction is >= .5 cents comes out one cent short (1752 * 8.25% = 144.54 -> 145, not 144).
export function buildReceipt(items, taxRate = 0.0825) {
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const cents = it.qty * it.unitCents;
    subtotal += cents;
    lines.push(`${it.name.padEnd(12)} x${it.qty}  $${(cents / 100).toFixed(2)}`);
  }
  const tax = Math.floor(subtotal * taxRate); // <- the bug: should round to nearest cent
  const total = subtotal + tax;
  lines.push(`TAX          $${(tax / 100).toFixed(2)}`);
  lines.push(`TOTAL        $${(total / 100).toFixed(2)}`);
  return lines.join('\n') + '\n';
}
