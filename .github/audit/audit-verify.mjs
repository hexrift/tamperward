// Dependency-free audit-v1 validation for the write-authorized publisher.
// This module intentionally uses Node builtins only: no package install or
// candidate/dependency code may execute while the evidence-branch credential is
// present. The validator supports the complete JSON-Schema subset used by
// schemas/audit-v1.schema.json and rejects every unknown keyword recursively.
//
// Usage: node audit-verify.mjs <schemaPath> <jsonlPath>

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT_METADATA = new Set(['$schema', '$id', 'title', 'examples']);
const CONSTRAINTS = new Set([
  'type',
  'additionalProperties',
  'required',
  'properties',
  'allOf',
  'if',
  'then',
  'const',
  'enum',
  'pattern',
]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unsupported(keyword, path) {
  throw new Error(`audit-verify: unsupported schema keyword "${keyword}" at ${path}; update audit-verify.mjs`);
}

export function assertSupportedSchema(schema, path = 'schema', root = true) {
  if (!isObject(schema)) throw new Error(`audit-verify: ${path} must be a schema object`);

  for (const keyword of Object.keys(schema)) {
    if (!CONSTRAINTS.has(keyword) && !(root && ROOT_METADATA.has(keyword))) unsupported(keyword, path);
  }
  for (const keyword of ROOT_METADATA) {
    if (!(keyword in schema)) continue;
    if (keyword === 'examples') {
      if (!Array.isArray(schema[keyword])) {
        throw new Error(`audit-verify: ${path}.examples must be an array`);
      }
      continue;
    }
    if (typeof schema[keyword] !== 'string') {
      throw new Error(`audit-verify: ${path}.${keyword} must be a string`);
    }
  }
  if ('type' in schema && schema.type !== 'object' && schema.type !== 'string') {
    throw new Error(`audit-verify: unsupported type "${String(schema.type)}" at ${path}; update audit-verify.mjs`);
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`audit-verify: unsupported additionalProperties value at ${path}; update audit-verify.mjs`);
  }
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string')) {
      throw new Error(`audit-verify: ${path}.required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new Error(`audit-verify: ${path}.required contains a duplicate field`);
    }
  }
  if ('properties' in schema) {
    if (!isObject(schema.properties)) throw new Error(`audit-verify: ${path}.properties must be an object`);
    for (const [key, definition] of Object.entries(schema.properties)) {
      assertSupportedSchema(definition, `${path}.properties.${key}`, false);
    }
  }
  if ('allOf' in schema) {
    if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
      throw new Error(`audit-verify: ${path}.allOf must be a non-empty array`);
    }
    schema.allOf.forEach((definition, index) => {
      assertSupportedSchema(definition, `${path}.allOf[${index}]`, false);
    });
  }
  for (const keyword of ['if', 'then']) {
    if (keyword in schema) assertSupportedSchema(schema[keyword], `${path}.${keyword}`, false);
  }
  if ('if' in schema && !('then' in schema)) {
    throw new Error(`audit-verify: ${path}.if requires a supported then constraint`);
  }
  if ('then' in schema && !('if' in schema)) {
    throw new Error(`audit-verify: ${path}.then requires an if constraint`);
  }
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`audit-verify: ${path}.enum must be a non-empty array`);
  }
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') throw new Error(`audit-verify: ${path}.pattern must be a string`);
    try {
      new RegExp(schema.pattern);
    } catch {
      throw new Error(`audit-verify: ${path}.pattern is not a valid regular expression`);
    }
  }
}

function validationErrors(schema, value, path) {
  const errors = [];
  const objectValue = isObject(value);

  if (schema.type === 'object' && !objectValue) errors.push(`${path} must be a JSON object`);
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} must be a string`);
  if ('const' in schema && !sameValue(value, schema.const)) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push(`${path} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) {
    errors.push(`${path} does not match ${schema.pattern}`);
  }

  if (objectValue) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path} is missing required field "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const definition = properties[key];
      if (!definition) {
        if (schema.additionalProperties === false) errors.push(`${path} has unsupported field "${key}"`);
        continue;
      }
      errors.push(...validationErrors(definition, child, `${path} field "${key}"`));
    }
  }

  for (const definition of schema.allOf ?? []) errors.push(...validationErrors(definition, value, path));
  if (schema.if && validationErrors(schema.if, value, path).length === 0) {
    errors.push(...validationErrors(schema.then, value, path));
  }
  return errors;
}

export function loadAuditSchema(schemaPath) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (error) {
    throw new Error(`audit-verify: cannot read schema ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSupportedSchema(schema);
  return schema;
}

export function validateAuditJsonl(schema, raw, label = 'audit') {
  const events = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`audit-verify: ${label} line ${index + 1} is not valid JSON`);
    }
    const errors = validationErrors(schema, value, `${label} line ${index + 1}`);
    if (errors.length) throw new Error(`audit-verify: ${errors[0]}`);
    events.push(value);
  });
  return events;
}

function main() {
  const [schemaPath, dataPath] = process.argv.slice(2);
  if (!schemaPath || !dataPath) {
    console.error('usage: audit-verify.mjs <schemaPath> <jsonlPath>');
    process.exitCode = 2;
    return;
  }
  try {
    const schema = loadAuditSchema(schemaPath);
    const events = validateAuditJsonl(schema, readFileSync(dataPath, 'utf8'));
    console.error(`audit-verify: ${events.length} event(s) valid against ${schemaPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
