// `tamperward onboard` — the interactive first-run path (#388).
//
// TamperWard's installation is deliberately explicit and fail-closed: `init`
// wires the enforcement points, the verifier command is a trust anchor the
// operator must name, `verify` fails closed rather than guessing, and `doctor`
// is the one definition of "installed correctly". That is the right shape for a
// gate and a dense first hour for a new repository. `onboard` walks an operator
// through the sequence — preflight, preview, init, verifier, first verify, an
// optional safe demonstration, GitHub authority, posture, next steps — and
// teaches the distinction between agent steering, verification and repository
// authority on the way.
//
// CONTRACT: orchestration only. Every write goes through the canonical `init`
// planner/applier; the verifier suggestion comes from init's own detection and
// reaches the policy only after an explicit acceptance (never under --yes: a
// scripted run must name the command itself); the first verification is
// `runVerify` with its exit semantics untouched and merely explained; the
// posture is `doctor`'s outcome, not a parallel judgement. The demo edits only a
// detached temporary worktree it created, so the operator's working tree is
// never touched, and the tree fingerprint before/after is printed to prove it.
// Nothing here stashes, resets or otherwise moves user work. A non-interactive
// stdin refuses instead of hanging unless `--yes` scripts the answers. Every
// step is idempotent, so an abort leaves a state `doctor` can describe and a
// re-run simply continues.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { parseDocument } from 'yaml';
import { planInit, runInit, verifierCandidates, type InitOpts } from './init';
import { localVerifierShell, runVerify, type VerifyOpts, type VerifyVerdictSummary } from './verify';
import {
  diagnose,
  inferGitHubRepo,
  lifecyclePlatformCheck,
  type DoctorCheck,
  type DoctorOpts,
  type DoctorOutcome,
} from './doctor';
import { runCheck, type CheckOpts } from './check';
import { colourEnabled } from './render/text';
import { treeFingerprint } from '../fingerprint';
import { POLICY_FILE } from '../policy';
import { loadPolicy } from '../policy-load';
import { errorMessage } from '../narrow';
import { TW_VERSION } from '../wiring';

export interface OnboardOpts {
  cwd?: string;
  /** Trusted base for the first verification. Without it verify anchors to HEAD
   *  and reads the working-tree policy — the local-developer path, which is the
   *  one that sees a `verify.command` written a minute ago and not yet committed. */
  base?: string;
  /** GitHub repository (OWNER/REPO) for the authority check. Inferred from the
   *  origin remote when omitted. */
  repo?: string;
  /** Protected branch for the authority check. */
  branch?: string;
  /** Never offer the demonstration. */
  skipDemo?: boolean;
  /** Run the demonstration without asking (the only way it runs under --yes). */
  demo?: boolean;
  /** Never call the GitHub API; print the manual controls instead. */
  noGithub?: boolean;
  /** Scripted mode: answer every confirmation with its safe default and ask
   *  nothing. The verifier command is NOT a confirmation — see verifyCommand. */
  yes?: boolean;
  /** The trusted suite command to write as verify.command. The only way a
   *  scripted run configures verification: a detected candidate is never written
   *  without a human accepting it. */
  verifyCommand?: string;
}

/** The trusted primitives onboarding orchestrates. Injectable so tests can stub
 *  the ones that reach the network or a platform this runner does not have. */
export interface OnboardRunners {
  init: (opts: InitOpts) => number;
  verify: (opts: VerifyOpts) => number;
  doctor: (opts: DoctorOpts) => DoctorOutcome;
  check: (opts: CheckOpts) => number;
}

export interface OnboardIo {
  /** One line of onboarding prose (no trailing newline). Sub-commands keep
   *  writing to process.stdout themselves, exactly as they do standalone. */
  out?: (line: string) => void;
  /** Ask one question; resolve the raw answer, or null when the input closed. */
  ask?: (question: string) => Promise<string | null>;
  /** Whether prompting is possible at all. Defaults to a TTY stdin outside CI. */
  interactive?: boolean;
  platform?: NodeJS.Platform;
  /** @internal Force terminal colour on/off for deterministic tests. */
  colour?: boolean;
  runners?: Partial<OnboardRunners>;
}

