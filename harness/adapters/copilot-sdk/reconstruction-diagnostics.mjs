// BOUNDED, SANITIZED, DETERMINISTIC, HOST-OWNED reconstruction diagnostics (#621 Work E).
//
// When a Copilot SDK `write` cannot be reconstructed into a Change[] by TamperWard
// (src/adapters/copilot-sdk/changes.ts throws → the adapter fails closed with
// unavailable_reason='reconstruction'), the qualification must be able to say WHY without either
//   (a) mis-reporting the fail-closed-unavailable deny as content-aware enforcement (the #621 bug,
//       fixed in the classifier), or
//   (b) dumping the candidate patch / the file source into a public qualification artifact.
//
// This module inspects ONLY the STRUCTURAL SHAPE of the surfaced write — never its content — and emits
// a bounded, enum-first fingerprint. It changes NO acceptance logic: the reconstruction grammar and the
// security boundary live in src/adapters/copilot-sdk/changes.ts and are deliberately untouched here.
// The diagnosis is DESCRIPTIVE (what shape did the runtime send that the parser rejected?), so a future
// parser change (#621 Work F) can be driven by captured evidence rather than a guess about the SDK
// request shape.
//
// Everything here is bounded: byte/line counts are computed over a capped prefix so an enormous diff
// cannot make the diagnostic itself unbounded, and no raw diff/content line is ever returned — only
// counts, booleans, and enum categories.

// Scan caps: never read past these when fingerprinting, so a pathological (e.g. multi-MB) diff cannot
// make the diagnostic expensive or unbounded. They are diagnostic-scan caps only and do NOT mirror or
// influence the parser's own DIFF_MAX_BYTES / DIFF_MAX_LINES acceptance bounds in changes.ts.
const SCAN_MAX_BYTES = 1_048_576; // 1 MiB of diff text is far more than any real hunk fingerprint needs
const SCAN_MAX_LINES = 20_000;

const byteLen = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);

/** The count of `\n`-delimited lines in a string, computed over a bounded prefix. Returns the line
 *  count and whether the scan hit the cap (so a reader knows the count is a lower bound). */
function boundedLineScan(s) {
  if (typeof s !== 'string' || s.length === 0) return { lines: 0, truncated: false };
  const capped = s.length > SCAN_MAX_BYTES ? s.slice(0, SCAN_MAX_BYTES) : s;
  let lines = 1;
  for (let i = 0; i < capped.length && lines <= SCAN_MAX_LINES; i++) {
    if (capped.charCodeAt(i) === 10 /* \n */) lines++;
  }
  return { lines, truncated: capped.length < s.length || lines > SCAN_MAX_LINES };
}

/** Normalize the header endpoint after `--- `/`+++ ` (strip a leading a// b/ prefix and trailing
 *  whitespace/timestamp) to a bounded token used ONLY for shape comparison — never surfaced verbatim. */
