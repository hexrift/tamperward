// The one decision the whole codebase inherits.
//
// Every enforcement point (the Claude PreToolUse hook, the Stop sweep, pre-commit,
// and CI) manufactures a `Change[]`; every detector consumes it. The engine never
// knows which point it is running at. Get this shape right and the rest is local.

export type Severity = 'block' | 'warn';

export type FileOp = 'add' | 'modify' | 'delete' | 'rename';

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  /** Line text with the leading +/-/space marker already stripped. */
  content: string;
  /** 1-based line number in the BEFORE file. null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the AFTER file. null for removed lines. */
  newLine: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface CommandChange {
  kind: 'command';
  /** The raw command string as the agent / shell would run it. */
  raw: string;
  /** Best-effort tokenization. Detectors should treat `raw` as authoritative. */
  argv: string[];
}

export interface FileChange {
  kind: 'file';
  /** Current path. For a delete, the path removed. For a rename, the NEW path. */
  path: string;
  /**
   * The previous path, set ONLY on a rename (or copy). null otherwise.
   * A rename is modeled as a single Change, not add+delete, so a detector can ask
   * "was a protected file renamed OUT of its glob?" — which git would otherwise hide
   * behind rename detection. `test-deletion` depends on this.
   */
  oldPath: string | null;
  op: FileOp;
  /**
   * Full BEFORE content, loaded by the git builder for AST detectors. null for adds,
   * for binaries, and whenever the change was produced by the pure parser (which only
   * sees hunks, never full files). Detectors needing full content MUST null-check.
   */
  before: string | null;
  /** Full AFTER content. null for deletes, binaries, and un-enriched changes. */
  after: string | null;
  /** git reported the blob as binary; before/after are opaque and hunks are empty. */
  binary: boolean;
  hunks: Hunk[];
}

export type Change = CommandChange | FileChange;

export interface Finding {
  rule: string;
  severity: Severity;
  file?: string;
  /** 1-based line in the AFTER file — only as trustworthy as the hunk offsets. */
  line?: number;
  message: string;
  /** The exact offending line or command. */
  evidence: string;
  /** What to do INSTEAD. This is the agent-correction signal, not a log string. */
  remediation: string;
  signoff: { required: boolean; command: string };
}

export interface RuleConfig {
  severity: Severity;
  enabled?: boolean;
}

export interface Policy {
  /**
   * The policy-schema generation this repo has OPTED IN to. Rule graduations
   * (warn -> block in the baseline) are gated on it: a rule gated at version N blocks
   * only for policies declaring `version: >= N`, and stays `warn` below — which is what
   * lets a graduation ship in a MINOR release without turning anyone's green build red.
   * Absent (or absent policy file entirely) means 1, the launch version: nobody is
   * opted in to anything they didn't write down.
   */
  version: number;
  /** Named globs for the safety nets treated as protected assets. */
  protected: Record<string, string[]>;
  rules: Record<string, RuleConfig>;
  /**
   * Globs for file paths excluded from file-surface detection. Necessary when a repo
   * legitimately contains the very patterns the rules look for (a security tool's own
   * rule definitions, docs, fixtures). The count ignored is always reported, never
   * silent — an ignore is a visible blind spot, not a hidden one.
   */
  ignore?: string[];
  signoff: { requiredFor: Severity[]; ledger: string };
}

export interface Detector {
  id: string;
  surface: Array<'command' | 'file'>;
  certainty: 'mechanical' | 'heuristic';
  run(changes: Change[], policy: Policy): Finding[];
}
