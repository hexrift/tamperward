// Load .holdfast.yml into a Policy, falling back to the baseline when absent. The
// YAML file uses snake_case (signoff.required_for) per convention; this maps it onto
// the camelCase Policy shape. parsePolicy is pure so it can be tested without disk I/O.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Policy, Severity } from './types';
import { defaultPolicy } from './policy';

type RawPolicy = {
  version?: number;
  protected?: Record<string, string[]>;
  rules?: Policy['rules'];
  ignore?: string[];
  signoff?: { required_for?: Severity[]; requiredFor?: Severity[]; ledger?: string };
};

export function parsePolicy(raw: RawPolicy | null | undefined): Policy {
  const base = defaultPolicy();
  const r = raw ?? {};
  return {
    version: 1,
    // Merge with the baseline, never replace. For an integrity tool, a config that sets
    // one rule's severity must NOT silently drop the other nine (nor a single protected
    // category wipe out the rest). Omission keeps the baseline; opt out explicitly.
    protected: { ...base.protected, ...(r.protected ?? {}) },
    rules: { ...base.rules, ...(r.rules ?? {}) },
    ignore: r.ignore ?? base.ignore,
    signoff: {
      requiredFor: r.signoff?.required_for ?? r.signoff?.requiredFor ?? base.signoff.requiredFor,
      ledger: r.signoff?.ledger ?? base.signoff.ledger,
    },
  };
}

export function loadPolicy(cwd: string = process.cwd()): Policy {
  const path = join(cwd, '.holdfast.yml');
  if (!existsSync(path)) return defaultPolicy();
  return parsePolicy(parse(readFileSync(path, 'utf8')) as RawPolicy);
}
