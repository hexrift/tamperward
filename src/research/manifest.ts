// The task manifest `tamperward research run` executes. Deliberately small:
// a task is a repository, a base revision, a prompt and the suite command the
// pristine verifier runs — the same `verify: { command, budget }` shape the
// policy file uses. The manifest's sha256 is pinned into every record it
// produces, so a ledger can never silently mix two task sets.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { finiteNumber, isRecord } from '../narrow';
import { ResearchError } from './adapter';

export interface ResearchTask {
  id: string;
  /** Absolute path (or URL) of the repository to clone for every trajectory. */
  repo: string;
  /** The revision the trusted base is resolved from in the clone. */
  base: string;
  prompt: string;
  verify: { command: string; budget?: number };
}

export interface ResearchManifest {
  path: string;
  sha256: string;
  tasks: ResearchTask[];
}

export const MANIFEST_VERSION = 1;

function taskFrom(raw: unknown, index: number, manifestDir: string): ResearchTask {
  const where = `task #${index + 1}`;
  if (!isRecord(raw)) throw new ResearchError(`task manifest: ${where} is not an object`);
  const { id, repo, base, prompt, verify } = raw;
  if (typeof id !== 'string' || !id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ResearchError(`task manifest: ${where} needs a string id of [A-Za-z0-9._-] (it names the record files)`);
  }
  if (typeof repo !== 'string' || !repo) throw new ResearchError(`task manifest: task "${id}" needs a repo`);
  if (typeof prompt !== 'string' || !prompt) throw new ResearchError(`task manifest: task "${id}" needs a prompt`);
  if (base !== undefined && (typeof base !== 'string' || !base)) {
    throw new ResearchError(`task manifest: task "${id}" base must be a revision string`);
  }
  if (!isRecord(verify) || typeof verify.command !== 'string' || !verify.command) {
    throw new ResearchError(`task manifest: task "${id}" needs verify.command (the suite the pristine verifier runs)`);
  }
  const budget = verify.budget === undefined ? undefined : finiteNumber(verify.budget);
  if (verify.budget !== undefined && (budget === undefined || budget <= 0)) {
    throw new ResearchError(`task manifest: task "${id}" verify.budget must be a positive number of seconds`);
  }
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || /^[^/]+@[^:]+:/.test(repo);
  return {
    id,
    repo: isUrl ? repo : resolve(manifestDir, repo),
    base: base ?? 'HEAD',
    prompt,
    verify: { command: verify.command, ...(budget !== undefined ? { budget } : {}) },
  };
}

export function readManifest(path: string): ResearchManifest {
  const abs = resolve(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (e) {
    throw new ResearchError(`cannot read task manifest ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ResearchError(`task manifest ${abs} is not valid JSON`);
  }
  if (!isRecord(raw)) throw new ResearchError(`task manifest ${abs}: top level must be an object`);
  if (raw.version !== MANIFEST_VERSION) {
    throw new ResearchError(`task manifest ${abs}: version must be ${MANIFEST_VERSION} (got ${JSON.stringify(raw.version)})`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new ResearchError(`task manifest ${abs}: no tasks (tasks must be a non-empty array)`);
  }
  const tasks = raw.tasks.map((t, i) => taskFrom(t, i, dirname(abs)));
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new ResearchError(`task manifest ${abs}: duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  return { path: abs, sha256: createHash('sha256').update(bytes).digest('hex'), tasks };
}
