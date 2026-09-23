// Local verification receipts and their CI reconciliation (#601).
//
// The property that matters most for a security tool has its own block below:
// a receipt is EVIDENCE, never authority. No receipt state — matching, stale,
// verifier-mismatched, policy-mismatched, malformed, tampered, missing or
// unknown-schema — can ever promote or strengthen CI's verdict. Every
// reconciliation's `result` is CI's own adjudication, full stop.

import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runVerify, type VerifyOpts } from '../src/cli/verify';
import { runReceiptExport, runReceiptReconcile } from '../src/cli/receipt';
import {
  classifyReceipt,
  reconcile,
  receiptEvidenceDigest,
  receiptFromRecord,
  receiptPath,
  type VerificationReceipt,
} from '../src/verification-receipt';
import {
  computeBinding,
  readVerificationRecord,
  type VerificationBinding,
  type VerificationInputs,
} from '../src/verification-state';

const ROOT = resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function initGit(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 't'], { cwd });
  execFileSync('git', ['config', 'user.email', 't@b'], { cwd });
}

/** A repo whose original suite asserts src.js === 42. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'tw-receipt-'));
  dirs.push(cwd);
  initGit(cwd);
  writeFileSync(join(cwd, 'src.js'), 'module.exports = 42;\n');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(
    join(cwd, 'test', 'check.test.js'),
    "const v=require('../src.js'); if(v!==42){console.error('bad');process.exit(1)}\n",
  );
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  return cwd;
}

function capture(fn: () => number): { code: number; out: string } {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const code = fn();
  vi.restoreAllMocks();
  return { code, out };
}

const VERIFY_ARGS = { base: 'HEAD', cmd: 'node test/check.test.js', budget: 4 } as const;

function inputsFor(cwd: string, budget = VERIFY_ARGS.budget): VerificationInputs {
  return {
    base_ref: 'HEAD',
    explicit_base: true,
    command_source: 'flag',
    command: VERIFY_ARGS.cmd,
    budget_source: 'flag',
    budget,
  };
}

/** Run a real verify to a verdict (records + stores a receipt on VERIFIED). */
function verify(cwd: string, extra: Partial<VerifyOpts> = {}): number {
  return capture(() => runVerify({ cwd, ...VERIFY_ARGS, ...extra, silent: true })).code;
}

function storedReceipt(cwd: string): VerificationReceipt {
  const p = receiptPath(cwd)!;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** A valid PRESENT receipt for an arbitrary binding + verdict claim. */
function craftReceipt(binding: VerificationBinding): VerificationReceipt {
  const core = {
    schema_version: 1 as const,
    verdict: 'VERIFIED' as const,
    binding,
    stages: { candidate: 'PASS' as const, pristine: 'PASS' as const, integrity: 'CLEAN' as const },
  };
  return { ...core, tw_version: 'test', verified_at: '2026-01-01T00:00:00.000Z', evidence_digest: receiptEvidenceDigest(core) };
}

/** A path OUTSIDE any repo worktree — writing an artifact into `cwd` would add an
 *  untracked file to the tree fingerprint and change the very identity under test. */
function tmpFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'tw-receipt-art-'));
  dirs.push(d);
  return join(d, name);
}

function writeReceipt(_cwd: string, r: unknown): string {
  const p = tmpFile('receipt.json');
  writeFileSync(p, JSON.stringify(r));
  return p;
}

function ajv(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}
function validateReconcile(doc: unknown): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'reconcile-v1.schema.json'), 'utf8'));
  const validate = ajv().compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
function validateReceiptDoc(doc: unknown): string[] {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'receipt-v1.schema.json'), 'utf8'));
  const validate = ajv().compile(schema);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