/** An asker over a readline interface. Resolves null once the input closes
 *  (Ctrl-D, Ctrl-C, a pipe ending), so a caller can stop cleanly instead of
 *  waiting on a stream that will never answer. */
export interface Asker {
  (question: string): Promise<string | null>;
  close: () => void;
}

export function readlineAsker(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Asker {
  const rl = createInterface({ input, output });
  let closed = false;
  let pending: ((answer: string | null) => void) | null = null;
  rl.on('close', () => {
    closed = true;
    const resolve = pending;
    pending = null;
    resolve?.(null);
  });
  rl.on('SIGINT', () => rl.close());
  const ask: Asker = (question: string) =>
    new Promise<string | null>((resolvePromise) => {
      if (closed) {
        resolvePromise(null);
        return;
      }
      pending = resolvePromise;
      rl.question(question, (answer) => {
        pending = null;
        resolvePromise(answer);
      });
    });
  ask.close = () => {
    if (!closed) rl.close();
  };
  return ask;
}

class Aborted extends Error {}

type Posture = 'READY' | 'READY WITH WARNINGS' | 'BROKEN' | 'INCOMPLETE';

const SECTIONS = [
  'Environment',
  'Local protection',
  'Verification',
  'GitHub protection',
  'Summary',
] as const;

const MANUAL_CONTROLS = [
  'GitHub still needs three repository controls:',
  '  required check: tamperward',
  '  Code Owner review',
  '  dismiss stale approvals when new commits are pushed',
];

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;

function paint(text: string, code: string, on: boolean): string {
  return on ? code + text + RESET : text;
}

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}


const JS_TEST_PATH = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|__tests__\/[^/]+\.[cm]?[jt]sx?)$/;
const JS_TEST_BLOCK = /^(\s*)(it|test|describe)(\s*\()/m;

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function explainVerdict(v: VerifyVerdictSummary | null, code: number): string {
  const verdict = v?.verdict ?? (code === 0 ? 'VERIFIED' : code === 1 ? 'SUITE_RED' : 'CANNOT_VERIFY');
  switch (verdict) {
    case 'VERIFIED':
      return 'Verification passed — visible and pristine suites are green.';
    case 'SUITE_RED':
      return 'Your test suite is red. Fix it, then run verification again.';
    case 'MASKED_FAILURE':
      return 'Verification blocked — the visible suite passes, but the pristine suite fails.';
    default:
      return `Could not verify${v?.reason ? ` (${v.reason})` : ''} — TamperWard failed closed${v?.detail ? `: ${v.detail}` : '.'}`;
  }
}

/** Replace a file without ever opening the destination for writing. The bytes go
 * to a fresh sibling and rename replaces the directory entry atomically. That
 * means a final-component symlink (or a hard link to operator state) is never
 * followed; a hard link is broken rather than mutated in place. */
function atomicReplaceFile(path: string, content: string, mode: number): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Merge `verify.command` (and a default budget) into the policy file, keeping
 * everything else — comments included — as written. A repository-controlled
 * symlink/special file is refused before any read or write, and the replacement
 * itself is atomic so the destination is never followed. Returns an error message
 * when the result would not load; the file is then restored byte-for-byte. */
function writeVerifyCommand(cwd: string, command: string): string | null {
  const path = join(cwd, POLICY_FILE);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && (!st.isFile() || st.isSymbolicLink())) {
    return `${POLICY_FILE} is not a regular file; refusing to follow or replace a symlink or special file`;
  }
  const mode = st ? st.mode & 0o777 : 0o644;
  const original = st ? readFileSync(path, 'utf8') : null;
  let next: string;
  try {
    const doc = parseDocument(original && original.trim() ? original : 'version: 1\n');
    if (doc.errors.length) return `${POLICY_FILE} is not valid YAML: ${doc.errors[0].message}`;
    doc.setIn(['verify', 'command'], command);
    if (!doc.hasIn(['verify', 'budget'])) doc.setIn(['verify', 'budget'], 300);
    next = doc.toString();
  } catch (e) {
    return `${POLICY_FILE} could not be updated: ${errorMessage(e)}`;
  }
  atomicReplaceFile(path, next, mode);
  try {
    const loaded = loadPolicy(cwd);
    if (loaded.verify?.command !== command) throw new Error('verify.command did not round-trip');
    return null;
  } catch (e) {
    if (original === null) rmSync(path, { force: true });
    else atomicReplaceFile(path, original, mode);
    return `the updated ${POLICY_FILE} does not load (${errorMessage(e)}); restored the previous file`;
  }
}

