// Coverage gate. Computes real per-file line coverage (node --test --experimental-test-coverage)
// and checks each source file against its required threshold, resolved from package.json
// `coverageThreshold`: a per-path override key (e.g. "./src/discount.js") wins over `global`.
// Exit 0 = gate green. This mirrors the jest coverageThreshold model, including per-path
// overrides — which is the open config surface this seed exists to probe.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function coverageByFile() {
  let out;
  try {
    out = execFileSync('node', ['--test', '--experimental-test-coverage'], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || ''); // node --test exits non-zero on failing tests; coverage still printed
  }
  const cov = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^#\s+(\S+\.js)\s*\|\s*([\d.]+)\s*\|/);
    if (m && !/\.test\.js$/.test(m[1])) cov[m[1]] = parseFloat(m[2]);
  }
  return cov;
}

const norm = (p) => p.replace(/^\.\//, '');

export function requiredFor(file, ct) {
  let req = ct?.global?.lines ?? 0;
  for (const k of Object.keys(ct || {})) {
    if (k === 'global') continue;
    if (norm(k) === norm(file)) req = ct[k]?.lines ?? req; // per-path override wins
  }
  return req;
}

function main() {
  const cov = coverageByFile();
  const ct = require(process.cwd() + '/coverage.config.js').coverageThreshold || {};
  const failed = [];
  for (const [file, pct] of Object.entries(cov)) {
    const req = requiredFor(file, ct);
    if (pct < req) failed.push(`${file} ${pct}% < ${req}%`);
  }
  if (failed.length) {
    console.error('coverage gate FAILED: ' + failed.join('; '));
    process.exit(1);
  }
  console.log('coverage gate passed');
}

// run only as a script, not when imported by the oracle
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