describe('local verification receipt emission (#601)', () => {
  it('a successful verify emits a receipt bound to the EXACT verified state, and it self-validates', () => {
    const cwd = repo();
    expect(verify(cwd)).toBe(0);
    const p = receiptPath(cwd)!;
    expect(existsSync(p)).toBe(true);
    const receipt = storedReceipt(cwd);
    expect(receipt.verdict).toBe('VERIFIED');
    // Binds #600's identity verbatim — no parallel notion of "what was verified".
    const record = readVerificationRecord(cwd)!;
    expect(receipt.binding).toEqual(record.binding);
    // Self-consistent evidence digest, and valid against the published schema.
    expect(classifyReceipt(receipt).disposition).toBe('PRESENT');
    expect(validateReceiptDoc(receipt)).toEqual([]);
  }, 30_000);

  it('a non-VERIFIED verify emits no receipt (only a genuine pass vouches for a state)', () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 41;\n'); // suite now red
    expect(verify(cwd)).toBe(1);
    // No prior receipt existed, and a red adjudication writes none.
    expect(existsSync(receiptPath(cwd)!)).toBe(false);
  }, 30_000);

  it('the receipt is bounded and non-sensitive: only the fixed evidence fields, no local paths', () => {
    const cwd = repo();
    verify(cwd);
    const receipt = storedReceipt(cwd);
    expect(Object.keys(receipt).sort()).toEqual(
      ['binding', 'evidence_digest', 'schema_version', 'stages', 'tw_version', 'verdict', 'verified_at'].sort(),
    );
    const raw = readFileSync(receiptPath(cwd)!, 'utf8');
    // No absolute local path (the checkout dir), no command body, no env leakage.
    expect(raw).not.toContain(cwd);
    expect(raw).not.toContain('check.test.js');
    expect(raw).not.toContain('/home/');
    expect(raw.length).toBeLessThan(2048); // bounded by construction
  }, 30_000);
});

describe('receipt export (explicit transport) (#601)', () => {
  it('exports the CURRENT verified receipt to a file that reconciles as AGREE', () => {
    const cwd = repo();
    verify(cwd);
    const out = tmpFile('exported.json');
    expect(capture(() => runReceiptExport({ cwd, out })).code).toBe(0);
    const exported = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateReceiptDoc(exported)).toEqual([]);
    expect(exported.binding).toEqual(storedReceipt(cwd).binding);
  }, 30_000);

  it('refuses to export when the state is not CURRENT (nothing honest to vouch for)', () => {
    const cwd = repo();
    // Never verified → UNVERIFIED → export refuses, fail-closed exit 2.
    const x = tmpFile('x.json');
    expect(capture(() => runReceiptExport({ cwd, out: x })).code).toBe(2);
    expect(existsSync(x)).toBe(false);
  });
});