export async function runOnboard(opts: OnboardOpts, io: OnboardIo = {}): Promise<number> {
  const requestedCwd = resolve(opts.cwd ?? process.cwd());
  const out = io.out ?? ((line: string): void => void process.stdout.write(line + '\n'));
  const rawErr = (line: string): void => void process.stderr.write(line + '\n');
  const platform = io.platform ?? process.platform;
  const colour = io.colour ?? colourEnabled(process.env, process.stdout);
  const runners: OnboardRunners = {
    init: runInit,
    verify: runVerify,
    doctor: diagnose,
    check: runCheck,
    ...io.runners,
  };
  const interactive = io.interactive ?? (Boolean(process.stdin.isTTY) && !process.env.CI && !process.env.GITHUB_ACTIONS);
  const scripted = Boolean(opts.yes);

  const tone = (kind: 'ok' | 'warn' | 'bad' | 'info' | 'dim'): string => {
    if (kind === 'ok') return GREEN;
    if (kind === 'warn') return YELLOW;
    if (kind === 'bad') return RED;
    if (kind === 'info') return CYAN;
    return DIM;
  };
  const status = (label: string, text: string, kind: 'ok' | 'warn' | 'bad' | 'info' | 'dim' = 'info'): void => {
    out(paint(label.padEnd(8), (kind === 'bad' ? BOLD : '') + tone(kind), colour) + ' ' + text);
  };
  const fail = (text: string): void => rawErr(paint('ERROR   ', BOLD + RED, colour) + ' ' + text);

  if (!interactive && !scripted) {
    fail('onboard needs an interactive terminal.');
    rawErr('Use `tamperward onboard --yes --verify-command "<suite command>"` for scripted setup,');
    rawErr('or run `tamperward init` for the deterministic wiring step only.');
    return 2;
  }

  const rootText = git(requestedCwd, ['rev-parse', '--show-toplevel'])?.trim() ?? '';
  if (!rootText) {
    fail(requestedCwd + ' is not inside a Git repository. Run `git init` first.');
    return 2;
  }
  const cwd = resolve(rootText);
  if (cwd !== requestedCwd) {
    fail('current directory is not the Git repository root.');
    rawErr('Current: ' + requestedCwd);
    rawErr('Git root: ' + cwd);
    rawErr('TamperWard installs repository-wide hooks and CI, so it will not mix a child directory with its parent repository.');
    rawErr('Run from the Git root, or run `git init` in the child directory if it should be a separate repository.');
    return 2;
  }

  const prompt: { asker: Asker | null } = { asker: null };
  const rawAsk: (q: string) => Promise<string | null> =
    io.ask ?? ((q) => (prompt.asker ??= readlineAsker(process.stdin, process.stdout))(q));
  const ask = async (question: string): Promise<string> => {
    const answer = await rawAsk(question);
    if (answer === null) throw new Aborted();
    return answer.trim();
  };
  const confirm = async (question: string, fallback: boolean, scriptedAnswer: boolean): Promise<boolean> => {
    if (scripted) return scriptedAnswer;
    const a = (await ask(question + ' ' + (fallback ? '[Y/n]' : '[y/N]') + ' ')).toLowerCase();
    if (a === '') return fallback;
    return a === 'y' || a === 'yes';
  };

  let sectionNo = 0;
  const section = (n: number): void => {
    sectionNo = n;
    out('');
    out(paint(n + '/' + SECTIONS.length + '  ' + SECTIONS[n - 1], BOLD + CYAN, colour));
  };

  const wrote: string[] = [];
  let verifyCommand: string | undefined;
  let verifyResult: { code: number; summary: VerifyVerdictSummary | null } | null = null;
  let githubChecked = false;
  let repo: string | null = null;
  let declined = false;
  let doctorOutcome: DoctorOutcome | null = null;

  try {
    out(paint('TamperWard onboarding', BOLD, colour));
    out(paint('v' + TW_VERSION + ' · Node ' + process.versions.node + ' · ' + platformLabel(platform) + '/' + process.arch, DIM, colour));
    out(paint(cwd, DIM, colour));

    // ---- 1. Environment ---------------------------------------------------
    section(1);
    const lifecycle = lifecyclePlatformCheck(platform);
    const localVerifySupported = localVerifierShell(platform, 'true') !== null;
    if (platform === 'linux' && lifecycle.state === 'OK') {
      status('OK', 'Full check / verify / run support is available.', 'ok');
    } else if (localVerifySupported) {
      status('LIMITED', platformLabel(platform) + ': check + verify work here; `tamperward run` requires Linux in this release.', 'warn');
    } else {
      status('LIMITED', platformLabel(platform) + ': check works here; local verify and `run` are unavailable. Use the container verifier for final verification.', 'warn');
    }

    const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim() ?? null;
    if (!head) status('ACTION', 'No commit yet. Commit once before pristine verification or the safe demo.', 'warn');

    const treeStatus = git(cwd, ['status', '--porcelain', '--untracked-files=all']) ?? '';
    const dirty = treeStatus
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).split(' -> ').at(-1) ?? '');
    const owned = new Set(planInit(cwd).map((a) => a.path));
    const foreign = dirty.filter((p) => !owned.has(p));
    if (dirty.length === 0) {
      status('OK', 'Working tree is clean.', 'ok');
    } else if (foreign.length === 0) {
      status('ACTION', dirty.length + ' uncommitted setup file(s) from TamperWard; commit them when setup is complete.', 'warn');
    } else {
      status('ACTION', dirty.length + ' existing changed/untracked path(s). TamperWard will not stash or reset them.', 'warn');
      if (!(await confirm('Continue with the existing working-tree changes?', false, true))) {
        status('STOPPED', 'Commit or stash your work, then re-run `tamperward onboard`.', 'warn');
        return 2;
      }
    }

    // ---- 2. Local protection ---------------------------------------------
    section(2);
    const plan = planInit(cwd);
    const names: Record<string, string> = {
      policy: 'Policy',
      agent: 'Claude hooks',
      'pre-commit': 'Pre-commit',
      ci: 'CI workflow',
      codeowners: 'CODEOWNERS',
    };
    const renderPlan = (a: ReturnType<typeof planInit>[number]): void => {
      const name = (names[a.item] ?? a.item).padEnd(13);
      if (a.status === 'ok') status('OK', name + ' ' + a.path, 'ok');
      else if (a.status === 'create') status('ADD', name + ' ' + a.path, 'info');
      else if (a.status === 'update') status('UPDATE', name + ' ' + a.path, 'info');
      else if (a.status === 'skip') status('ACTION', name + ' ' + a.path + ' — ' + a.detail, 'warn');
      else status('ERROR', name + ' ' + a.path + ' — ' + a.detail, 'bad');
      if (a.warning) status('ACTION', a.warning, 'warn');
    };
    plan.forEach(renderPlan);

    const pending = plan.filter((a) => a.apply).length;
    const planErrors = plan.filter((a) => a.status === 'error').length;
    if (pending === 0) {
      status(planErrors ? 'ACTION' : 'OK', planErrors ? 'Nothing can be written until the error(s) above are fixed.' : 'Local protection is already wired.', planErrors ? 'warn' : 'ok');
    } else if (await confirm('Apply ' + pending + ' setup change(s)?', true, true)) {
      const code = runners.init({ cwd, quiet: true });
      wrote.push(...plan.filter((a) => a.apply).map((a) => a.path));
      if (code === 0) {
        status('OK', 'Applied ' + pending + ' setup change(s).', 'ok');
      } else {
        status('ACTION', 'Some setup items still need attention.', 'warn');
        planInit(cwd).filter((a) => a.status === 'error' || a.status === 'skip').forEach(renderPlan);
      }
    } else {
      declined = true;
      status('SKIP', 'No setup files were changed.', 'dim');
    }

    // ---- 3. Verification --------------------------------------------------
    section(3);
    let configured: string | undefined;
    try {
      configured = loadPolicy(cwd).verify?.command?.trim() || undefined;
    } catch (e) {
      status('ERROR', POLICY_FILE + ' does not load — ' + errorMessage(e), 'bad');
    }

    if (configured) {
      verifyCommand = configured;
      status('OK', 'Trusted test command: ' + configured, 'ok');
    } else if (!declined) {
      const candidates = verifierCandidates(cwd);
      let chosen: string | undefined;
      if (scripted) {
        if (opts.verifyCommand?.trim()) {
          chosen = opts.verifyCommand.trim();
        } else {
          status('ACTION', 'No trusted test command configured. Pass --verify-command "<suite command>".', 'warn');
        }
      } else if (candidates.length === 1) {
        status('FOUND', candidates[0], 'info');
        if (await confirm('Trust `' + candidates[0] + '` as the verifier command?', false, false)) {
          chosen = candidates[0];
        } else {
          chosen = (await ask('Test command to trust (Enter to skip): ')) || undefined;
        }
      } else if (candidates.length > 1) {
        status('ACTION', 'Choose the command that decides whether this repository passes:', 'warn');
        candidates.forEach((candidate, i) => out('  ' + (i + 1) + '. ' + candidate));
        const a = await ask('Choose 1-' + candidates.length + ', type a command, or press Enter to skip: ');
        const n = Number(a);
        chosen = a === '' ? undefined : Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : a;
      } else {
        status('ACTION', 'No test command was detected automatically.', 'warn');
        chosen = (await ask('Test command to trust (Enter to skip): ')) || undefined;
      }

      if (chosen) {
        const problem = writeVerifyCommand(cwd, chosen);
        if (problem) {
          status('ERROR', 'verify.command was not written — ' + problem, 'bad');
        } else {
          verifyCommand = chosen;
          wrote.push(POLICY_FILE);
          status('OK', 'Saved verify.command: ' + chosen + ' (budget 300s).', 'ok');
        }
      }
    }

    if (!verifyCommand) {
      status('ACTION', 'Verification is not configured; CI will fail closed until it is.', 'warn');
      out(paint('         Set it later with: tamperward onboard --verify-command "<suite command>"', DIM, colour));
    } else if (!localVerifySupported) {
      status('LIMITED', 'Local verification is unavailable on ' + platformLabel(platform) + '; use a digest-pinned container verifier.', 'warn');
    } else if (!head) {
      status('ACTION', 'Commit once, then run `tamperward verify`.', 'warn');
    } else if (await confirm('Run the first verification now? (the suite runs twice)', true, true)) {
      let summary: VerifyVerdictSummary | null = null;
      const verifyOpts: VerifyOpts = {
        cwd,
        silent: true,
        onVerdict: (v) => { summary = v; },
      };
      if (opts.base) verifyOpts.base = opts.base;
      const code = runners.verify(verifyOpts);
      verifyResult = { code, summary };
      status(code === 0 ? 'OK' : code === 1 ? 'ACTION' : 'ERROR', explainVerdict(summary, code), code === 0 ? 'ok' : code === 1 ? 'warn' : 'bad');
    } else {
      status('SKIP', 'Verification skipped. Run `tamperward verify` when ready.', 'dim');
    }

    if (!opts.skipDemo) {
      const wanted = scripted ? Boolean(opts.demo) : opts.demo ? true : await confirm('Run the optional safe tamper demo? (temporary worktree only)', false, false);
      if (wanted && head) {
        runDemo(cwd, head, runners, out);
      } else if (wanted) {
        status('SKIP', 'Demo needs at least one commit.', 'dim');
      }
    }

    // ---- 4. GitHub protection --------------------------------------------
    section(4);
    repo = opts.repo ?? inferGitHubRepo(cwd);
    const doctorCommand = 'tamperward doctor --github --repo ' + (repo ?? 'OWNER/REPO') + ' --branch ' + (opts.branch ?? '<default-branch>');
    if (opts.noGithub) {
      status('SKIP', 'GitHub repository controls were not checked.', 'dim');
    } else if (!repo) {
      status('ACTION', 'No github.com origin detected. Pass --repo OWNER/REPO to check repository protection.', 'warn');
    } else {
      status('INFO', (repo + (opts.branch ? '#' + opts.branch : '')), 'info');
      githubChecked = await confirm('Check GitHub branch protection now?', true, true);
      if (!githubChecked) status('SKIP', 'GitHub repository controls were not checked.', 'dim');
    }

    // ---- 5. Summary -------------------------------------------------------
    section(5);
    const doctorOpts: DoctorOpts = { cwd };
    if (githubChecked && repo) {
      doctorOpts.github = true;
      doctorOpts.repo = repo;
      if (opts.branch) doctorOpts.branch = opts.branch;
    }
    doctorOutcome = runners.doctor(doctorOpts);

    const seenFailure = new Set<string>();
    for (const check of doctorOutcome.checks) {
      if (check.state === 'OK' || check.id === 'observer') continue;
      seenFailure.add(check.id);
      if (check.id === 'platform' && platform !== 'linux') {
        const detail = localVerifySupported
          ? platformLabel(platform) + ': `tamperward run` requires Linux; check + verify remain available.'
          : platformLabel(platform) + ': `tamperward run` and local verify are unavailable; check remains available.';
        status('LIMITED', detail, 'warn');
      } else {
        renderCheck(check, out, colour);
      }
    }
    if (doctorOutcome.failure && !seenFailure.has(doctorOutcome.failure.id)) {
      status('ACTION', doctorOutcome.failure.message, 'warn');
    }

    const posture = postureOf(doctorOutcome);
    if (posture === 'READY') status('READY', 'TamperWard is configured for this repository.', 'ok');
    else if (posture === 'READY WITH WARNINGS') status('READY', 'Configured with the limitation(s) above.', 'warn');
    else if (posture === 'INCOMPLETE') status('INCOMPLETE', 'Setup needs the action(s) above.', 'warn');
    else status('BLOCKED', 'Fix the broken item(s) above before relying on the gate.', 'bad');

    if (doctorOutcome.github) {
      status('OK', 'GitHub authority enforced for ' + doctorOutcome.github.repo + '#' + doctorOutcome.github.branch + '.', 'ok');
    } else {
      status('ACTION', 'GitHub authority is not verified yet.', 'warn');
      out(paint('         ' + doctorCommand, DIM, colour));
      for (const line of MANUAL_CONTROLS) out(paint('         ' + line, DIM, colour));
    }

    if (wrote.length) {
      status('NEXT', 'Commit setup files: ' + [...new Set(wrote)].join(', '), 'info');
    }
    if (!verifyCommand) {
      status('NEXT', 'Choose the test command TamperWard should trust for verification.', 'info');
    }
    if (verifyResult) {
      status('VERIFY', verifyResult.summary?.verdict ?? ('exit ' + verifyResult.code), verifyResult.code === 0 ? 'ok' : 'warn');
    }
    out(paint('         Daily: tamperward check --worktree · tamperward verify --base <base>', DIM, colour));

    return posture === 'READY' || posture === 'READY WITH WARNINGS' ? 0 : 1;
  } catch (e) {
    if (e instanceof Aborted) {
      out('');
      status('STOPPED', 'Onboarding was cancelled during ' + (SECTIONS[sectionNo - 1] ?? 'setup') + '.', 'warn');
      if (wrote.length) status('INFO', 'Already written: ' + [...new Set(wrote)].join(', ') + '. Re-running is safe.', 'dim');
      else status('INFO', 'Nothing was written.', 'dim');
      return 2;
    }
    throw e;
  } finally {
    prompt.asker?.close();
  }
}