function headerEndpoint(line) {
  const raw = line.replace(/^[-+]{3}\s+/, '').trim();
  const noTab = raw.split('\t')[0];
  if (noTab === '/dev/null') return { devNull: true, path: null };
  const path = noTab.replace(/^[ab]\//, '');
  return { devNull: false, path };
}

/**
 * Analyze the STRUCTURAL shape of a unified diff string, bounded and content-free. Returns counts and
 * booleans plus a single `category` enum describing the shape well enough to distinguish the failure
 * families #621 asks for, WITHOUT reconstructing or accepting anything. `targetRel` is the write's
 * declared repo-relative file target, used only to test header/target path AGREEMENT (a boolean).
 */
function analyzeDiffShape(diff, targetRel) {
  if (typeof diff !== 'string' || diff.trim() === '') {
    return { category: 'absent', present: false };
  }
  const { lines: lineCount, truncated } = boundedLineScan(diff);
  const capped = diff.length > SCAN_MAX_BYTES ? diff.slice(0, SCAN_MAX_BYTES) : diff;
  const rows = capped.split('\n', SCAN_MAX_LINES + 1).slice(0, SCAN_MAX_LINES);

  let oldHeaders = 0;
  let newHeaders = 0;
  let hunks = 0;
  let gitDiffLines = 0;
  let oldDevNull = false;
  let newDevNull = false;
  let unsupportedMetadata = false; // rename/copy/mode/binary — shapes the pre-hunk grammar rejects
  const oldPaths = new Set();
  const newPaths = new Set();

  for (const row of rows) {
    if (row.startsWith('--- ')) {
      oldHeaders++;
      const e = headerEndpoint(row);
      if (e.devNull) oldDevNull = true;
      else if (e.path) oldPaths.add(e.path);
    } else if (row.startsWith('+++ ')) {
      newHeaders++;
      const e = headerEndpoint(row);
      if (e.devNull) newDevNull = true;
      else if (e.path) newPaths.add(e.path);
    } else if (row.startsWith('@@')) {
      hunks++;
    } else if (row.startsWith('diff --git ')) {
      gitDiffLines++;
    } else if (/^(rename (from|to)|copy (from|to)|old mode|new mode|deleted file mode|new file mode|GIT binary patch|Binary files) /.test(row)) {
      unsupportedMetadata = true;
    }
  }

  const distinctPaths = new Set([...oldPaths, ...newPaths]);
  const targetNorm = typeof targetRel === 'string' ? targetRel.replace(/^[ab]\//, '') : undefined;
  // Header/target AGREEMENT: every non-/dev/null header path equals the declared target (a boolean —
  // the paths themselves are not surfaced).
  const allPaths = [...oldPaths, ...newPaths];
  const headerMatchesTarget =
    targetNorm != null && allPaths.length > 0 ? allPaths.every((p) => p === targetNorm) : undefined;

  const impliedOperation = oldDevNull && !newDevNull ? 'create' : newDevNull && !oldDevNull ? 'delete' : oldDevNull && newDevNull ? 'ambiguous' : 'modify';

  // A single enum that names the dominant shape the parser would have faced. Order matters: the most
  // specific / most-likely-rejecting shape wins.
  let category;
  if (unsupportedMetadata) category = 'unsupported-metadata';
  else if (gitDiffLines > 1 || distinctPaths.size > 1) category = 'multiple-file-diff';
  else if (oldHeaders === 0 && newHeaders === 0 && hunks > 0) category = 'headerless-hunk-only';
  else if (oldHeaders === 0 && newHeaders === 0 && hunks === 0) category = 'no-diff-structure';
  else if (oldHeaders !== newHeaders || oldHeaders === 0 || newHeaders === 0) category = 'missing-endpoint-pair';
  else if (headerMatchesTarget === false) category = 'path-header-mismatch';
  else if (hunks === 0) category = 'headers-without-hunks';
  else category = 'full-unified-diff'; // structurally complete → the rejection is at git apply --check/apply

  return {
    present: true,
    byteCount: byteLen(diff),
    lineCount,
    scanTruncated: truncated,
    oldFileHeaderCount: oldHeaders,
    newFileHeaderCount: newHeaders,
    hunkHeaderCount: hunks,
    gitDiffLineCount: gitDiffLines,
    distinctHeaderPathCount: distinctPaths.size,
    oldEndpointDevNull: oldDevNull,
    newEndpointDevNull: newDevNull,
    impliedOperation,
    headerMatchesTarget,
    unsupportedMetadata,
    category,
  };
}

/**
 * The bounded, sanitized reconstruction fingerprint for a Copilot SDK `write` whose content
 * reconstruction failed closed. `args` is the neutral file-edit operation's args
 * ({ path, resolvedPath, diff, newFileContents, intention }); `stage` is the adapter's tagged
 * unavailable_reason (e.g. 'reconstruction'). Nothing here contains the diff text, the file source, or
 * the exception message — only structural counts, booleans, and enum categories.
 */
export function reconstructionDiagnostic(args = {}, stage) {
  const target = typeof args.path === 'string' ? args.path : undefined;
  const diff = typeof args.diff === 'string' ? args.diff : undefined;
  const newFileContents = typeof args.newFileContents === 'string' ? args.newFileContents : undefined;
  const diffPresent = typeof diff === 'string' && diff.length > 0;
  const newContentsPresent = typeof newFileContents === 'string' && newFileContents.length > 0;
  const shape = analyzeDiffShape(diff, target);
  // The safe, enum-first failure category: what did the runtime surface that could not be reconstructed?
  let failureCategory;
  if (!diffPresent && !newContentsPresent) failureCategory = 'no-usable-content';
  else if (!diffPresent && newContentsPresent) failureCategory = 'new-file-contents-only';
  else if (diffPresent && newContentsPresent) failureCategory = 'diff-and-new-file-contents';
  else failureCategory = `diff:${shape.category}`;
  return {
    stage: typeof stage === 'string' ? stage : undefined,
    fileTargetPresent: target != null,
    fileTargetNormalized: target != null ? target.replace(/^[ab]\//, '') : undefined,
    resolvedPathPresent: typeof args.resolvedPath === 'string' && args.resolvedPath.length > 0,
    diffPresent,
    diffByteCount: byteLen(diff),
    diffLineCount: shape.present ? shape.lineCount : 0,
    newFileContentsPresent: newContentsPresent,
    newFileContentsByteCount: byteLen(newFileContents),
    bothDiffAndNewFileContents: diffPresent && newContentsPresent,
    intentionPresent: typeof args.intention === 'string' && args.intention.length > 0,
    diffShape: shape,
    failureCategory,
  };
}
