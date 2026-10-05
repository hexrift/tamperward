// #697: RETAINED_EVIDENCE is the catalogue that lets `runtime verify` grade a capability PROVEN,
// and each record is a hand transcription of a committed sanitized capture. Until now nothing
// compared the two: the binding could drift from the capture's provenance, an observation had no
// pointer to the capture row it paraphrased, and the committed bytes could change without the
// catalogue noticing. These tests open every record's capture and check the transcription
// field by field, then prove on mutated copies that each check bites.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RETAINED_EVIDENCE, type RetainedRuntimeEvidence } from '../src/adapters/evidence';
// @ts-expect-error - capture signatures are a plain .mjs harness module, no d.ts
import { matchesConfirmedPermissionGateSignature } from '../harness/adapters/copilot-sdk/capture-signatures.mjs';

const ROOT = join(__dirname, '..');

interface CaptureSignature {
  path: string;
  completion: { success: boolean; error_code: string; message_hash: string };
  observations: Array<{ scenario: string; boundary_host_seq: number; completion_host_seq: number; protected_state_mutated: boolean }>;
}
interface Capture {
  schema_version: string;
  source_artifact_sha256: string;
  provenance: { tamperward_version: string; sdk_version: string; runtime_version: string; protocol_version: number; model: string; os: string; arch: string };
  signatures: CaptureSignature[];
  inconclusive: Array<{ path: string; reason: string }>;
}

function loadCapture(record: RetainedRuntimeEvidence): { capture: Capture; committedSha256: string } {
  const path = join(ROOT, record.source);
  expect(statSync(path).isFile(), record.source).toBe(true);
  const bytes = readFileSync(path);
  return { capture: JSON.parse(bytes.toString('utf8')) as Capture, committedSha256: createHash('sha256').update(bytes).digest('hex') };
}

const sortedJson = (xs: readonly string[]) => JSON.stringify([...xs].sort());


/** Every way a catalogue record can misdescribe its capture, as human-readable findings. */
function lineageFindings(record: RetainedRuntimeEvidence, capture: Capture, committedSha256: string): string[] {
  const findings: string[] = [];
  if (!/^[0-9a-f]{64}$/.test(record.source_artifact_sha256)) findings.push('source_artifact_sha256 is not a 64-hex digest');
  if (record.source_artifact_sha256 !== capture.source_artifact_sha256) findings.push('source_artifact_sha256 differs from the value the capture records');
  if (record.committed_artifact_sha256 !== committedSha256) findings.push(`committed_artifact_sha256 ${record.committed_artifact_sha256} differs from the committed bytes ${committedSha256}`);

  const p = capture.provenance;
  const b = record.binding;
  if (b.runtime_version !== p.runtime_version) findings.push(`runtime_version ${b.runtime_version} differs from the capture's ${p.runtime_version}`);
  if (`tamperward@${b.tamperward_version}` !== p.tamperward_version) findings.push(`tamperward_version ${b.tamperward_version} differs from the capture's ${p.tamperward_version}`);
  if (b.model !== p.model) findings.push(`model ${b.model} differs from the capture's ${p.model}`);
  if (b.platform !== `${p.os}-${p.arch}`) findings.push(`platform ${b.platform} differs from the capture's ${p.os}-${p.arch}`);
  if (sortedJson(b.component_versions) !== sortedJson([p.sdk_version, `copilot-protocol@${p.protocol_version}`])) findings.push('component_versions differ from the capture\'s sdk_version + protocol_version');
  if (sortedJson(b.tested_capabilities) !== sortedJson(record.observations.map((o) => o.id))) findings.push('tested_capabilities differ from the observation ids');

  for (const o of record.observations) {
    const signature = capture.signatures.find((s) => s.path === o.capture_path);
    const inconclusive = capture.inconclusive.find((i) => i.path === o.capture_path);
    if (o.result === 'inconclusive') {
      if (!inconclusive) findings.push(`${o.id}: inconclusive, but ${o.capture_path} is not an inconclusive row of the capture`);
      continue;
    }
    if (!signature) {
      findings.push(`${o.id}: ${o.result}, but ${o.capture_path} is not a signature row of the capture`);
      continue;
    }
    if (signature.observations.length === 0) findings.push(`${o.id}: ${o.capture_path} carries no sanitized observation`);
    const mutated = signature.observations.some((x) => x.protected_state_mutated);
    const postBoundary = signature.observations.every((x) => x.completion_host_seq > x.boundary_host_seq);
    // The completion a row must show depends on the result it supports. A `proven`
    // denial is a completion that FAILED with a source-frozen permission-gate signature
    // (path + code + message hash, #616): a bare denied code, or a transport or runtime
    // failure that happened to leave the state intact, proves nothing about the boundary.
    // A `fail-open` row is proven by the mutation itself; its completion may well have
    // succeeded, so no denial is asked of it.
    if (o.result === 'proven') {
      const frozen =
        signature.completion.success === false &&
        matchesConfirmedPermissionGateSignature({ path: signature.path, code: signature.completion.error_code, messageHash: signature.completion.message_hash });
      if (!frozen) findings.push(`${o.id}: proven, but ${o.capture_path} did not complete as a frozen permission-gate signature (success ${signature.completion.success}, error_code ${signature.completion.error_code}, message_hash ${signature.completion.message_hash})`);
      if (mutated || !postBoundary) findings.push(`${o.id}: proven, but ${o.capture_path} mutated protected state or completed before the boundary`);
    }
    if (o.result === 'fail-open' && !mutated) findings.push(`${o.id}: fail-open, but ${o.capture_path} never mutated protected state`);
  }
  return findings;
}