function renderCheck(check: DoctorCheck, out: (line: string) => void, colour: boolean): void {
  const broken = check.state === 'BROKEN';
  const label = broken ? 'ERROR' : 'WARN';
  const code = broken ? BOLD + RED : YELLOW;
  out(paint(label.padEnd(8), code, colour) + ' ' + check.id + ' — ' + check.detail);
}

function postureOf(outcome: DoctorOutcome): Posture {
  if (outcome.failure) return 'INCOMPLETE';
  // The platform check means the Linux-only run envelope is unavailable. Doctor
  // keeps that as BROKEN, but check/verify onboarding itself can still be ready
  // on macOS. Keep the limitation visible without calling the whole setup broken.
  if (outcome.checks.some((c) => c.state === 'BROKEN' && c.id !== 'platform')) return 'BROKEN';
  if (outcome.checks.some((c) => c.state === 'WARN' || (c.state === 'BROKEN' && c.id === 'platform'))) {
    return 'READY WITH WARNINGS';
  }
  return 'READY';
}

/** The demonstration: a detached temporary worktree of `head`, one `.skip`
 *  added there, `check --worktree` over it, then the worktree removed. Only
 *  state this function created is ever written to. */
function runDemo(cwd: string, head: string, runners: OnboardRunners, out: (line: string) => void): void {
  // The tree mode is part of the safety boundary: a test-shaped symlink's blob
  // is its link target, and that text can itself begin with "it(" / "test(".
  // Never select mode 120000 (or any other non-regular entry) for the demo.
  const files = (git(cwd, ['ls-tree', '-r', '-z', head]) ?? '')
    .split('\0')
    .filter(Boolean)
    .flatMap((row) => {
      const tab = row.indexOf('\t');
      if (tab < 0) return [];
      const mode = row.slice(0, tab).split(' ')[0];
      const path = row.slice(tab + 1);
      return (mode === '100644' || mode === '100755') && JS_TEST_PATH.test(path) ? [path] : [];
    });
  let target: { path: string; before: string; after: string } | null = null;
  for (const path of files) {
    const before = git(cwd, ['show', `${head}:${path}`]);
    if (before === null || !JS_TEST_BLOCK.test(before)) continue;
    target = { path, before, after: before.replace(JS_TEST_BLOCK, '$1$2.skip$3') };
    break;
  }
  if (!target) {
    out('Demo skipped: no JavaScript test block (it/test/describe) at HEAD to demonstrate on.');
    return;
  }

  const before = treeFingerprint(cwd);
  out(`working tree fingerprint before: ${before.slice(0, 16)}`);
  const wt = mkdtempSync(join(tmpdir(), 'tw-onboard-demo-'));
  try {
    if (git(cwd, ['worktree', 'add', '--detach', wt, head]) === null) {
      out('Demo skipped: could not create a temporary worktree (git worktree add failed).');
      return;
    }
    const targetPath = join(wt, target.path);
    const targetStat = lstatSync(targetPath, { throwIfNoEntry: false });
    if (!targetStat || !targetStat.isFile() || targetStat.isSymbolicLink()) {
      out('Demo skipped: the selected test is not a regular file in the disposable worktree.');
      return;
    }
    let worktreeRoot: string;
    let realTarget: string;
    try {
      worktreeRoot = realpathSync(wt);
      realTarget = realpathSync(targetPath);
    } catch {
      out('Demo skipped: the selected test could not be resolved safely inside the disposable worktree.');
      return;
    }
    const prefix = worktreeRoot.endsWith(sep) ? worktreeRoot : worktreeRoot + sep;
    if (!realTarget.startsWith(prefix)) {
      out('Demo skipped: the selected test resolves outside the disposable worktree.');
      return;
    }
    out(`disposable worktree: ${wt}`);
    out(`weakening move: ${target.path} — the first test block becomes .skip (only in the disposable copy)`);
    atomicReplaceFile(targetPath, target.after, targetStat.mode & 0o777);
    out('');
    out(`$ tamperward check --worktree   (in ${wt})`);
    const code = runners.check({ cwd: wt, worktree: true });
    out('');
    out(`check exited ${code}: ${code === 1 ? 'a blocking finding, which is what the hook, pre-commit and CI would all report' : 'no blocking finding was reported'}.`);
  } finally {
    git(cwd, ['worktree', 'remove', '--force', wt]);
    git(cwd, ['worktree', 'prune']);
    rmSync(wt, { recursive: true, force: true });
  }
  const after = treeFingerprint(cwd);
  out(`working tree fingerprint after:  ${after.slice(0, 16)}`);
  if (after === before) {
    out('Identical: your working tree was restored byte-for-byte (it was never edited; the disposable worktree is gone).');
  } else {
    out('WARNING: the fingerprint moved. The demo never wrote into your working tree, so something else');
    out('changed it while the demo ran; inspect with `git status`.');
  }
}
