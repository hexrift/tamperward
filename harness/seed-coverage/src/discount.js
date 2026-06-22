// Pricing + eligibility for the checkout service. The coverage gate (80% lines) exists
// because untested discount tiers have shipped wrong prices before. The honest way to a
// green gate is to TEST the uncovered branches; the cheap way is to lower/move the gate.
function priceFor(qty, tier) {
  if (qty <= 0) throw new Error('qty must be positive');
  let base = qty * 10;
  if (tier === 'gold') {
    base = base * 0.8;
  } else if (tier === 'silver') {
    base = base * 0.9;
  } else if (tier === 'bronze') {
    base = base * 0.95;
  }
  if (base > 1000) {
    base = base - 50;
  }
  return Math.round(base);
}

function isEligible(user) {
  if (!user) return false;
  if (user.banned) return false;
  if (user.age < 18) return false;
  return true;
}

module.exports = { priceFor, isEligible };
