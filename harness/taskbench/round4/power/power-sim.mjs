#!/usr/bin/env node
// Round 4 sample-size simulation — exact, over the FULL paired table.
//
// SPEC §9.1 (M2) requires the round 4 sample to be sized by an exact simulation
// over the full paired table: false green in both arms ("both"), ungated only
// ("b"), gated only ("c"), neither. This script is that simulation. It is
// planning scaffolding for the PREDICTION, not the PREDICTION: nothing here
// binds until the PREDICTION commits, and the PREDICTION freezes this file's
// hash with the rest of the analysis.
//
// Why the full table and not the ungated marginal: McNemar's b is not the
// number of ungated opportunities. An ungated false green whose gated twin is
// ALSO a false green is a concordant pair ("both") and contributes nothing to
// the test. Round 2 had four such pairs (b=9, both=4); treating its 13 ungated
// false greens as 13 potential b events would overstate power. Uncertainty is
// carried on the joint probabilities, not just the ungated marginal.
//
// Observed tables (repository = unit, one primary trajectory per arm):
//   round 2   (n=22, JS/TS,  v1.9.0):  both=4, b=9, c=0, neither=9
//   round 3   (n=17, Python, v1.14.0): both=2, b=6, c=0, neither=9
//   round 3.1 (n=16, Python, v1.14.0, claude-sonnet-5): both=2, b=1, c=0, neither=13
// (round 3 cells recomputed from runs-phase3/results.jsonl: ungated FG=8,
//  gated FG=2, b=6, c=0.)
//
// Model per scenario, drawn once per simulated round:
//   piU  ~ Beta   : P(ungated arm shows a false green)            [opportunity]
//   prev ~ Beta   : P(gated twin is clean | ungated false green)  [prevention]
//   piC  ~ Beta   : P(gated-only false green | no ungated FG)     [gate harm]
// giving cell probabilities  b = piU*prev, both = piU*(1-prev),
// c = (1-piU)*piC, neither = (1-piU)*(1-piC).
// Then n pairs are drawn, and the exact conditional McNemar (two-sided
// binomial, X ~ Bin(b+c, 1/2)) is applied — the same primary test as rounds
// 1–3.1.
//
// Deterministic: seeded mulberry32; no dependencies; node >= 20.
// Usage: node power-sim.mjs [sims-per-cell]   (default 20000)

const SIMS = Number(process.argv[2] ?? 20000);
const SEED = 0x52344; // "R4"; fixed
const NS = [60, 70, 80, 90, 100, 120];
const ALPHA = 0.05;
const B_FLOOR = 6; // interpretation floor carried from the 3.1 scorecard

// ---------- RNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

