import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [label, repoDir, baseCliRaw, candidateCliRaw] = process.argv.slice(2);
if (!label || !repoDir || !baseCliRaw || !candidateCliRaw) {
  console.error('usage: node test-skip-ast-delta.mjs <label> <repoDir> <baseCli> <candidateCli>');
  process.exit(2);
}

const baseCli = resolve(baseCliRaw);
const candidateCli = resolve(candidateCliRaw);
const git = (...args) => execFileSync('git', args, {
  cwd: repoDir,
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});

function verdict(cli, base, head) {
  const r = spawnSync(process.execPath, [cli, 'check', '--diff', `${base}...${head}`, '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const text = String(r.stdout || '').trim();
  if (!text) return { findings: [] };
  try {
    return JSON.parse(text.split('\n').at(-1));
  } catch {
    return { findings: [] };
  }
}

const key = (f) => [f.rule, f.file || '', String(f.line || ''), f.evidence || ''].join('\u0000');
const commits = git('rev-list', '--reverse', 'HEAD').trim().split('\n').filter(Boolean);
let pairs = 0;
const newFindings = [];

for (let i = 1; i < commits.length; i++) {
  const base = commits[i - 1];
  const head = commits[i];
  const before = verdict(baseCli, base, head);
  const after = verdict(candidateCli, base, head);
  pairs++;

  const old = new Set((before.findings || []).filter((f) => f.rule === 'test-skip').map(key));
  for (const f of (after.findings || []).filter((x) => x.rule === 'test-skip')) {
    if (old.has(key(f))) continue;
    newFindings.push({
      base: base.slice(0, 12),
      head: head.slice(0, 12),
      file: f.file || null,
      line: f.line || null,
      evidence: f.evidence || '',
      message: f.message || '',
    });
  }
}

console.log(JSON.stringify({ repo: label, pairs, new_findings: newFindings.length, findings: newFindings }));
