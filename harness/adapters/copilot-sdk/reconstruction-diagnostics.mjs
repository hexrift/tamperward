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
// It is bounded BY CONSTRUCTION: every scan runs over a capped prefix of the candidate string, byte
// counts are lower bounds flagged `*Truncated` when the cap is hit, and nothing raw (the diff text, the
// file source, or the request path) is ever returned — only counts, booleans, enum categories, and a
// salted-free structural hash of the target identity.
//
// It models the PARSER'S grammar (canonicalPatch / sdkFileEditChanges), not a second acceptance policy:
//   - file identity is read ONLY from the header block BEFORE the first `@@ ` hunk (a hunk-body line may
//     itself begin `---`/`+++`, which the parser leaves to git);
//   - `new file mode` / `deleted file mode` are SUPPORTED metadata (the parser accepts them when they
//     agree with the create/delete endpoints); rename/copy/mode-change/binary/similarity are NOT;
//   - a duplicate `---`/`+++` endpoint or more than one `diff --git` is a rejected shape, not a valid
//     unified diff;
//   - `newFileContents` is PRESENT when it is a string (including `""`, per the pinned v1.0.14 schema and
//     `sdkFileEditChanges`); a `diff` is USABLE only when it is non-whitespace (`rawDiff.trim()`).

import { createHash } from 'node:crypto';

// Scan caps: never read past these when fingerprinting, so a pathological (e.g. multi-MB) diff cannot
// make the diagnostic expensive or unbounded. They are diagnostic-scan caps only and do NOT mirror or
// influence the parser's own DIFF_MAX_BYTES / DIFF_MAX_LINES acceptance bounds in changes.ts.
const SCAN_MAX_CHARS = 262_144; // 256 Ki chars of diff text is far more than any real hunk fingerprint needs
const SCAN_MAX_LINES = 20_000;

const sha16 = (s) => createHash('sha256').update(typeof s === 'string' ? s : String(s)).digest('hex').slice(0, 16);

/** A bounded byte count: the UTF-8 length of at most the first SCAN_MAX_CHARS characters. When the
 *  input is longer, `bytes` is a LOWER BOUND and `truncated` is true — the count is never computed over
 *  the whole candidate-controlled string. */
function boundedBytes(s) {
  if (typeof s !== 'string' || s.length === 0) return { bytes: 0, truncated: false };
  const truncated = s.length > SCAN_MAX_CHARS;
  const capped = truncated ? s.slice(0, SCAN_MAX_CHARS) : s;
  return { bytes: Buffer.byteLength(capped, 'utf8'), truncated };
}