/** A mutable deep copy of a (frozen) catalogue record for the negative cases. */
const copyOf = (record: RetainedRuntimeEvidence): RetainedRuntimeEvidence => JSON.parse(JSON.stringify(record)) as RetainedRuntimeEvidence;

describe('#697 the retained-evidence catalogue transcribes its committed captures faithfully', () => {
  it('holds at least one record, and every record passes every lineage check', () => {
    expect(RETAINED_EVIDENCE.length).toBeGreaterThan(0);
    for (const record of RETAINED_EVIDENCE) {
      const { capture, committedSha256 } = loadCapture(record);
      expect(lineageFindings(record, capture, committedSha256), record.ref).toEqual([]);
    }
  });

  it('keeps the two artifact identities distinct on purpose: the original capture and the committed bytes', () => {
    for (const record of RETAINED_EVIDENCE) {
      const { committedSha256 } = loadCapture(record);
      expect(record.committed_artifact_sha256).toBe(committedSha256);
      expect(record.source_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.source_artifact_sha256).not.toBe(committedSha256);
    }
  });

  it('every observation points at a real capture row of the right kind', () => {
    for (const record of RETAINED_EVIDENCE) {
      const { capture } = loadCapture(record);
      const signaturePaths = new Set(capture.signatures.map((s) => s.path));
      const inconclusivePaths = new Set(capture.inconclusive.map((i) => i.path));
      for (const o of record.observations) {
        const expected = o.result === 'inconclusive' ? inconclusivePaths : signaturePaths;
        expect(expected.has(o.capture_path), `${record.ref} ${o.id} → ${o.capture_path}`).toBe(true);
      }
    }
  });
});

