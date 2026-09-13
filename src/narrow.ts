// Runtime narrowing for values that arrive as `unknown`: parsed JSON, thrown
// errors, process results. Every reader here CHECKS before it CLAIMS — none of
// them is a "trust me" assertion helper (#383). A cast is a promise to the
// compiler; these are proofs to it.

export type UnknownRecord = Record<string, unknown>;

/** A plain object: not null, not an array. The shape every JSON document a
 *  trust boundary reads must have before any field is looked at. */
export function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `e.code` when the thrown value carries a string errno code (`ENOENT`,
 *  `EPERM`, `ETIMEDOUT`), otherwise undefined. */
export function errnoCode(e: unknown): string | undefined {
  const code = isRecord(e) ? e.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A string or Buffer as text; anything else is empty. */
export function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return '';
}

/** What a failed `execFileSync` throws, read field by field rather than
 *  asserted: stdout/stderr as text, the exit status when the child exited,
 *  the errno code when it did not start, and the message. */
export function execFailure(e: unknown): {
  stdout: string;
  stderr: string;
  status: number | null;
  code: string | undefined;
  message: string;
} {
  const r = isRecord(e) ? e : {};
  return {
    stdout: textOf(r.stdout),
    stderr: textOf(r.stderr),
    status: typeof r.status === 'number' ? r.status : null,
    code: errnoCode(e),
    message: errorMessage(e),
  };
}

/** A finite number, or undefined. */
export function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A string, or undefined. */
export function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A string or null (the JSON spelling of "absent"); undefined when neither. */
export function nullableString(v: unknown): string | null | undefined {
  return v === null || typeof v === 'string' ? v : undefined;
}

/** A finite number or null; undefined when neither. */
export function nullableNumber(v: unknown): number | null | undefined {
  return v === null || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
}
