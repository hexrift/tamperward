// Forward-version guard for the release workflow (#548).
//
// A registry LOOKUP FAILURE must never be mistaken for an absent dist-tag. The
// old inline guard queried `npm view ... 2>/dev/null || true`, so a transient,
// 5xx, auth or malformed response produced an empty string exactly like a
// genuinely missing tag — silently skipping the anti-downgrade comparison and
// permitting a backward `latest`/`next` move. Here each query resolves to one of
// three outcomes: present (validated semver), absent (a structured not-found), or
// failure (retried a bounded number of times, then it stops the release).
//
// Pure functions are exported so the workflow logic is unit-tested against mocked
// registry responses without ever publishing.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

const PACKAGE = 'tamperward';
const NOT_FOUND = /^E404$/;

/** The npm error code carried in a `--json` error payload, or null. */
function errorCode(text) {
  try {
    const j = JSON.parse(text);
    return (j && j.error && typeof j.error.code === 'string') ? j.error.code : null;
  } catch {
    return null;
  }
}

/**
 * Classify one `npm view <pkg>@<tag> version --json` invocation.
 * @param {{ status: number|null, stdout?: string, stderr?: string }} r
 * @returns {{kind:'present',version:string}|{kind:'absent'}|{kind:'failure',detail:string}}
 */
export function classifyView(r) {
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  if (r.status === 0) {
    // A successful query must return a concrete semver. Empty stdout, JSON null,
    // an array without a version, or a non-semver token is an unexpected
    // registry/client response — NOT proof the tag is absent — so it fails closed
    // (retried, then blocks). Absence is only ever a structured not-found, below.
    let v = null;
    try {
      const p = JSON.parse(out);
      if (typeof p === 'string') v = p;
      else if (Array.isArray(p) && typeof p[0] === 'string') v = p[0]; // npm 12 wraps in an array
    } catch {
      if (out !== '') v = out; // tolerate a bare (non-JSON) version line
    }
    v = v === null ? '' : String(v).trim();
    if (v !== '' && semver.valid(v)) return { kind: 'present', version: v };
    return { kind: 'failure', detail: `unexpected zero-exit registry response: ${JSON.stringify(out).slice(0, 120)}` };
  }
  // Non-zero exit: ABSENCE is permitted ONLY on npm's STRUCTURED not-found code.
  // A free-form "404"-looking string without that code could be a proxy/auth/
  // registry anomaly, so it is a failure — never a confirmed missing tag.
  const code = errorCode(out) || errorCode(err);
  if (code && NOT_FOUND.test(code)) return { kind: 'absent' };
  return { kind: 'failure', detail: code ? `registry error ${code}` : (err.split('\n').pop() || `npm view exited ${r.status}`) };
}

/** Block synchronously without a busy loop, so bounded backoff works in the sync flow. */
function syncSleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Query one dist-tag, retrying only bounded transient FAILURES (never an absent
 * tag or a present value). Returns the last classification.
 */
export function queryTag(tag, runNpm, { retries = 2, sleep = (attempt) => syncSleep(1000 * 2 ** attempt) } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = classifyView(runNpm(tag));
    if (last.kind !== 'failure') return last;
    if (attempt < retries) sleep(attempt);
  }
  return last;
}

/**
 * Decide whether `version` may publish. A stable must exceed the current
 * `latest`; a prerelease must exceed both `latest` and `next`. A stable is NOT
 * compared against `next` (shipping a 2.x stable while a 3.0 rc sits on `next` is
 * legitimate). A lookup FAILURE for any tag that must be compared is fatal.
 * @returns {{ok:true}|{ok:false, reason:string, fatal?:boolean}}
 */
export function forwardDecision(version, latest, next) {
  const checks = [[latest, 'latest']];
  if (semver.prerelease(version)) checks.push([next, 'next']);
  for (const [cls, name] of checks) {
    if (cls.kind === 'failure') {
      return {
        ok: false,
        fatal: true,
        reason: `cannot read the current ${name} version from the registry (${cls.detail}); refusing to publish without the forward-version guard`,
      };
    }
    if (cls.kind === 'present' && !semver.satisfies(version, '>' + cls.version, { includePrerelease: true })) {
      return {
        ok: false,
        reason: `${version} is not greater than the current ${name} (${cls.version}) — refusing to publish a downgrade. If the bump is a typo, fix package.json; a deliberate re-publish of an older line needs this guard loosened first.`,
      };
    }
  }
  return { ok: true };
}

/** Real registry query for one tag, with an explicit per-attempt timeout so one
 *  hung query cannot stall the release beyond a bounded wall-clock — a timeout
 *  returns status !== 0, is classified as a failure, retried, then blocks. */
function realRunNpm(tag) {
  const r = spawnSync('npm', ['view', `${PACKAGE}@${tag}`, 'version', '--json'], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Full guard: query the tags this version must move past and decide. `next` is
 * only queried for a prerelease. Registry access is injectable for tests.
 */
export function main(version, deps = {}) {
  const runNpm = deps.runNpm ?? realRunNpm;
  const opts = { retries: deps.retries ?? 2, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const latest = queryTag('latest', runNpm, opts);
  const next = semver.prerelease(version) ? queryTag('next', runNpm, opts) : { kind: 'absent' };
  return forwardDecision(version, latest, next);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const version = process.argv[2];
  if (!version || !semver.valid(version)) {
    console.error(`::error::forward-guard: not a valid version to publish: ${JSON.stringify(version)}`);
    process.exit(1);
  }
  const decision = main(version);
  if (!decision.ok) {
    console.error(`::error::${decision.reason}`);
    process.exit(1);
  }
  console.log(`version ${version} moves forward`);
}
