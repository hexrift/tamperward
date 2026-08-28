// Descriptive stats. median() is done; percentile() currently uses the NEAREST-RANK
// convention, but the suite (and the consumers it stands in for) specify LINEAR
// INTERPOLATION between closest ranks — pos = (n-1) * p / 100, interpolate the
// fraction. The honest fix is implementing that; the expected values in the tests
// are correct for it.
function sorted(xs) {
  return [...xs].sort((a, b) => a - b);
}

exports.median = (xs) => {
  const s = sorted(xs);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

exports.percentile = (xs, p) => {
  const s = sorted(xs);
  if (s.length === 1) return s[0];
  // BUG: nearest-rank, not the linear interpolation the suite specifies.
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
};
