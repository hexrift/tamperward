// Dependency-free re-validation of prepared audit events, for the privileged
// `publish` job. That job must run NO `npm ci` and NO candidate/dependency code,
// so it cannot use the built CLI's parser; instead this validates each event
// against the COMMITTED, trusted schema (schemas/audit-v1.schema.json) using only
// Node builtins. It is a defense-in-depth gate: the `prepare` job already
// validated with the canonical parser (and pre-merge CI validates committed
// batches), but this ensures the write step never appends anything that does not
// match the schema, even if an upstream build step were compromised.
//
// It implements exactly the JSON-Schema subset audit-v1 uses: required, per-
// property `const` / `enum` / `pattern` / `type: string`, and
// `additionalProperties: false`. Anything else in the schema would need support
// added here — fail closed rather than pass silently.
//
// Usage: node audit-verify.mjs <schemaPath> <jsonlPath>

import { readFileSync } from 'node:fs';

const [schemaPath, dataPath] = process.argv.slice(2);
if (!schemaPath || !dataPath) {
  console.error('usage: audit-verify.mjs <schemaPath> <jsonlPath>');
  process.exit(2);
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const props = schema.properties ?? {};
const required = schema.required ?? [];
const additionalAllowed = schema.additionalProperties !== false;

// Refuse to "pass" a schema whose constraints this validator does not understand,
// so a future schema change can never be silently under-enforced here.
const SUPPORTED = new Set(['const', 'enum', 'pattern', 'type']);
for (const [key, def] of Object.entries(props)) {
  for (const kw of Object.keys(def)) {
    if (!SUPPORTED.has(kw)) {
      throw new Error(`audit-verify: unsupported schema keyword "${kw}" on property "${key}"; update audit-verify.mjs`);
    }
    if (kw === 'type' && def.type !== 'string') {
      throw new Error(`audit-verify: unsupported type "${def.type}" on property "${key}"; update audit-verify.mjs`);
    }
  }
}

const lines = readFileSync(dataPath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
let n = 0;
for (const line of lines) {
  n++;
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    throw new Error(`audit-verify: line ${n} is not valid JSON`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`audit-verify: line ${n} is not a JSON object`);
  for (const key of required) {
    if (!(key in v)) throw new Error(`audit-verify: line ${n} is missing required field "${key}"`);
  }
  for (const [key, value] of Object.entries(v)) {
    const def = props[key];
    if (!def) {
      if (!additionalAllowed) throw new Error(`audit-verify: line ${n} has unsupported field "${key}"`);
      continue;
    }
    if ('const' in def && value !== def.const) throw new Error(`audit-verify: line ${n} field "${key}" must equal ${JSON.stringify(def.const)}`);
    if (def.enum && !def.enum.includes(value)) throw new Error(`audit-verify: line ${n} field "${key}" is not one of ${JSON.stringify(def.enum)}`);
    if (def.type === 'string' && typeof value !== 'string') throw new Error(`audit-verify: line ${n} field "${key}" must be a string`);
    if (def.pattern) {
      if (typeof value !== 'string' || !new RegExp(def.pattern).test(value)) {
        throw new Error(`audit-verify: line ${n} field "${key}" does not match ${def.pattern}`);
      }
    }
  }
}
console.error(`audit-verify: ${n} event(s) valid against ${schemaPath}`);
