// GitHub Actions rendering of the verdict.
//
// The problem this solves: in CI the verdict used to exist only as text inside a job log.
// A reviewer looking at a red "gate" check had to open the run, find the job, expand the
// step, and scroll — four navigations away from the diff they were already reading. The
// finding names a file and a line, so it should appear ON that line.
//
// Two native surfaces do that, and neither needs any repo configuration:
//
//   1. WORKFLOW ANNOTATIONS (`::error file=…,line=…::`). GitHub renders these inline in
//      Files Changed, next to the offending line, and collects them at the top of the run
//      page. Unlike SARIF this needs no `security-events: write` and works on private
//      repos without Advanced Security, so it is the surface with the fewest conditions
//      attached.
//   2. THE JOB SUMMARY ($GITHUB_STEP_SUMMARY). Markdown rendered on the run page itself,
//      above the logs. A real table with a header row — screen readers announce column
//      names per cell, which a whitespace-aligned log block cannot do.
//
// Both are additive: the full text report still goes to the log, so nothing that used to
// be greppable stopped being greppable.

import { appendFileSync } from 'node:fs';
import { Finding } from '../../types';
import { countsPhrase, orderFindings, scopePhrase, SIGNOFF_NOTE } from './text';

/** Workflow-command message escaping, per the Actions toolkit. */
function escData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Property values escape two more characters, since `,` separates properties and `:`
 *  ends the property list. */
function escProp(s: string): string {
  return escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * One annotation per finding. A `block` is an `error` and a `warn` is a `warning`, so the
 * severity survives into GitHub's own vocabulary rather than being spelled out in prose
 * the UI cannot act on.
 */
export function annotations(findings: Finding[]): string[] {
  return orderFindings(findings).map((f) => {
    const kind = f.severity === 'block' ? 'error' : 'warning';
    const props: string[] = [];
    if (f.file) {
      props.push(`file=${escProp(f.file)}`);
      if (f.line) props.push(`line=${f.line}`);
    }
    props.push(`title=${escProp(`tamperward: ${f.rule}`)}`);
    const body =
      `${f.message} Instead: ${f.remediation}` +
      (f.signoff.required ? ` Sign-off: ${f.signoff.command}` : '');
    return `::${kind} ${props.join(',')}::${escData(body)}`;
  });
}

/** Pipes would split the cell; newlines would end the row. */
function cell(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Deep-link a finding to the exact line in the reviewed tree, when Actions tells us
 *  enough to build one. Falls back to a plain code span off CI. */
function locationCell(f: Finding, env: NodeJS.ProcessEnv): string {
  if (!f.file) return '`(command)`';
  const label = `${f.file}${f.line ? `:${f.line}` : ''}`;
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!server || !repo || !sha) return `\`${cell(label)}\``;
  const frag = f.line ? `#L${f.line}` : '';
  return `[\`${cell(label)}\`](${server}/${repo}/blob/${sha}/${f.file}${frag})`;
}

export interface SummaryInput {
  findings: Finding[];
  scanned: number;
  ignoredFiles: number;
}

/** The job-summary markdown. Returned rather than written so it is directly assertable. */
export function renderSummary(input: SummaryInput, env: NodeJS.ProcessEnv = process.env): string {
  const findings = orderFindings(input.findings);
  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  const scope = scopePhrase(input.scanned, input.ignoredFiles);

  if (findings.length === 0) {
    return `## Tamperward: clean\n\nNo integrity findings (${scope}).\n`;
  }

  const out: string[] = [
    `## Tamperward: ${countsPhrase(blocks.length, warns.length)}`,
    '',
    `${scope}. Every finding below is also annotated on the diff in **Files changed**.`,
    '',
    '| Severity | Rule | Location | Finding | Instead |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const f of findings) {
    // "BLOCK" / "warn" as text, not a coloured dot: the word is what a screen reader
    // reads out and what survives a copy-paste into an issue.
    const sev = f.severity === 'block' ? '**BLOCK**' : 'warn';
    out.push(
      `| ${sev} | \`${cell(f.rule)}\` | ${locationCell(f, env)} | ${cell(f.message)} | ${cell(f.remediation)} |`,
    );
  }

  const needSignoff = findings.filter((f) => f.signoff.required);
  if (needSignoff.length) {
    out.push('', '### Clearing a blocking finding', '', SIGNOFF_NOTE, '');
    const seen = new Set<string>();
    for (const f of needSignoff) {
      if (seen.has(f.signoff.command)) continue;
      seen.add(f.signoff.command);
      out.push(`- \`${cell(f.signoff.command)}\``);
    }
  }

  return out.join('\n') + '\n';
}

/** Append to the job summary. Append rather than overwrite — other steps in the same job
 *  own the same file, and clobbering their section is not ours to do. Best effort: a
 *  summary that fails to write must never change the gate's verdict. */
export function writeSummary(md: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  try {
    appendFileSync(path, md + '\n');
    return true;
  } catch {
    return false;
  }
}

export function isGitHubActions(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true';
}