/** The `\n`-delimited line count over a capped prefix, with the same lower-bound/`truncated` contract. */
function boundedLines(s) {
  if (typeof s !== 'string' || s.length === 0) return { lines: 0, truncated: false };
  const cappedByChars = s.length > SCAN_MAX_CHARS;
  const capped = cappedByChars ? s.slice(0, SCAN_MAX_CHARS) : s;
  let lines = 1;
  let cappedByLines = false;
  for (let i = 0; i < capped.length; i++) {
    if (capped.charCodeAt(i) === 10 /* \n */) {
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
 * grammar. Returns counts, booleans, and a single `category` enum. `targetRel` is the write's declared
 * repo-relative file target, used ONLY to test header/target path AGREEMENT (a boolean) — it is not
 * surfaced.
 */
function analyzeDiffShape(diff, targetRel) {
  if (typeof diff !== 'string' || diff.trim() === '') {
    return { category: 'absent', present: false };
  }
  const byteScan = boundedBytes(diff);
  const lineScan = boundedLines(diff);
  const capped = diff.length > SCAN_MAX_CHARS ? diff.slice(0, SCAN_MAX_CHARS) : diff;
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
  let createModeMeta = false; // `new file mode` — SUPPORTED with a create endpoint pair
  let deleteModeMeta = false; // `deleted file mode` — SUPPORTED with a delete endpoint pair
  let unsupportedMetadata = false; // rename/copy/mode-change/binary/similarity — the parser rejects these
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
      createModeMeta = true;
    } else if (/^deleted file mode\b/.test(row)) {
      deleteModeMeta = true;
    } else if (/^(rename (from|to)|copy (from|to)|old mode|new mode|mode |GIT binary patch|Binary files|similarity index|dissimilarity index)/.test(row)) {
      unsupportedMetadata = true;
    }
    // `index ...` and unrecognized lines are not shape-defining here (the parser fails closed on the
    // latter, but naming that reason is not this fingerprint's job — it reports the dominant shape).
  }

  const duplicateEndpoint = oldHeaders > 1 || newHeaders > 1;
  const targetNorm = typeof targetRel === 'string' ? stripPrefix(targetRel) : undefined;
  const headerMatchesTarget = targetNorm != null && paths.size > 0 ? [...paths].every((p) => p === targetNorm) : undefined;
  const impliedOperation = oldDevNull && !newDevNull ? 'create' : newDevNull && !oldDevNull ? 'delete' : oldDevNull && newDevNull ? 'ambiguous' : 'modify';

  // One enum naming the dominant shape the parser faced. Order = most-specific-rejection first.
  let category;
  if (unsupportedMetadata) category = 'unsupported-metadata';
  else if (gitDiffLines > 1 || paths.size > 1) category = 'multiple-file-diff';
  else if (duplicateEndpoint) category = 'duplicate-endpoint';
  else if (oldHeaders === 0 && newHeaders === 0 && hasHunk) category = 'headerless-hunk-only';
  else if (oldHeaders === 0 && newHeaders === 0 && !hasHunk) category = 'no-diff-structure';
  else if (!hasHunk) category = 'no-hunk';
  else if (oldHeaders !== newHeaders) category = 'missing-endpoint-pair';
  else if (headerMatchesTarget === false) category = 'path-header-mismatch';
  else category = 'full-unified-diff'; // structurally complete → the rejection is at git apply --check/apply

  return {
    present: true,
    usable: diff.trim().length > 0,
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
    oldEndpointDevNull: oldDevNull,
    newEndpointDevNull: newDevNull,
    impliedOperation,
    headerMatchesTarget,
    createModeMetadata: createModeMeta,
    deleteModeMetadata: deleteModeMeta,
    unsupportedMetadata,
    category,
  };
}

/** A bounded, sanitized structural identity for the write target: a hash + shape flags, never the raw
 *  path (which a runtime could surface as an absolute / sensitive / arbitrarily large string). */
function targetIdentity(target) {
  if (typeof target !== 'string' || target === '') return { present: false };
  const { bytes, truncated } = boundedBytes(target);
  return {
    present: true,
    hash: sha16(target),
    byteCount: bytes,
    byteCountTruncated: truncated,
    absolute: /^([/\\]|[A-Za-z]:[/\\])/.test(target.slice(0, 4)),
  };
}

/**
 * The bounded, sanitized reconstruction fingerprint for a Copilot SDK `write` whose content
 * reconstruction failed closed. `args` is the neutral file-edit operation's args
 * ({ path, resolvedPath, diff, newFileContents, intention }); `stage` is the adapter's tagged
 * unavailable_reason (e.g. 'reconstruction'). Nothing here contains the diff text, the file source, the
 * request path, or the exception message — only structural counts, booleans, enum categories, and a
 * hash of the target identity.
 */
export function reconstructionDiagnostic(args = {}, stage) {
  const target = typeof args.path === 'string' ? args.path : undefined;
  const diff = typeof args.diff === 'string' ? args.diff : undefined;
  // Presence semantics mirror sdkFileEditChanges: `newFileContents` is present when it is a string
  // (including `""`); a `diff` is USABLE only when non-whitespace (`rawDiff.trim()`).
  const newFileContentsPresent = typeof args.newFileContents === 'string';
  const diffUsable = typeof diff === 'string' && diff.trim().length > 0;
  const newFileContentsBytes = boundedBytes(typeof args.newFileContents === 'string' ? args.newFileContents : undefined);
  const shape = analyzeDiffShape(diff, target);
  // The safe, enum-first failure category: what did the runtime surface that could not be reconstructed?
  let failureCategory;
  if (!diffUsable && !newFileContentsPresent) failureCategory = 'no-usable-content';
  else if (!diffUsable && newFileContentsPresent) failureCategory = 'new-file-contents-only';
  else if (diffUsable && newFileContentsPresent) failureCategory = 'diff-and-new-file-contents';
  else failureCategory = `diff:${shape.category}`;
  return {
    stage: typeof stage === 'string' ? stage : undefined,
    target: targetIdentity(target),
    fileTargetPresent: target != null,
    resolvedPathPresent: typeof args.resolvedPath === 'string' && args.resolvedPath.length > 0,
    diffPresent: typeof diff === 'string' && diff.length > 0,
    diffUsable,
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
