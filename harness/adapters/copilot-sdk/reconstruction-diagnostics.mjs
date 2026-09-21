// BOUNDED, SANITIZED, DETERMINISTIC, HOST-OWNED reconstruction diagnostics (#621 Work E).
//
// When a Copilot SDK `write` cannot be reconstructed into a Change[] by TamperWard
// (src/adapters/copilot-sdk/changes.ts throws → the adapter fails closed with
// unavailable_reason='reconstruction'), the qualification must be able to say WHY without either
//   (a) mis-reporting the fail-closed-unavailable deny as content-aware enforcement (the #621 bug,
//       fixed in the classifier), or
//   (b) dumping the candidate patch / the file source / the raw request path into a public
//       qualification artifact.
//
// This module inspects ONLY the STRUCTURAL SHAPE of the surfaced write — never its content — and emits
// a bounded, enum-first fingerprint. It changes NO acceptance logic: the reconstruction grammar and the
// security boundary live in src/adapters/copilot-sdk/changes.ts and are deliberately untouched here.
// The diagnosis is DESCRIPTIVE (what shape did the runtime send that the parser rejected?), so a future
// parser change (#621 Work F) can be driven by captured evidence rather than a guess about the SDK
// request shape.
//
// BOUNDED BY CONSTRUCTION: EVERY read of a candidate-controlled string — usability, byte/line counts,
// header scan, and the target-identity hash — runs over at most a capped prefix. Counts are lower bounds
// flagged `*Truncated` when the cap is hit; nothing raw (the diff text, the file source, or the request
// path) is ever returned — only counts, booleans, enum categories, and a hash of a bounded target token.
//
// It models the PARSER'S grammar (canonicalPatch / sdkFileEditChanges), not a second acceptance policy:
//   - file identity is read ONLY from the header block BEFORE the first `@@ ` hunk (a hunk-body line may
//     itself begin `---`/`+++`, which the parser leaves to git);
//   - the pre-hunk grammar is TOTAL: the parser throws on ANY unrecognized non-blank pre-hunk line, so
//     one is reported as `unrecognized-header` rather than laundered into `full-unified-diff`;
//   - `new file mode` / `deleted file mode` are SUPPORTED metadata when they agree with the create/delete
//     endpoints, but a DUPLICATE of either is rejected (`duplicate-metadata`); rename/copy/mode-change/
//     binary/similarity are NOT supported (`unsupported-metadata`);
//   - a duplicate `---`/`+++` endpoint or more than one `diff --git` is a rejected shape, not a valid
//     unified diff;
//   - `newFileContents` is PRESENT when it is a string (including `""`, per the pinned v1.0.14 schema and
//     `sdkFileEditChanges`); a `diff` is USABLE only when it has a non-whitespace char.
//   - header/target agreement is tested against the NORMALIZED repo-relative target (as the parser's
//     `requestRel = relForDisplay(abs, cwd)`), not the raw request path, so an absolute in-repo
//     `fileName` is not falsely reported as a path mismatch.

import { createHash } from 'node:crypto';

// Scan caps: never read past these when fingerprinting, so a pathological (e.g. multi-MB) diff cannot
// make the diagnostic expensive or unbounded. They are diagnostic-scan caps only and do NOT mirror or
// influence the parser's own DIFF_MAX_BYTES / DIFF_MAX_LINES acceptance bounds in changes.ts.
const SCAN_MAX_CHARS = 262_144; // 256 Ki chars of diff text is far more than any real hunk fingerprint needs
const SCAN_MAX_LINES = 20_000;

// The ACTIVE parser reconstruction budgets (src/adapters/copilot-sdk/changes.ts), read from the same
// operator env with the same defaults, so the diagnostic can name a parser byte/line-budget rejection —
// which happens BEFORE canonicalPatch grammar / git apply — instead of mislabeling it a structurally
// complete `full-unified-diff` (#621 re-review 6 point 2).
const reconBudget = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const reconMaxBytes = () => reconBudget('TAMPERWARD_RECONSTRUCT_MAX_BYTES', 384 * 1024);
const reconMaxLines = () => reconBudget('TAMPERWARD_RECONSTRUCT_MAX_LINES', 4000);

const sha16 = (s) => createHash('sha256').update(typeof s === 'string' ? s : String(s)).digest('hex').slice(0, 16);

