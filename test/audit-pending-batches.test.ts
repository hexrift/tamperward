// Pre-merge validation of committed audit batches (#502 review, finding 3).
//
// `audit/pending/<batch-id>.jsonl` files are an input to a privileged, write-
// capable post-merge workflow. Without a pre-merge gate a PR could add malformed
// or non-audit-v1 lines, pass normal CI, merge, and only then fail inside the
// privileged job. This test validates every committed batch with the SAME strict
// parser the workflow uses (`parseAuditJsonl`), so a bad batch fails PR CI first.
//
// It also enforces the immutable-batch convention's shape: batches live directly
// under audit/pending/ as *.jsonl, and privacy-unsafe TAMPERWARD_DENYLOG content
// must never be committed here.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAuditJsonl } from '../src/cli/audit';

const pendingDir = resolve(__dirname, '..', 'audit', 'pending');

const batchFiles = existsSync(pendingDir)
  ? readdirSync(pendingDir).filter((f) => f.endsWith('.jsonl')).sort()
  : [];

describe('committed audit batches (audit/pending)', () => {
  it('has an audit/pending directory for the reviewed-batch convention', () => {
    expect(existsSync(pendingDir)).toBe(true);
  });

  // A parameterized case per batch so a failure names the offending file. When
  // there are no batches yet (only .gitkeep), this block is simply empty — the
  // empty repository is a clean, valid state.
  for (const file of batchFiles) {
    it(`validates ${file} against the strict audit-v1 parser`, () => {
      const raw = readFileSync(join(pendingDir, file), 'utf8');
      // An empty or whitespace-only batch is a clean no-op case, not an error.
      if (!/[^\s]/.test(raw)) return;
      expect(() => parseAuditJsonl(raw)).not.toThrow();
    });

    it(`${file} carries no TAMPERWARD_DENYLOG marker`, () => {
      const raw = readFileSync(join(pendingDir, file), 'utf8');
      // The compact deny-log trace is not privacy-safe; audit-v1 events never
      // contain these keys, so their presence means the wrong file was committed.
      expect(raw).not.toMatch(/"tool_input"|"tool_name"|"transcript_path"|TAMPERWARD_DENYLOG/);
    });
  }
});