describe('#697 the lineage checks bite (RED on a drifted transcription)', () => {
  const record = RETAINED_EVIDENCE[0];
  const { capture, committedSha256 } = loadCapture(record);
  const findingsAfter = (mutate: (r: RetainedRuntimeEvidence) => void): string[] => {
    const drifted = copyOf(record);
    mutate(drifted);
    return lineageFindings(drifted, capture, committedSha256);
  };

  it('the untouched copy passes, so the negatives below are the mutations, not the copy', () => {
    expect(findingsAfter(() => {})).toEqual([]);
  });
  it('a proven row whose completion carries the denied code but not a frozen permission-gate signature', () => {
    const drifted = JSON.parse(JSON.stringify(capture)) as Capture;
    const row = drifted.signatures.find((s) => s.path === 'returned-reject')!;
    row.completion.message_hash = '0000000000000000';
    expect(lineageFindings(record, drifted, committedSha256)).toEqual([expect.stringContaining('frozen permission-gate signature')]);
  });
  it('a proven row whose completion carries a frozen hash under the wrong path', () => {
    const drifted = JSON.parse(JSON.stringify(capture)) as Capture;
    const reject = drifted.signatures.find((s) => s.path === 'returned-reject')!;
    const failure = drifted.signatures.find((s) => s.path === 'callback-failure')!;
    reject.completion.message_hash = failure.completion.message_hash;
    expect(lineageFindings(record, drifted, committedSha256)).toEqual([expect.stringContaining('frozen permission-gate signature')]);
  });
  it('a different TamperWard build than the capture ran under', () => {
    expect(findingsAfter((r) => { r.binding.tamperward_version = '2.99.0+deadbeef'; })).toEqual([expect.stringContaining('tamperward_version')]);
  });
  it('a different runtime version, model or platform', () => {
    expect(findingsAfter((r) => { r.binding.runtime_version = 'copilot-runtime@9.9.9'; })).toEqual([expect.stringContaining('runtime_version')]);
    expect(findingsAfter((r) => { r.binding.model = 'other-model'; })).toEqual([expect.stringContaining('model')]);
    expect(findingsAfter((r) => { r.binding.platform = 'linux-x64'; })).toEqual([expect.stringContaining('platform')]);
  });
  it('a component set that drops the pinned protocol', () => {
    expect(findingsAfter((r) => { r.binding.component_versions = [r.binding.component_versions[0]]; })).toEqual([expect.stringContaining('component_versions')]);
  });
  it('a stale committed-artifact hash after the capture changed', () => {
    expect(findingsAfter((r) => { r.committed_artifact_sha256 = '0'.repeat(64); })).toEqual([expect.stringContaining('committed_artifact_sha256')]);
  });
  it('a source_artifact_sha256 the capture does not record', () => {
    expect(findingsAfter((r) => { r.source_artifact_sha256 = 'f'.repeat(64); })).toEqual([expect.stringContaining('source_artifact_sha256')]);
  });
  it('a tested surface wider than the observations', () => {
    expect(findingsAfter((r) => { r.binding.tested_capabilities = [...r.binding.tested_capabilities, 'pre-deny:mcp']; })).toEqual([expect.stringContaining('tested_capabilities')]);
  });
  it('an observation whose capture row does not exist', () => {
    expect(findingsAfter((r) => { r.observations[0].capture_path = 'no-such-path'; })).toEqual([expect.stringContaining('no-such-path')]);
  });
  it('a proven observation pointed at an inconclusive row, and an inconclusive one pointed at a signature', () => {
    expect(findingsAfter((r) => { r.observations[0].capture_path = 'callback-timeout'; })).toEqual([expect.stringContaining('is not a signature row')]);
    expect(findingsAfter((r) => { r.observations[2].capture_path = 'returned-reject'; })).toEqual([expect.stringContaining('is not an inconclusive row')]);
  });
  it('a proven observation whose capture row mutated protected state, or completed before the boundary', () => {
    const tampered: Capture = JSON.parse(JSON.stringify(capture)) as Capture;
    tampered.signatures[0].observations[0].protected_state_mutated = true;
    expect(lineageFindings(record, tampered, committedSha256)).toEqual([expect.stringContaining('mutated protected state')]);
    const early: Capture = JSON.parse(JSON.stringify(capture)) as Capture;
    early.signatures[0].observations[0].completion_host_seq = early.signatures[0].observations[0].boundary_host_seq;
    expect(lineageFindings(record, early, committedSha256)).toEqual([expect.stringContaining('before the boundary')]);
  });
  it('a fail-open observation needs a row that actually mutated protected state', () => {
    expect(findingsAfter((r) => { r.observations[0].result = 'fail-open'; })).toEqual([expect.stringContaining('fail-open')]);
  });
  it('a proven observation whose row failed for any reason other than a frozen permission-gate denial', () => {
    const transport: Capture = JSON.parse(JSON.stringify(capture)) as Capture;
    transport.signatures[0].completion.error_code = 'transport';
    expect(lineageFindings(record, transport, committedSha256)).toEqual([expect.stringContaining('frozen permission-gate signature')]);
    const succeeded: Capture = JSON.parse(JSON.stringify(capture)) as Capture;
    succeeded.signatures[0].completion.success = true;
    expect(lineageFindings(record, succeeded, committedSha256)).toEqual([expect.stringContaining('frozen permission-gate signature')]);
  });
  it('a fail-open observation is satisfied by a completion that SUCCEEDED and mutated protected state: no denial is asked of it', () => {
    const open: Capture = JSON.parse(JSON.stringify(capture)) as Capture;
    open.signatures[0].completion = { success: true, error_code: '', message_hash: '' };
    for (const x of open.signatures[0].observations) x.protected_state_mutated = true;
    const drifted = copyOf(record);
    drifted.observations[0].result = 'fail-open';
    expect(lineageFindings(drifted, open, committedSha256)).toEqual([]);
  });
});