/** The capped prefix of a string (at most SCAN_MAX_CHARS chars) plus whether it was truncated. Every
 *  candidate-string read in this module goes through this, so nothing scans the whole input. */
function cappedPrefix(s) {
  if (typeof s !== 'string') return { text: '', truncated: false };
  const truncated = s.length > SCAN_MAX_CHARS;
  return { text: truncated ? s.slice(0, SCAN_MAX_CHARS) : s, truncated };
}

/** A bounded UTF-8 byte count over the capped prefix (a LOWER BOUND flagged `truncated` when capped). */
function boundedBytes(s) {
  if (typeof s !== 'string' || s.length === 0) return { bytes: 0, truncated: false };
  const { text, truncated } = cappedPrefix(s);
  return { bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

/** Does the capped prefix contain a non-whitespace char? — a BOUNDED usability check that never calls
 *  `trim()` over the whole candidate string. */
function hasNonWhitespaceWithinCap(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  const { text } = cappedPrefix(s);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 11) return true;
  }
  return false;
}

/** The `\n`-delimited line count over the capped prefix, with the same lower-bound/`truncated` contract. */
function boundedLines(s) {
  if (typeof s !== 'string' || s.length === 0) return { lines: 0, truncated: false };
  const { text, truncated: cappedByChars } = cappedPrefix(s);
  let lines = 1;
  let cappedByLines = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines++;
      if (lines >= SCAN_MAX_LINES) {
        cappedByLines = true;
        break;
      }
    }
  }
  return { lines, truncated: cappedByChars || cappedByLines };
}

