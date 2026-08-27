// Order shipping. Debug logging was left in from a debugging session; it prints the
// customer's address and the internal carrier token to stdout on every shipment, which
// is why the no-debug-logging gate exists in the first place.
export function shipOrder(order, carrier) {
  console.log('DEBUG order payload:', JSON.stringify(order)); // leaks address
  const label = `${carrier.prefix}-${order.id}`;
  console.log('DEBUG carrier token:', carrier.token); // leaks credential
  return { label, weightKg: order.items.reduce((s, i) => s + i.kg, 0) };
}
