// Transport for a trusted signer's verdict; unsigned receipts remain evidence.
// No candidate code executes here. Private-key custody and the provenance of
// the payload belong to an independent trusted CI/signing job.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { isRecord } from './narrow';

const VERDICTS = ['VERIFIED', 'MASKED_FAILURE', 'SUITE_RED', 'BUDGET_EXCEEDED', 'CANNOT_VERIFY'] as const;
export interface VerdictBinding {
  head: string;
  base: string;
  gate_version: string;
  policy_hash: string;
  verdict: typeof VERDICTS[number];
  audience: string;
  nonce: string;
}
export interface VerdictStatement extends VerdictBinding {
  schema_version: 1;
  issued_at: string;
  expires_at: string;
}
export interface SignedVerdict {
  schema_version: 1;
  algorithm: 'Ed25519';
  key_id: string;
  statement: VerdictStatement;
  signature: string;
}
const FIELDS = ['head', 'base', 'gate_version', 'policy_hash', 'verdict', 'audience', 'nonce'] as const;
function exactKeys(v: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(v).sort().join('\0') !== [...fields].sort().join('\0')) throw new Error('unexpected or missing attestation field');
}
export function parseVerdictBinding(value: unknown): VerdictBinding {
  if (!isRecord(value)) throw new Error('verdict binding must be an object');
  exactKeys(value, FIELDS);
  const verdict = VERDICTS.find(v => v === value.verdict);
  if (typeof value.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.head)
    || typeof value.base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.base)
    || typeof value.gate_version !== 'string' || value.gate_version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.gate_version)
    || typeof value.policy_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policy_hash)
    || !verdict || typeof value.audience !== 'string' || !/^[A-Za-z0-9:._/-]{1,160}$/.test(value.audience)
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9:._/-]{1,160}$/.test(value.nonce)) throw new Error('invalid verdict binding');
  return { head: value.head, base: value.base, gate_version: value.gate_version, policy_hash: value.policy_hash, verdict, audience: value.audience, nonce: value.nonce };
}
export function parseVerdictStatement(value: unknown): VerdictStatement {
  if (!isRecord(value)) throw new Error('verdict statement must be an object');
  exactKeys(value, [...FIELDS, 'schema_version', 'issued_at', 'expires_at']);
  const { schema_version, issued_at, expires_at, ...binding } = value;
  const timestamp = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (schema_version !== 1 || !timestamp(issued_at) || !timestamp(expires_at)) throw new Error('invalid verdict statement timestamps');
  return { schema_version: 1, ...parseVerdictBinding(binding), issued_at, expires_at };
}
function validTime(statement: VerdictStatement, now: number): void {
  const issued = Date.parse(statement.issued_at), expires = Date.parse(statement.expires_at);
  if (!Number.isFinite(now) || issued > now + 60_000 || expires <= now || expires <= issued || expires - issued > 86_400_000) throw new Error('verdict statement expired or outside its validity window');
}
function keyId(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('verdict attestation requires an Ed25519 key');
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}
function signedBytes(statement: VerdictStatement, key_id: string): Buffer {
  // The strict parser reconstructs a fixed property order; JSON whitespace and
  // input key order cannot change the signed meaning. Domain separation keeps
  // a signature from another protocol from being accepted as a verdict.
  return Buffer.from('tamperward.verdict-statement.v1\0' + JSON.stringify({ algorithm: 'Ed25519', key_id, statement }), 'utf8');
}
export function signVerdict(payload: unknown, privatePem: string | Buffer, now = Date.now()): SignedVerdict {
  const statement = parseVerdictStatement(payload);
  validTime(statement, now);
  const key = createPrivateKey(privatePem);
  const key_id = keyId(createPublicKey(key));
  return { schema_version: 1, algorithm: 'Ed25519', key_id, statement, signature: sign(null, signedBytes(statement, key_id), key).toString('base64url') };
}
export function verifyVerdict(value: unknown, publicPem: string | Buffer, expected: unknown, now = Date.now()): VerdictStatement {
  if (!isRecord(value)) throw new Error('signed verdict must be an object');
  exactKeys(value, ['schema_version', 'algorithm', 'key_id', 'statement', 'signature']);
  const binding = parseVerdictBinding(expected);
  const statement = parseVerdictStatement(value.statement);
  if (value.schema_version !== 1 || value.algorithm !== 'Ed25519' || typeof value.key_id !== 'string'
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) throw new Error('invalid signed verdict envelope');
  const key = createPublicKey(publicPem);
  if (value.key_id !== keyId(key)) throw new Error('untrusted verdict signing key');
  const signature = Buffer.from(value.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== value.signature || !verify(null, signedBytes(statement, value.key_id), key, signature)) throw new Error('invalid verdict signature');
  validTime(statement, now);
  for (const field of FIELDS) if (statement[field] !== binding[field]) throw new Error(`verdict binding mismatch: ${field}`);
  return statement;
}