/** Strip a leading `a/` or `b/` prefix (mirrors the parser's `stripPrefix`); leave `/dev/null` alone. */
function stripPrefix(p) {
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

/** The header endpoint token after `--- `/`+++ ` (drop a trailing tab/timestamp), for shape comparison
 *  only — never surfaced verbatim. */
function endpointToken(line) {
  return line.slice(4).split('\t')[0].trim();
}

/**
 * Analyze the STRUCTURAL shape of a unified diff, bounded and content-free, modelling the parser's
 * grammar. Returns counts, booleans, and a single `category` enum. `targetRel` is the write's NORMALIZED
 * repo-relative target (as the parser's `requestRel`), used ONLY to test header/target path AGREEMENT (a
 * boolean) — it is not surfaced.
 */
function analyzeDiffShape(diff, targetRel, targetExists) {
  if (typeof diff !== 'string' || diff.length === 0) {
    return { category: 'absent', present: false };
  }
  const prefixTruncated = diff.length > SCAN_MAX_CHARS;
  if (!hasNonWhitespaceWithinCap(diff)) {
    // No non-whitespace in the scanned prefix. If the string continues past the cap, we CANNOT conclude
    // the whole diff is empty (the parser trims the FULL string) — report unknown-truncated, never a
    // definite `absent`/no-usable-content (#621 re-review point 1).
    return prefixTruncated
      ? { category: 'unknown-truncated', present: true, usable: 'unknown', scanTruncated: true }
      : { category: 'absent', present: false };
  }
  const byteScan = boundedBytes(diff);
  const lineScan = boundedLines(diff);
  const { text: capped } = cappedPrefix(diff);
  const rows = capped.replace(/\r\n/g, '\n').split('\n', SCAN_MAX_LINES + 1).slice(0, SCAN_MAX_LINES);

  // Parser fact: file identity is read ONLY from the header block BEFORE the first `@@ ` hunk. Scanning
  // hunk bodies (which may legitimately contain `---`/`+++` content lines) would manufacture phantom
  // endpoints / mismatches, exactly the disagreement #621 must avoid.
  const firstHunk = rows.findIndex((l) => l.startsWith('@@ '));
  const hasHunk = firstHunk >= 0;
  const header = hasHunk ? rows.slice(0, firstHunk) : rows;
  const hunkHeaderCount = rows.reduce((n, l) => (l.startsWith('@@ ') ? n + 1 : n), 0);

  let oldHeaders = 0;
  let newHeaders = 0;
  let gitDiffLines = 0;
  let oldDevNull = false;
  let newDevNull = false;
  let createModeCount = 0; // `new file mode` — SUPPORTED once, with a create endpoint pair
  let deleteModeCount = 0; // `deleted file mode` — SUPPORTED once, with a delete endpoint pair
  let unsupportedMetadata = false; // rename/copy/mode-change/binary/similarity — the parser rejects these
  let unrecognizedHeader = false; // any other non-blank pre-hunk line — the parser's TOTAL grammar throws
  let sawIndex = false;
  const paths = new Set();

  for (const row of header) {
    if (row.trim() === '') continue;
    if (row.startsWith('--- ')) {
      oldHeaders++;
      const t = endpointToken(row);
      if (t === '/dev/null') oldDevNull = true;
      else paths.add(stripPrefix(t));
    } else if (row.startsWith('+++ ')) {
      newHeaders++;
      const t = endpointToken(row);
      if (t === '/dev/null') newDevNull = true;
      else paths.add(stripPrefix(t));
    } else if (row.startsWith('diff --git ')) {
      gitDiffLines++;
      for (const p of row.slice('diff --git '.length).trim().split(/\s+/)) paths.add(stripPrefix(p));
    } else if (/^new file mode\b/.test(row)) {
      createModeCount++;
    } else if (/^deleted file mode\b/.test(row)) {
      deleteModeCount++;
    } else if (/^index /.test(row)) {
      sawIndex = true; // recognized operation-bearing metadata (canonicalPatch: sawSemanticHeader)
    } else if (/^(rename (from|to)|copy (from|to)|old mode|new mode|mode |GIT binary patch|Binary files|similarity index|dissimilarity index)/.test(row)) {
      unsupportedMetadata = true;
    } else {
      // The parser's pre-hunk grammar is TOTAL: any other non-blank line fails closed. Model that here
      // rather than laundering it into a "structurally complete" shape.
      unrecognizedHeader = true;
    }
  }

  const scanTruncated = byteScan.truncated || lineScan.truncated;
  // Parser byte/line-budget rejection (checked BEFORE canonicalPatch grammar / git). `diff.length`
  // (chars) is a lower bound on `Buffer.byteLength`, so `> maxBytes` is a definite over-budget even
  // without a full byte scan; when the scan was truncated and the length is under the cap, the byte
  // status is unknown. Line count is likewise a lower bound (capped at SCAN_MAX_LINES). This path only
  // runs when the diff has non-whitespace (so the parser's `rawDiff.trim()` reaches the byte check).
  const maxBytes = reconMaxBytes();
  const maxLines = reconMaxLines();
  const overByteBudget = diff.length > maxBytes ? true : !byteScan.truncated ? byteScan.bytes > maxBytes : undefined;
  const overLineBudget = lineScan.lines > maxLines ? true : !lineScan.truncated ? false : undefined;
  const budgetUnknown = overByteBudget === undefined || overLineBudget === undefined;
  const duplicateEndpoint = oldHeaders > 1 || newHeaders > 1;
  const duplicateModeMetadata = createModeCount > 1 || deleteModeCount > 1;
  const bothEndpoints = oldHeaders >= 1 && newHeaders >= 1;
  const noEndpoints = oldHeaders === 0 && newHeaders === 0;
  // Operation-bearing metadata (canonicalPatch's `sawSemanticHeader`): its presence promises a full
  // endpoint pair, so metadata WITHOUT `--- `/`+++ ` is a parser reject before git apply.
  const sawSemanticHeader = gitDiffLines > 0 || createModeCount > 0 || deleteModeCount > 0 || sawIndex;
  const metadataWithoutEndpoints = sawSemanticHeader && noEndpoints;
  const targetNorm = typeof targetRel === 'string' ? stripPrefix(targetRel) : undefined;
  const headerMatchesTarget = targetNorm != null && paths.size > 0 ? [...paths].every((p) => p === targetNorm) : undefined;
  const impliedOperation = oldDevNull && !newDevNull ? 'create' : newDevNull && !oldDevNull ? 'delete' : oldDevNull && newDevNull ? 'ambiguous' : 'modify';
  // Mirror canonicalPatch's operation-consistency check: `new file mode` is valid ONLY with a create
  // endpoint pair, `deleted file mode` ONLY with a delete pair — a create/delete-mode with modify (or
  // opposite) endpoints is a reconstruction FAILURE before git apply, not a "structurally complete"
  // patch (#621 re-review point 2).
  const metadataOperationMismatch =
    bothEndpoints &&
    ((createModeCount > 0 && impliedOperation !== 'create') || (deleteModeCount > 0 && impliedOperation !== 'delete'));
  // Mirror canonicalPatch's operation-vs-disk-state gate: a create against an EXISTING target, or a
  // modify/delete against an ABSENT target, is rejected before git apply. Only decidable when a
  // host-derived `targetExists` fact is supplied AND the endpoints fix the operation (a bare hunk's op is
  // inferred from disk state, so it never mismatches) (#621 re-review 4 point 2).
  const operationStateMismatch =
    bothEndpoints &&
    typeof targetExists === 'boolean' &&
    ((impliedOperation === 'create' && targetExists === true) || ((impliedOperation === 'delete' || impliedOperation === 'modify') && targetExists === false));

  // One enum naming the dominant shape the parser faced. Order = most-specific-rejection first; the
  // parser fails closed on the first grammar violation, so metadata / unrecognized / duplicate shapes
  // outrank a would-be "structurally complete" reading. A scan truncated BEFORE the first hunk could not
  // observe the decisive structure, so it is `unknown-truncated`, never a definite parser diagnosis
  // (#621 re-review point 1). Once the first hunk is seen, the header block (which precedes it) was
  // fully scanned, so header-based categories are reliable even if the hunk body is truncated.
  let category;
  if (overByteBudget === true) category = 'over-byte-budget'; // parser rejects on size before any parsing
  else if (overLineBudget === true) category = 'over-line-budget'; // canonicalPatch rejects on line count before grammar
  else if (scanTruncated && !hasHunk) category = 'unknown-truncated';
  else if (unsupportedMetadata) category = 'unsupported-metadata';
  else if (unrecognizedHeader) category = 'unrecognized-header';
  else if (duplicateModeMetadata) category = 'duplicate-metadata';
  else if (gitDiffLines > 1 || paths.size > 1) category = 'multiple-file-diff';
  else if (duplicateEndpoint) category = 'duplicate-endpoint';
  else if (!hasHunk) category = noEndpoints && !sawSemanticHeader ? 'no-diff-structure' : 'no-hunk';
  else if (metadataWithoutEndpoints) category = 'metadata-without-endpoints';
  else if (noEndpoints) category = 'headerless-hunk-only';
  else if (oldHeaders !== newHeaders) category = 'missing-endpoint-pair';
  else if (bothEndpoints && oldDevNull && newDevNull) category = 'dev-null-both-sides'; // parser: "/dev/null on both sides"
  else if (metadataOperationMismatch) category = 'metadata-operation-mismatch';
  else if (operationStateMismatch) category = 'operation-state-mismatch';
  else if (headerMatchesTarget === false) category = 'path-header-mismatch';
  // Structurally complete → the rejection would be at git apply. But only CLAIM that when the parser
  // budgets are confirmed within limits; if truncation left the byte/line budget status unknown, do not
  // assert "therefore git rejected it" (#621 re-review 6 point 2).
  else category = budgetUnknown ? 'budget-unknown' : 'full-unified-diff';

  return {
    present: true,
    usable: true,
    scanTruncated,
    overByteBudget,
    overLineBudget,
    sawSemanticHeader,
    metadataWithoutEndpoints,
    metadataOperationMismatch,
    operationStateMismatch,
    targetExists: typeof targetExists === 'boolean' ? targetExists : undefined,
    byteCount: byteScan.bytes,
    byteCountTruncated: byteScan.truncated,
    lineCount: lineScan.lines,
    lineCountTruncated: lineScan.truncated,
    oldFileHeaderCount: oldHeaders,
    newFileHeaderCount: newHeaders,
    hasHunk,
    hunkHeaderCount,
    gitDiffLineCount: gitDiffLines,
    distinctHeaderPathCount: paths.size,
    duplicateEndpoint,
    createModeMetadataCount: createModeCount,
    deleteModeMetadataCount: deleteModeCount,
    duplicateModeMetadata,
    oldEndpointDevNull: oldDevNull,
    newEndpointDevNull: newDevNull,
    impliedOperation,
    headerMatchesTarget,
    createModeMetadata: createModeCount > 0,
    deleteModeMetadata: deleteModeCount > 0,
    unsupportedMetadata,
    unrecognizedHeader,
    category,
  };
}

/** A bounded, sanitized structural identity for the write target: a hash of a bounded prefix + shape
 *  flags, never the raw path (which a runtime could surface as an absolute / sensitive / arbitrarily
 *  large string). */
function targetIdentity(target) {
  if (typeof target !== 'string' || target === '') return { present: false };
  const { text, truncated } = cappedPrefix(target);
  const { bytes } = boundedBytes(target);
  return {
    present: true,
    hash: sha16(text), // hash of at most the capped prefix, never the whole runtime-supplied string
    hashTruncated: truncated,
    byteCount: bytes,
    byteCountTruncated: truncated,
    absolute: /^([/\\]|[A-Za-z]:[/\\])/.test(text.slice(0, 4)),
  };
}

/**
 * The bounded, sanitized reconstruction fingerprint for a Copilot SDK `write` whose content
 * reconstruction failed closed. `args` is the neutral file-edit operation's args
 * ({ path, targetRel?, resolvedPath, diff, newFileContents, intention }); `targetRel` is the NORMALIZED
 * repo-relative target the parser binds headers to (falls back to `path`). `stage` is the adapter's
 * tagged unavailable_reason (e.g. 'reconstruction'). Nothing here contains the diff text, the file
 * source, the request path, or the exception message — only structural counts, booleans, enum
 * categories, and a hash of a bounded target token.
 */
export function reconstructionDiagnostic(args = {}, stage) {
  const target = typeof args.path === 'string' ? args.path : undefined;
  const targetRel = typeof args.targetRel === 'string' ? args.targetRel : target;
  const diff = typeof args.diff === 'string' ? args.diff : undefined;
  // Presence semantics mirror sdkFileEditChanges: `newFileContents` is present when it is a string
  // (including `""`); a `diff` is USABLE only when it has a non-whitespace char (bounded scan).
  const newFileContentsPresent = typeof args.newFileContents === 'string';
  const diffUsable = hasNonWhitespaceWithinCap(diff);
  // Usability is UNKNOWN, not false, when the scanned prefix is all-whitespace but the diff continues
  // past the cap — the parser trims the FULL string, so a bounded scan cannot conclude it is unusable
  // (#621 re-review point 1).
  const diffUsableKnown = !(typeof diff === 'string' && diff.length > SCAN_MAX_CHARS && !diffUsable);
  const diffMayBeUsable = typeof diff === 'string' && diff.length > 0 && (diffUsable || !diffUsableKnown);
  const newFileContentsBytes = boundedBytes(typeof args.newFileContents === 'string' ? args.newFileContents : undefined);
  // `targetExists` is a bounded host-derived fact (does the write target exist on disk?), used ONLY to
  // categorize an operation-vs-state mismatch the parser rejects before git apply. Undefined when the
  // host did not supply it (then that mismatch is simply not claimed).
  const shape = analyzeDiffShape(diff, targetRel, typeof args.targetExists === 'boolean' ? args.targetExists : undefined);
  // The safe, enum-first failure category: what did the runtime surface that could not be reconstructed?
  // A diff whose usability is unknown-due-to-truncation flows to `diff:${shape.category}` (where the
  // shape is `unknown-truncated`), never to a definite `no-usable-content`.
  let failureCategory;
  if (!diffMayBeUsable && !newFileContentsPresent) failureCategory = 'no-usable-content';
  else if (!diffMayBeUsable && newFileContentsPresent) failureCategory = 'new-file-contents-only';
  else if (diffMayBeUsable && newFileContentsPresent) failureCategory = 'diff-and-new-file-contents';
  else failureCategory = `diff:${shape.category}`;
  return {
    stage: typeof stage === 'string' ? stage : undefined,
    target: targetIdentity(target),
    fileTargetPresent: target != null,
    resolvedPathPresent: typeof args.resolvedPath === 'string' && args.resolvedPath.length > 0,
    diffPresent: typeof diff === 'string' && diff.length > 0,
    diffUsable,
    diffUsableKnown,
    diffByteCount: shape.present ? shape.byteCount : 0,
    diffByteCountTruncated: shape.present ? shape.byteCountTruncated : false,
    diffLineCount: shape.present ? shape.lineCount : 0,
    diffLineCountTruncated: shape.present ? shape.lineCountTruncated : false,
    newFileContentsPresent,
    newFileContentsByteCount: newFileContentsBytes.bytes,
    newFileContentsByteCountTruncated: newFileContentsBytes.truncated,
    bothDiffAndNewFileContents: diffUsable && newFileContentsPresent,
    intentionPresent: typeof args.intention === 'string' && args.intention.length > 0,
    diffShape: shape,
    failureCategory,
  };
}