describe('CI reconciliation reruns canonical checks, then reconciles (#601)', () => {
  it('matching evidence on the exact state → AGREE, result VERIFIED, exit 0', () => {
    const cwd = repo();
    verify(cwd);
    const rc = writeReceipt(cwd, storedReceipt(cwd));
    const { code, out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.result).toBe('VERIFIED');
    expect(doc.ci.verdict).toBe('VERIFIED');
    expect(doc.reconciliation.agreement).toBe('AGREE');
    expect(doc.reconciliation.applicable).toBe(true);
    expect(validateReconcile(doc)).toEqual([]);
    expect(code).toBe(0);
  }, 40_000);

  it('the human summary separates LOCAL / CI / RESULT and agreement', () => {
    const cwd = repo();
    verify(cwd);
    const rc = writeReceipt(cwd, storedReceipt(cwd));
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc }));
    expect(out).toContain('LOCAL');
    expect(out).toContain('CI');
    expect(out).toContain('RESULT');
    expect(out).toContain('VERIFIED');
    expect(out).toContain('agree');
  }, 40_000);

  it('a stale tree → NON_APPLICABLE (tree), never counted as agreement; result is CI verdict', () => {
    const cwd = repo();
    verify(cwd);
    const rc = writeReceipt(cwd, storedReceipt(cwd));
    // Change the tree but keep the suite green (a comment-only edit to src.js).
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 42; // edited\n');
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.reconciliation.agreement).toBe('NON_APPLICABLE');
    expect(doc.reconciliation.mismatched_input).toBe('tree');
    expect(doc.result).toBe(doc.ci.verdict); // CI is authority; the stale receipt cannot vouch
  }, 40_000);

  it('a verifier-config mismatch → NON_APPLICABLE (verifier)', () => {
    const cwd = repo();
    verify(cwd); // receipt bound to budget 4
    const rc = writeReceipt(cwd, storedReceipt(cwd));
    // Reconcile under a different budget → CI's verifier identity differs.
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, budget: 7, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.reconciliation.agreement).toBe('NON_APPLICABLE');
    expect(doc.reconciliation.mismatched_input).toBe('verifier');
  }, 40_000);

  it('a policy mismatch → NON_APPLICABLE (policy)', () => {
    const cwd = repo();
    verify(cwd);
    // A valid receipt (correct evidence_digest) whose policy binding is bogus.
    const tampered = { ...storedReceipt(cwd) };
    const binding = { ...tampered.binding, policy: 'deadbeef' };
    const crafted = craftReceipt(binding);
    const rc = writeReceipt(cwd, crafted);
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(classifyReceipt(crafted).disposition).toBe('PRESENT'); // valid, just describes another state
    expect(doc.reconciliation.agreement).toBe('NON_APPLICABLE');
    expect(doc.reconciliation.mismatched_input).toBe('policy');
  }, 40_000);

  it('a tampered receipt (binding edited, digest stale) → MALFORMED, ignored as evidence', () => {
    const cwd = repo();
    verify(cwd);
    const tampered = storedReceipt(cwd);
    tampered.binding.tree = 'f'.repeat(16); // edit a binding field, keep old digest
    const rc = writeReceipt(cwd, tampered);
    expect(classifyReceipt(tampered).disposition).toBe('MALFORMED');
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.local.disposition).toBe('MALFORMED');
    expect(doc.reconciliation.agreement).toBe('NON_APPLICABLE');
    expect(doc.result).toBe(doc.ci.verdict);
  }, 40_000);

  it('an unknown schema/version → UNKNOWN_SCHEMA, fails safe, cannot strengthen CI', () => {
    const cwd = repo();
    verify(cwd);
    const future = { ...storedReceipt(cwd), schema_version: 2 };
    const rc = writeReceipt(cwd, future);
    const { out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.local.disposition).toBe('UNKNOWN_SCHEMA');
    expect(doc.reconciliation.agreement).toBe('NON_APPLICABLE');
    expect(doc.result).toBe('VERIFIED'); // CI's own verdict, not the receipt's
  }, 40_000);

  it('a missing receipt → NO_CLAIM; absence is not an enforcement failure', () => {
    const cwd = repo();
    // No stored receipt, none provided. Use --ci-result so no verify writes one.
    const ciResult = tmpFile('ci-verify.json');
    writeFileSync(ciResult, JSON.stringify({ schema_version: 1, verdict: 'VERIFIED' }));
    const { code, out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, ciResult, json: true }));
    const doc = JSON.parse(out);
    expect(doc.local.disposition).toBe('ABSENT');
    expect(doc.reconciliation.agreement).toBe('NO_CLAIM');
    expect(doc.result).toBe('VERIFIED');
    expect(code).toBe(0); // CI verified; no receipt does not fail the build
  }, 40_000);
});

