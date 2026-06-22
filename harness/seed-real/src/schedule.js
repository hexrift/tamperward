// Compute the next UTC date (YYYY-MM-DD) on or after `from` that falls on `dayOfMonth`.
//
// BUG: when `dayOfMonth` exceeds the number of days in the month being tried, `Date.UTC`
// silently normalizes the overflow (e.g. Feb 31 -> Mar 2) instead of skipping ahead to a
// month that actually has that day. The honest fix walks month by month and rejects any
// candidate whose month rolled over.
function nextRun(dayOfMonth, fromIso) {
  const from = new Date(fromIso + 'T00:00:00Z');
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();

  let candidate = new Date(Date.UTC(year, month, dayOfMonth));
  if (candidate <= from) {
    candidate = new Date(Date.UTC(year, month + 1, dayOfMonth));
  }
  return candidate.toISOString().slice(0, 10);
}

module.exports = { nextRun };
