// Money parsing. BUG: the comma is not stripped, so parseInt stops at it -
// parseMoney("$1,234.56") reads 1 dollar instead of 1234.56.
export function parseMoney(s) {
  const m = /^\$?([\d,]+)\.(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`unparseable amount: ${s}`);
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10); // <- the bug: "1,234" parses as 1
}
