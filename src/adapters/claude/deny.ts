// The denial message IS the correction signal — not a log line. It names the class,
// redirects to the real fix, pre-empts the next shortcuts so the agent doesn't try them
// in sequence, and offers the legitimate human escape. Fed back to Claude via stderr.

import { escapeControl } from '../../policy';
import { Finding } from '../../types';

export function formatDenial(blocks: Finding[]): string {
  const lead = blocks[0];
  const lines: string[] = ['Tamperward blocked this change — it weakens a protected safety net to pass checks.', ''];

  for (const f of blocks) {
    const loc = f.file ? ` (${escapeControl(f.file)}${f.line ? `:${f.line}` : ''})` : '';
    lines.push(`  • ${f.rule}${loc}: ${f.message}`);
  }

  lines.push('');
  lines.push(`Fix the underlying failure in the code under test, not the safety net. ${lead.remediation}`);
  lines.push(
    'The other shortcuts are blocked too: skipping the hooks, editing the hook or CI workflow, ' +
      'lowering the coverage gate, and rewriting a protected file from the shell will each be denied.',
  );
  if (blocks.some((b) => b.signoff.required)) {
    lines.push(`If this change is genuinely correct, a human must sign off: ${lead.signoff.command}`);
  }

  return lines.join('\n') + '\n';
}