// Marsaglia–Tsang gamma, shape >= 0 (boosted for shape < 1).
function gamma(shape) {
  if (shape <= 0) return 0;
  if (shape < 1) {
    const u = Math.max(rand(), 1e-12);
    return gamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box–Muller normal
      const u1 = Math.max(rand(), 1e-12), u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rand(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const beta = (a, b) => { const x = gamma(a); return x / (x + gamma(b)); };
function binom(n, p) { let k = 0; for (let i = 0; i < n; i++) if (rand() < p) k++; return k; }

// ---------- exact conditional McNemar ----------
const logFactCache = [0];
function logFact(n) {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  return logFactCache[n];
}
function binomPmf(n, k) { // p = 1/2
  return Math.exp(logFact(n) - logFact(k) - logFact(n - k) - n * Math.LN2);
}
function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let tail = 0;
  for (let k = 0; k <= lo; k++) tail += binomPmf(n, k);
  return Math.min(1, 2 * tail);
}

// ---------- scenarios ----------
// Jeffreys (0.5, 0.5) added to every observed count.
// prevention pooled where the treatment aims (rounds 2+3: b=15, both=6 → 15/21);
// piC from zero gated-only events over the 55 gated trajectories of rounds 2–3.1.
const SCENARIOS = [
  {
    name: 'A  3.1-as-is',
    desc: 'round 3.1 posterior alone: piU~Beta(3.5,13.5), prev~Beta(1.5,2.5), piC~Beta(0.5,13.5)',
    draw: () => ({ piU: beta(3.5, 13.5), prev: beta(1.5, 2.5), piC: beta(0.5, 13.5) }),
  },
  {
    name: 'B  3.1-rate, pooled-prevention',
    desc: 'piU~Beta(3.5,13.5) (3.1), prev~Beta(15.5,6.5) (rounds 2+3), piC~Beta(0.5,55.5) (0/55)',
    draw: () => ({ piU: beta(3.5, 13.5), prev: beta(15.5, 6.5), piC: beta(0.5, 55.5) }),
  },
  {
    name: 'C  pooled-Python-rate',
    desc: 'piU~Beta(11.5,22.5) (rounds 3+3.1 ungated 11/33), prev~Beta(15.5,6.5), piC~Beta(0.5,55.5)',
    draw: () => ({ piU: beta(11.5, 22.5), prev: beta(15.5, 6.5), piC: beta(0.5, 55.5) }),
  },
  {
    name: 'D  pessimistic',
    desc: 'piU~Beta(3.5,13.5), prev~Beta(15.5,6.5), piC~Beta(1.5,55.5) (allow rare gate harm)',
    draw: () => ({ piU: beta(3.5, 13.5), prev: beta(15.5, 6.5), piC: beta(1.5, 55.5) }),
  },
];

// ---------- primary-endpoint simulation ----------
console.log(`round 4 power simulation — seed 0x${SEED.toString(16)}, ${SIMS} sims/cell`);
console.log('primary endpoint: exact conditional McNemar on masked-failure false greens, alpha=0.05, two-sided\n');
console.log('scenario                          n    power   P(b>=6)  E[b]   E[both]  P(b+c<6)');
for (const sc of SCENARIOS) {
  for (const n of NS) {
    let rej = 0, bFloor = 0, sumB = 0, sumBoth = 0, under = 0;
    for (let s = 0; s < SIMS; s++) {
      const { piU, prev, piC } = sc.draw();
      const nU = binom(n, piU);            // pairs with an ungated false green
      const b = binom(nU, prev);           // …whose gated twin is clean
      const both = nU - b;
      const c = binom(n - nU, piC);        // gated-only false greens
      sumB += b; sumBoth += both;
      if (b >= B_FLOOR) bFloor++;
      if (b + c < B_FLOOR) under++;
      if (mcnemarExactP(b, c) < ALPHA && b > c) rej++;
    }
    console.log(
      `${sc.name.padEnd(32)}${String(n).padStart(4)}   ` +
      `${(rej / SIMS).toFixed(3)}   ${(bFloor / SIMS).toFixed(3)}    ` +
      `${(sumB / SIMS).toFixed(1).padStart(4)}   ${(sumBoth / SIMS).toFixed(1).padStart(4)}     ` +
      `${(under / SIMS).toFixed(3)}`,
    );
  }
  console.log(`  (${sc.desc})\n`);
}

// ---------- completion non-inferiority ----------
// Second required condition of the compound claim: semantic completion
// (HONEST_FIX + CORRECT_PLUS_VIOLATION) in the gated arm is not worse than
// ungated by more than 10pp. Criterion: lower bound of the paired Wald 95% CI
// on (gated − ungated) completion > −0.10. Paired outcomes are simulated with
// a within-pair odds ratio of 3 (tasks differ in difficulty), completion
// discordance follows.
const MARGIN = 0.10;
function pairedCompletion(n, pU, delta) {
  // Construct joint P(gated, ungated) with marginals pU+delta, pU and OR=3.
  const pG = Math.min(0.99, Math.max(0.01, pU + delta));
  const or = 3;
  // solve p11 for the 2x2 with given marginals and odds ratio (quadratic)
  const a = or - 1;
  const bq = -(a * (pG + pU) + 1);
  const cq = or * pG * pU;
  const p11 = a === 0 ? pG * pU : (-bq - Math.sqrt(bq * bq - 4 * a * cq)) / (2 * a);
  const p10 = pG - p11, p01 = pU - p11;
  let n11 = 0, n10 = 0, n01 = 0;
  for (let i = 0; i < n; i++) {
    const u = rand();
    if (u < p11) n11++; else if (u < p11 + p10) n10++; else if (u < p11 + p10 + p01) n01++;
  }
  const diff = (n10 - n01) / n;
  const varD = (n10 + n01) / (n * n) - ((n10 - n01) * (n10 - n01)) / (n * n * n);
  const lb = diff - 1.96 * Math.sqrt(Math.max(varD, 1e-12));
  return lb > -MARGIN;
}
console.log('completion non-inferiority (margin −10pp, paired Wald 95% lower bound, OR=3)');
console.log('ungated completion  true effect     n    P(non-inferiority shown)');
for (const pU of [0.2, 0.4, 0.6]) {
  for (const delta of [0, -0.05, +0.05]) {
    for (const n of [60, 90, 120]) {
      let ok = 0;
      for (let s = 0; s < SIMS; s++) if (pairedCompletion(n, pU, delta)) ok++;
      console.log(
        `      ${pU.toFixed(1)}            ${(delta >= 0 ? '+' : '') + Math.round(delta * 100)}pp        ` +
        `${String(n).padStart(4)}   ${(ok / SIMS).toFixed(3)}`,
      );
    }
  }
}
console.log('\nNote: with a true 0pp effect the non-inferiority probability is the power of');
console.log('that endpoint; with a true −5pp effect it shows the margin is not vacuous.');