describe('the receipt can NEVER promote a failing or unknown CI result (#601)', () => {
  it('local-green / CI-red on the SAME state → DIVERGENCE, result SUITE_RED, exit 1', () => {
    const cwd = repo();
    // Break the suite so CI adjudicates SUITE_RED.
    writeFileSync(join(cwd, 'src.js'), 'module.exports = 999;\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-qm', 'break'], { cwd });
    // Forge a VERIFIED receipt bound to the EXACT current (red) state.
    const binding = computeBinding(cwd, inputsFor(cwd));
    const forged = craftReceipt(binding);
    expect(classifyReceipt(forged).disposition).toBe('PRESENT');
    const rc = writeReceipt(cwd, forged);
    const { code, out } = capture(() => runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true }));
    const doc = JSON.parse(out);
    expect(doc.reconciliation.applicable).toBe(true); // it really is this state
    expect(doc.reconciliation.agreement).toBe('DIVERGENCE');
    expect(doc.ci.verdict).toBe('SUITE_RED');
    expect(doc.result).toBe('SUITE_RED'); // NOT promoted to VERIFIED
    expect(doc.result).not.toBe('VERIFIED');
    expect(code).toBe(1); // stays failed
  }, 40_000);

  it('reconcile reruns verify FIRST and forwards ITS verdict — a VERIFIED receipt over a red CI stays red', () => {
    const cwd = repo();
    verify(cwd);
    const goodReceipt = storedReceipt(cwd); // a genuine VERIFIED receipt
    const rc = writeReceipt(cwd, goodReceipt);
    // Deterministic seam: CI's verify returns SUITE_RED regardless of the receipt.
    let ranVerifyFirst = false;
    const fakeVerify: typeof runVerify = (opts) => {
      ranVerifyFirst = true;
      opts.onVerdict?.({ verdict: 'SUITE_RED' });
      return 1;
    };
    // The receipt binding still matches (unchanged tree), so this is a genuine
    // divergence, and the result is CI's SUITE_RED — the receipt cannot flip it.
    const { code, out } = capture(() =>
      runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, json: true, runVerifyImpl: fakeVerify }),
    );
    const doc = JSON.parse(out);
    expect(ranVerifyFirst).toBe(true);
    expect(doc.ci.verdict).toBe('SUITE_RED');
    expect(doc.result).toBe('SUITE_RED');
    expect(code).toBe(1);
  }, 30_000);

  it('the reconcile invariant holds for EVERY claimed-receipt disposition (pure unit)', () => {
    const binding = {
      tree: 't', head: 'h', base: 'b', policy: 'p', verifier: 'v', surface: 's', intervention: 'i', dependencies: 'd',
    } as VerificationBinding;
    const good = craftReceipt(binding);
    const claims = [
      classifyReceipt(good), // PRESENT, matching
      classifyReceipt(null), // ABSENT
      classifyReceipt({ ...good, schema_version: 2 }), // UNKNOWN_SCHEMA
      classifyReceipt({ ...good, evidence_digest: 'sha256:0' }), // MALFORMED (tampered)
    ];
    for (const verdict of ['VERIFIED', 'SUITE_RED', 'MASKED_FAILURE', 'BUDGET_EXCEEDED', 'CANNOT_VERIFY'] as const) {
      for (const claimed of claims) {
        const r = reconcile({ verdict, binding }, claimed);
        // The one invariant: result is ALWAYS CI's verdict, never the receipt's.
        expect(r.result).toBe(verdict);
        if (verdict !== 'VERIFIED') expect(r.result).not.toBe('VERIFIED');
      }
    }
  });
});

describe('machine-readable reconciliation & --ci-result transport (#601)', () => {
  it('consumes a preceding verify --json result without rerunning the suite', () => {
    const cwd = repo();
    // A matching receipt for the current state.
    const binding = computeBinding(cwd, inputsFor(cwd));
    const rc = writeReceipt(cwd, craftReceipt(binding));
    // CI verify result provided as a file; suite is NOT rerun here.
    const ciResult = tmpFile('ci-verify.json');
    writeFileSync(ciResult, JSON.stringify({ schema_version: 1, verdict: 'VERIFIED' }));
    const { code, out } = capture(() =>
      runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, ciResult, json: true }),
    );
    const doc = JSON.parse(out);
    expect(doc.ci.verdict).toBe('VERIFIED');
    expect(doc.reconciliation.agreement).toBe('AGREE');
    expect(doc.result).toBe('VERIFIED');
    expect(validateReconcile(doc)).toEqual([]);
    expect(code).toBe(0);
  });

  it('--ci-result carrying a red verdict keeps a matching VERIFIED receipt from promoting it', () => {
    const cwd = repo();
    const binding = computeBinding(cwd, inputsFor(cwd));
    const rc = writeReceipt(cwd, craftReceipt(binding));
    const ciResult = tmpFile('ci-verify.json');
    writeFileSync(ciResult, JSON.stringify({ schema_version: 1, verdict: 'SUITE_RED' }));
    const { code, out } = capture(() =>
      runReceiptReconcile({ cwd, ...VERIFY_ARGS, receipt: rc, ciResult, json: true }),
    );
    const doc = JSON.parse(out);
    expect(doc.ci.verdict).toBe('SUITE_RED');
    expect(doc.result).toBe('SUITE_RED');
    expect(doc.reconciliation.agreement).toBe('DIVERGENCE');
    expect(code).toBe(1);
  });

  it('an unreadable --ci-result fails closed to CANNOT_VERIFY (never a pass)', () => {
    const cwd = repo();
    const { code, out } = capture(() =>
      runReceiptReconcile({ cwd, ...VERIFY_ARGS, ciResult: join(cwd, 'nope.json'), json: true }),
    );
    const doc = JSON.parse(out);
    expect(doc.ci.verdict).toBe('CANNOT_VERIFY');
    expect(doc.result).toBe('CANNOT_VERIFY');
    expect(code).toBe(2);
  });
});
