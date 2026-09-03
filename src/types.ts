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
  /**
   * git reported the blob as binary (a `-diff`/`binary` attribute or a NUL byte).
   * Reporting only: every diff Tamperward runs passes `--text`, so hunks are still
   * produced and the git builder still loads before/after. A producer that skipped
   * either on this flag would hand the change author a switch that blinds the gate.
   */
  binary: boolean;
  hunks: Hunk[];
  /**
   * Git file modes ("100644", "100755", "120000") from the diff header, present
   * only when the header carried them: `old mode` / `new mode` on a mode change,
   * `new file mode`, `deleted file mode`. A mode-only change has NO hunks, so
   * without these a `chmod -x` on a hook was invisible to every git view — the
   * diff parsed as a modify with nothing in it. Absent from producers that have
   * no mode information (synthesised tool-call edits).
   */
  oldMode?: string;
  newMode?: string;
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
  /**
   * Path globs this ONE rule ignores, leaving every other rule's coverage intact —
   * the per-rule scoping the zod FP adjudication asked for (`ts-any-cast` out of
   * test/type-test files), which the global `ignore` cannot express without blinding
   * the test-protection rules on exactly the files they exist for. Findings on the
   * policy file itself are never excludable, and ADDING exclude globs is a
   * policy-weakening event hook-tampering flags, same as added `ignore` globs.
   */
  exclude?: string[];
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
  /**
   * Pristine-suite verification (`tamperward verify`): the suite command re-run
   * against the current source with protected files restored from a trusted rev.
   * Optional — verify runs only when configured here or invoked with flags. This
   * block is itself a guarded surface: policy-diff flags any change to `command`
   * and any lowering of `budget` as policy weakening, because a verify command an
   * agent can point at `true` is no verification at all.
   */
  verify?: {
    command: string;
    budget: number;
    /**
     * Globs naming the files the verifier command itself executes — the runner
     * script, the make target's helpers, anything `npm test` delegates to. They
     * are restored from the trusted base in the pristine run alongside the
     * tests, because a restored suite executed by an agent-rewritten runner is
     * not a restored suite. Command tokens that name a base file are picked up
     * automatically; this list is for delegation, which is not statically
     * decidable. Narrowing it is policy weakening.
     */
    inputs?: string[];
  };
}

/** Which git view manufactured the Change[] — i.e. the diff's granularity. Most rules
 *  ignore this (one ruleset, identical everywhere); a rule whose SIGNAL is only valid
 *  at a given granularity (snapshot-only-rewrite: "no accompanying change" means
 *  nothing at single-tool-call scope) may consult it. Optional and additive, so
 *  third-party detectors written against the two-argument shape keep working. */
export type View = 'tool-call' | 'turn' | 'staged' | 'worktree' | 'range';

/** What the enforcement point knows about the repository beyond the diff. Optional
 *  and additive, like `View`: a detector that needs it null-checks, a detector written
 *  against the two- or three-argument shape never sees it. `cwd` is the directory the
 *  Change[] was manufactured in (paths in commands and findings are relative to it);
 *  `trackedFiles` is a test double for the `git ls-files` answer a detector would
 *  otherwise compute from `cwd`. */
export interface DetectorContext {
  cwd?: string;
  trackedFiles?: string[];
  /** Content of files the change did NOT touch, for rules whose answer depends on
   *  the file SET rather than one diff (pytest's single-inifile precedence). Sound
   *  to read from disk: a file absent from the range has identical content at base,
   *  at head and in the worktree. A test double for that read. */
  trackedContents?: Record<string, string>;
}

export interface Detector {
  id: string;
  surface: Array<'command' | 'file'>;
  certainty: 'mechanical' | 'heuristic';
  run(changes: Change[], policy: Policy, view?: View, ctx?: DetectorContext): Finding[];
}
