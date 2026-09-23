// Author a minimal, versioned research manifest without hand-writing JSON.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { ResearchError } from './adapter';
import { readManifest } from './manifest';

export interface ResearchInitOpts {
  out: string;
  repo: string;
  base?: string;
  id?: string;
  prompt: string;
  verifyCommand: string;
  verifyBudget?: number;
}

function idFrom(repo: string): string {
  const clean = repo.replace(/[\\/]$/, '').split(/[\\/]/).pop() || 'task';
  return (basename(clean, '.git').replace(/[^A-Za-z0-9._-]+/g, '-') || 'task').slice(0, 80);
}

export function createResearchManifest(opts: ResearchInitOpts): string {
  if (!opts.out) throw new ResearchError('research init requires --out');
  if (!opts.repo) throw new ResearchError('research init requires --repo');
  if (!opts.prompt) throw new ResearchError('research init requires --prompt');
  if (!opts.verifyCommand) throw new ResearchError('research init requires --verify-command');
  const out = resolve(opts.out);
  if (existsSync(out)) throw new ResearchError(`research init refuses to overwrite ${out}; choose a new path`);
  const id = opts.id ?? idFrom(opts.repo);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new ResearchError(`research init id must match [A-Za-z0-9._-] (got "${id}")`);
  if (opts.verifyBudget !== undefined && (!Number.isFinite(opts.verifyBudget) || opts.verifyBudget <= 0)) {
    throw new ResearchError('research init --verify-budget must be positive');
  }
  const doc = {
    version: 1,
    tasks: [{
      id,
      repo: opts.repo,
      base: opts.base ?? 'HEAD',
      prompt: opts.prompt,
      verify: { command: opts.verifyCommand, ...(opts.verifyBudget === undefined ? {} : { budget: opts.verifyBudget }) },
    }],
  };
  const text = JSON.stringify(doc, null, 2) + '\n';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, { flag: 'wx', mode: 0o600 });
  const parsed = readManifest(out);
  if (parsed.tasks.length !== 1 || parsed.tasks[0].id !== id) throw new ResearchError(`research init wrote an invalid manifest ${out}`);
  return out;
}

export function runResearchInit(opts: ResearchInitOpts): number {
  try {
    const out = createResearchManifest(opts);
    const bytes = requireHash(out);
    process.stdout.write(`tamperward research init: wrote ${out} (sha256 ${bytes})\n`);
    return 0;
  } catch (e) {
    if (e instanceof ResearchError || e instanceof Error) {
      process.stderr.write(`tamperward research: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

function requireHash(path: string): string {
  // readManifest already verifies the JSON; importing the bytes here keeps the
  // displayed identity exactly equal to the file that the runner will pin.
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
