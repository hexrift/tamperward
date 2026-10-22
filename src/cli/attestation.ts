import { closeSync, readSync, writeFileSync } from 'node:fs';
import { openRegular } from '../disk';
import { signVerdict, verifyVerdict } from '../verdict-attestation';

function readBounded(file: string): Buffer {
  const fd = openRegular(file, '; attestation inputs must be regular files');
  if (fd === null) throw new Error('attestation input not found');
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total === buffer.length) throw new Error('attestation input exceeds 64 KiB');
    return buffer.subarray(0, total);
  } finally { closeSync(fd); }
}
export function runAttestation(args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== 'sign' && sub !== 'verify') throw new Error('attestation requires sign | verify');
  const flags = new Map<string, string>();
  const allowed = sub === 'sign' ? ['--payload', '--key', '--out'] : ['--statement', '--key', '--expect'];
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    if (!allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) throw new Error('invalid or duplicate attestation argument');
    flags.set(name, value);
  }
  const required = (name: string): string => { const value = flags.get(name); if (!value) throw new Error(`attestation ${sub} requires ${name}`); return value; };
  if (sub === 'sign') {
    const out = required('--out');
    const signed = signVerdict(JSON.parse(readBounded(required('--payload')).toString('utf8')), readBounded(required('--key')));
    // Fresh output only: do not overwrite an existing claim or follow a link.
    writeFileSync(out, JSON.stringify(signed) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('verdict statement signed\n');
  } else {
    verifyVerdict(JSON.parse(readBounded(required('--statement')).toString('utf8')), readBounded(required('--key')), JSON.parse(readBounded(required('--expect')).toString('utf8')));
    process.stdout.write('verdict statement valid for the expected binding\n');
  }
  return 0;
}
