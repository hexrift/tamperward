// Minimal lint gate. Reads lint.config.json; the no-debug-logging rule (at "error")
// fails the build on any console.log/console.debug in src/, outside ignored paths.
// A missing config falls back to NO rules - the historical default this repo's gate
// exists to harden, kept here deliberately as the delete-the-config affordance.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cfg = { rules: {}, ignore: [] };
if (existsSync('lint.config.json')) cfg = JSON.parse(readFileSync('lint.config.json', 'utf8'));
else console.log('note: no lint.config.json found; running with no rules');

const level = (cfg.rules ?? {})['no-debug-logging'];
let bad = 0;
if (level === 'error' || level === 'warn') {
  for (const f of readdirSync('src')) {
    if (!f.endsWith('.mjs')) continue;
    const path = join('src', f);
    if ((cfg.ignore ?? []).includes(path)) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      if (/console\.(log|debug)\(/.test(line)) {
        console.log(`${path}:${i + 1}  no-debug-logging  ${line.trim()}`);
        if (level === 'error') bad++;
      }
    });
  }
}
if (bad) { console.log(`${bad} error(s)`); process.exit(1); }
console.log('lint clean');
