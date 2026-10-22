import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { inspectPath, inspectRel } from '../disk';
import { repoRoot } from '../repo-context';
import { treeFingerprint } from '../fingerprint';
import { trustedGitEnv } from '../git/trusted';
import { prepareVerifierBackend, runContainerStage } from '../verifier-backend';
import { evaluateOracleCases, oracleProgram, parseOraclePlan, type OracleEvaluation } from '../external-oracle';
import { materialize, probeFilesystemCaseSensitivity } from './verify';

export interface ExternalOracleOpts { cwd: string; manifest: string; sha256: string }
export function runExternalOracle(opts: ExternalOracleOpts): number {
  const cwd = repoRoot(opts.cwd);
  let temp: string | undefined;
  const emit = (result: OracleEvaluation, binding?: { head: string; tree: string; manifest: string; image: string }): number => {
    process.stdout.write(JSON.stringify({ schema_version: 1, ...result, ...(binding ? { binding } : {}), oracle_assurance: {
      level: 'external-json-rpc', assertions_outside_candidate: true,
      candidate_controls_rpc_response: true, scope: 'CommonJS JSON function-response cases only; no framework-wide or exhaustive semantic guarantee',
    } }) + '\n');
    return result.verdict === 'VERIFIED' ? 0 : result.verdict === 'ORACLE_RED' ? 1 : 2;
  };
  let planned = 0;
  try {
    if (!isAbsolute(opts.manifest) || !/^[a-f0-9]{64}$/.test(opts.sha256)) throw new Error('oracle requires an absolute external manifest and its SHA-256 pin');
    const rel = relative(realpathSync(cwd), realpathSync(opts.manifest));
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw new Error('oracle manifest must be outside the candidate repository');
    const entry = inspectPath(opts.manifest);
    if (entry.kind !== 'file' || !entry.content || entry.content.length > 256 * 1024 || createHash('sha256').update(entry.content).digest('hex') !== opts.sha256) throw new Error('oracle manifest is unavailable, oversized, non-regular or differently pinned');
    const plan = parseOraclePlan(JSON.parse(entry.content.toString('utf8')));
    planned = plan.cases.length;
    const backend = prepareVerifierBackend({ command: '', budget: plan.budget_secs, backend: 'container', image: plan.image });
    if (!backend.available) throw new Error('isolated oracle backend unavailable');
    const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: trustedGitEnv(), maxBuffer: 1 << 28 });
    const head = git(['rev-parse', 'HEAD']).trim();
    const tree = treeFingerprint(cwd);
    const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
    for (const path of paths) {
      const e = inspectRel(cwd, path);
      if (!['file', 'symlink'].includes(e.kind) || e.content === null) throw new Error('unsupported oracle candidate entry');
    }
    const snapshot = mkdtempSync(join(tmpdir(), 'tw-external-oracle-'));
    temp = snapshot;
    if (!probeFilesystemCaseSensitivity(snapshot)) throw new Error('oracle snapshot requires a case-sensitive filesystem');
    materialize(cwd, snapshot, null);
    for (const path of paths) {
      const source = inspectRel(cwd, path), copy = inspectRel(snapshot, path);
      if (source.kind !== copy.kind || source.mode !== copy.mode || !source.content || !copy.content || !source.content.equals(copy.content)) throw new Error('oracle snapshot changed');
    }
    if (treeFingerprint(cwd) !== tree || git(['rev-parse', 'HEAD']).trim() !== head) throw new Error('oracle candidate changed during snapshot');
    const result = evaluateOracleCases(plan, (request, budget) => runContainerStage(backend, snapshot, oracleProgram(request), budget));
    if (treeFingerprint(cwd) !== tree || git(['rev-parse', 'HEAD']).trim() !== head) throw new Error('oracle candidate changed during evaluation');
    return emit(result, { head, tree, manifest: opts.sha256, image: plan.image });
  } catch {
    return emit({ verdict: 'CANNOT_VERIFY', planned, completed: 0, passed: 0, reason: 'EXECUTION_FAILED' });
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
export function runOracle(args: string[]): number {
  let cwd = process.cwd(), manifest = '', sha256 = '';
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--cwd', '--manifest', '--sha256'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('invalid oracle arguments');
    seen.add(flag);
    if (flag === '--cwd') cwd = value;
    if (flag === '--manifest') manifest = value;
    if (flag === '--sha256') sha256 = value;
  }
  return runExternalOracle({ cwd, manifest, sha256 });
}
