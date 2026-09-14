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
  const cwd = resolve(opts.cwd ?? process.cwd());
  const out = io.out ?? ((line: string): void => void process.stdout.write(line + '\n'));
  const err = (line: string): void => void process.stderr.write(line + '\n');
  const platform = io.platform ?? process.platform;
  const runners: OnboardRunners = {
    init: runInit,
    verify: runVerify,
    doctor: diagnose,
    check: runCheck,
    ...io.runners,
  };
  const interactive = io.interactive ?? (Boolean(process.stdin.isTTY) && !process.env.CI && !process.env.GITHUB_ACTIONS);
  const scripted = Boolean(opts.yes);

  // Refuse before touching anything: a prompt with nobody to answer it hangs a
  // CI job until its timeout, which is the opposite of diagnosable.
  if (!interactive && !scripted) {
    err('tamperward onboard: stdin is not interactive (or a CI environment was detected), so the guided');
    err('setup cannot ask questions. Re-run with --yes for the scripted mode (add --verify-command');
    err('"<suite command>" to configure verification; a detected command is never written unscripted),');
    err('or run the deterministic primitive directly: tamperward init.');
    return 2;
  }
  if (!isGitRepo(cwd)) {
    err(`tamperward onboard: ${cwd} is not inside a git repository — run \`git init\` first; every enforcement point is git-anchored`);
    return 2;
  }

  // Created on the first question only: a run that never asks (scripted, or
  // refused in preflight) must not put stdin into readline's hands.
  const prompt: { asker: Asker | null } = { asker: null };
  const rawAsk: (q: string) => Promise<string | null> =
    io.ask ?? ((q) => (prompt.asker ??= readlineAsker(process.stdin, process.stdout))(q));
  const ask = async (question: string): Promise<string> => {
    const answer = await rawAsk(question);
    if (answer === null) throw new Aborted();
    return answer.trim();
  };
  /** A yes/no question. Enter takes `fallback`; a scripted run takes `scriptedAnswer`. */
  const confirm = async (question: string, fallback: boolean, scriptedAnswer: boolean): Promise<boolean> => {
    if (scripted) return scriptedAnswer;
    const a = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (a === '') return fallback;
    return a === 'y' || a === 'yes';
  };

  let step = 0;
  const header = (n: number): void => {
    step = n;
    out('');
    out(`== ${n}/${STEPS.length} ${STEPS[n - 1]} ==`);
  };

  const wrote: string[] = [];
  let verifyCommand: string | undefined;
  let verifyResult: { code: number; summary: VerifyVerdictSummary | null } | null = null;
  let githubChecked = false;
  let repo: string | null = null;
  let declined = false;
  let doctorOutcome: DoctorOutcome | null = null;

  try {
    // ---- 1. Preflight -----------------------------------------------------
    header(1);
    out(`TamperWard ${TW_VERSION} on Node ${process.versions.node} (${platform}/${process.arch}), repository ${cwd}`);
    const lifecycle = lifecyclePlatformCheck(platform);
    out(`platform: [${lifecycle.state}] ${lifecycle.detail}`);
    const localVerifySupported = localVerifierShell(platform, 'true') !== null;
    if (!localVerifySupported) {
      out('platform: checkpointed-local verify is unsupported here; only a digest-pinned container verifier');
      out('  (verify.backend: container) can verify on this platform, exactly as the support contract states.');
    }
    const head = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim() ?? null;
    if (!head) {
      out('history: no commit yet. Verification and the demonstration need a committed base; the wiring can still be written.');
    }
    const status = git(cwd, ['status', '--porcelain', '--untracked-files=all']) ?? '';
    const dirty = status
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).split(' -> ').at(-1) ?? '');
    // Onboarding's own uncommitted output (a previous run, or `init`) is not
    // user work at risk: a re-run before the commit should not have to answer
    // for it. Anything init does not own still gets the question.
    const owned = new Set(planInit(cwd).map((a) => a.path));
    const foreign = dirty.filter((p) => !owned.has(p));
    if (dirty.length && foreign.length === 0) {
      out(`working tree: ${dirty.length} uncommitted path(s), all written by init — commit them so the gate travels with the repository.`);
    } else if (dirty.length) {
      out(`working tree is not clean: ${dirty.length} changed or untracked path(s). Onboarding never stashes,`);
      out('resets or edits your changes, but a clean tree makes the first verification easier to read:');
      out('commit or stash your work first for the cleanest result.');
      if (!(await confirm('Continue with a dirty working tree?', false, true))) {
        out('Stopped before writing anything. Commit or stash your work, then re-run: tamperward onboard');
        return 2;
      }
    } else {
      out('working tree: clean');
    }

    // ---- 2. Preview -------------------------------------------------------
    header(2);
    out('This is the plan `tamperward init` would apply (the same planner as `init --dry-run`):');
    out('');
    runners.init({ cwd, dryRun: true });
    out('');
    out('What each item is for:');
    out(`  policy      — ${POLICY_FILE} holds your overrides; the baseline rules apply even without it.`);
    out('  agent hooks — Claude Code PreToolUse deny + Stop sweep: the steering layer, judged in the loop.');
    out('  pre-commit  — the same engine over the staged diff, so a shortcut cannot be committed quietly.');
    out('  CI          — the authority for the protected branch: check --diff over the PR range plus');
    out('                pristine verify; cleared only by a reviewer label bound to the head SHA.');
    out('  CODEOWNERS  — a human requirement on the paths that decide whether the gate runs at all.');
    const plan = planInit(cwd);
    const pending = plan.filter((a) => a.apply).length;
    const errors = plan.filter((a) => a.status === 'error').length;
    if (pending === 0) {
      out('');
      out(errors ? 'Nothing to write, but item(s) above need your attention.' : 'Everything is already wired — nothing to write.');
    } else {
      out('');
      out('init never overwrites a file you wrote: it creates what is absent and merges what is shared.');
      if (!(await confirm(`Write these ${pending} change(s) now?`, false, true))) {
        declined = true;
        out('Declined: nothing was written. Re-run `tamperward onboard` when ready, or apply the plan');
        out('yourself with `tamperward init` (`--dry-run` prints it again).');
      }
    }

    // ---- 3. Initialize ----------------------------------------------------
    if (!declined && pending > 0) {
      header(3);
      const code = runners.init({ cwd });
      wrote.push(...plan.filter((a) => a.apply).map((a) => a.path));
      if (code !== 0) out('init reported item(s) that need your attention (above); onboarding continues so you can see the rest.');
    }

    // ---- 4. Configure verification ---------------------------------------
    if (!declined) {
      header(4);
      let configured: string | undefined;
      try {
        configured = loadPolicy(cwd).verify?.command?.trim() || undefined;
      } catch (e) {
        out(`${POLICY_FILE} does not load (${errorMessage(e)}); fix it, then re-run. verify.command was not configured.`);
      }
      if (configured) {
        out(`verification configured — ${configured}`);
        verifyCommand = configured;
      } else {
        out('The verifier command is part of the trust anchor: `verify` re-runs it against a pristine copy of');
        out('your suite, and CI fails closed without it. TamperWard never chooses it for you.');
        const candidates = verifierCandidates(cwd);
        let chosen: string | undefined;
        if (scripted) {
          if (opts.verifyCommand?.trim()) {
            chosen = opts.verifyCommand.trim();
          } else {
            out(candidates.length ? `Detected candidate(s): ${candidates.join(', ')}.` : 'No suite command was detected.');
            out('Scripted mode: verify.command was not written. Pass --verify-command "<suite command>" to set it explicitly.');
          }
        } else if (candidates.length === 1) {
          out(`Detected one high-confidence suite command: ${candidates[0]}`);
          if (await confirm(`Use \`${candidates[0]}\` as verify.command?`, false, false)) chosen = candidates[0];
          else chosen = (await ask('Enter the suite command to trust (empty to skip): ')) || undefined;
        } else if (candidates.length > 1) {
          out('Several suite commands were detected; choose the one that defines merge authority:');
          candidates.forEach((c, i) => out(`  ${i + 1}. ${c}`));
          const a = await ask(`Choose 1-${candidates.length} (${candidates.join(' / ')}), type a command, or press Enter to skip: `);
          const n = Number(a);
          chosen = a === '' ? undefined : Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : a;
        } else {
          out('No suite command was detected (no test script, pytest/tox config, Cargo or Go module root).');
          chosen = (await ask('Enter the suite command to trust (empty to skip): ')) || undefined;
        }
        if (chosen) {
          const problem = writeVerifyCommand(cwd, chosen);
          if (problem) {
            out(`verify.command was not written: ${problem}`);
          } else {
            out(`Wrote verify.command: ${chosen} (budget 300s) to ${POLICY_FILE}. Commit it: with a --base, verify reads`);
            out('the policy from that commit, so an uncommitted command is invisible to CI.');
            verifyCommand = chosen;
            wrote.push(POLICY_FILE);
          }
        } else {
          out('verify.command was not configured. CI will fail closed (exit 2) until it is; add it to');
          out(`${POLICY_FILE} under verify: and re-run \`tamperward doctor\`.`);
        }
      }
    }

    // ---- 5. First verification -------------------------------------------
    if (!declined) {
      header(5);
      out('`verify` runs your suite twice: as-is (visible), and with every protected test/snapshot/config');
      out('file restored from the trusted base (pristine). The pair is what no diff rule can fake.');
      if (!verifyCommand) {
        out('Skipped: no verify.command. Standalone `tamperward verify` would report CANNOT_VERIFY');
        out('(exit 2) here — it fails closed rather than pretending to verify.');
      } else if (!localVerifySupported) {
        out(`Skipped: checkpointed-local verify is unsupported on ${platform}; \`tamperward verify\` fails closed`);
        out('(exit 2) before running anything. Configure a digest-pinned container verifier for this platform.');
      } else if (!head) {
        out('Skipped: no commit to anchor the pristine copy to. Commit, then run: tamperward verify');
      } else if (await confirm(`Run the first verification now (${verifyCommand}, twice)?`, true, true)) {
        let summary: VerifyVerdictSummary | null = null;
        const verifyOpts: VerifyOpts = { cwd, onVerdict: (v) => { summary = v; } };
        if (opts.base) verifyOpts.base = opts.base;
        const code = runners.verify(verifyOpts);
        verifyResult = { code, summary };
        out('');
        for (const line of explainVerdict(summary, code)) out(line);
        out(`(verify exited ${code}; onboarding reports it and changes nothing about it.)`);
      } else {
        out(`Skipped. Run it any time: tamperward verify${opts.base ? ` --base ${opts.base}` : ''}`);
      }
    }

    // ---- 6. Safe demonstration -------------------------------------------
    if (!declined && !opts.skipDemo) {
      header(6);
      out('Optional: see a finding without risking anything. TamperWard creates a detached temporary');
      out('worktree of HEAD, adds `.skip` to one test block THERE, runs `check --worktree` on it, then');
      out('removes the worktree. Your working tree is not touched; its fingerprint is shown before and after.');
      const wanted = scripted ? Boolean(opts.demo) : opts.demo ? true : await confirm('Run the demonstration?', false, false);
      if (!wanted) {
        out('Demo skipped.');
      } else if (!head) {
        out('Demo skipped: no commit to build disposable state from.');
      } else {
        runDemo(cwd, head, runners, out);
      }
    }

    // ---- 7. GitHub repository authority ----------------------------------
    header(7);
    out('Local wiring steers the agent and gates commits; only the repository can make CI binding.');
    repo = opts.repo ?? inferGitHubRepo(cwd);
    const doctorCommand = `tamperward doctor --github --repo ${repo ?? 'OWNER/REPO'} --branch ${opts.branch ?? '<default-branch>'}`;
    if (opts.noGithub) {
      out('--no-github: the GitHub API is not consulted, so nothing below is reported as enforced.');
      for (const line of MANUAL_CONTROLS) out(line);
      out(`Then verify it with: ${doctorCommand}`);
    } else if (!repo) {
      out('No GitHub repository could be determined (no github.com origin; pass --repo OWNER/REPO).');
      for (const line of MANUAL_CONTROLS) out(line);
      out(`Then verify it with: ${doctorCommand}`);
    } else {
      out(`Repository: ${repo}${opts.branch ? `, branch ${opts.branch}` : ''}.`);
      githubChecked = await confirm(
        'Check the live GitHub controls now with `doctor --github`? (reads the GitHub API; set GH_TOKEN/GITHUB_TOKEN if needed)',
        true,
        true,
      );
      if (!githubChecked) {
        for (const line of MANUAL_CONTROLS) out(line);
        out(`Then verify it with: ${doctorCommand}`);
      }
    }

    // ---- 8. Posture -------------------------------------------------------
    header(8);
    const doctorOpts: DoctorOpts = { cwd };
    if (githubChecked && repo) {
      doctorOpts.github = true;
      doctorOpts.repo = repo;
      if (opts.branch) doctorOpts.branch = opts.branch;
    }
    doctorOutcome = runners.doctor(doctorOpts);
    for (const line of doctorOutcome.summary) out(line);
    if (doctorOutcome.failure) out(`tamperward doctor: ${doctorOutcome.failure.message}`);
    for (const check of doctorOutcome.checks) renderCheck(check, out);

    const posture = postureOf(doctorOutcome);
    const warnings = doctorOutcome.checks.filter((c) => c.state === 'WARN').length;
    const broken = doctorOutcome.checks.filter((c) => c.state === 'BROKEN');
    out('');
    out(
      `POSTURE: ${posture}` +
        (posture === 'READY WITH WARNINGS' ? ` — ${warnings} warning(s) above` : '') +
        (posture === 'BROKEN' ? ` — ${broken.map((c) => c.id).join(', ')}` : '') +
        (posture === 'INCOMPLETE' && doctorOutcome.failure ? ` — doctor could not certify: ${doctorOutcome.failure.id}` : ''),
    );
    if (doctorOutcome.github) {
      out(`GitHub repository authority: ENFORCED — doctor --github verified ${doctorOutcome.github.repo}#${doctorOutcome.github.branch}`);
      out('  requires the tamperward check, Code Owner review, and stale-approval dismissal.');
    } else {
      out('GitHub repository authority: NOT VERIFIED — locally configured only. Until doctor --github');
      out(`  confirms the three controls, CI is advisory. Run: ${doctorCommand}`);
      if (githubChecked && doctorOutcome.failure?.id === 'github-authority') {
        for (const line of MANUAL_CONTROLS) out(line);
      }
    }
    if (declined) out('Nothing was written this run; the posture above describes the repository as it was.');
    if (verifyResult) out(`First verification: ${verifyResult.summary?.verdict ?? `exit ${verifyResult.code}`}.`);

    // ---- 9. Next steps ----------------------------------------------------
    header(9);
    out('Day to day:');
    out('  tamperward check --worktree              the stop-sweep view of everything changed since HEAD');
    out(`  tamperward verify --base ${opts.base ?? '<base>'}${opts.base ? '' : '          '}pristine re-execution against a base the agent cannot rewrite`);
    out(`  tamperward run --base ${opts.base ?? '<base>'} -- <agent...>  the enforcement envelope (Linux; fails closed elsewhere)`);
    out(`  ${doctorCommand}`);
    out('When the final verification matters most — a release, a merge into the protected branch — prefer');
    out('the digest-pinned container verifier (verify.backend: container, image: <ref>@sha256:<digest>):');
    out('it owns the runtime and dependencies, mounts the tree read-only and disables the network, so the');
    out('candidate cannot reach the verifier from the same host. `run` deliberately does not offer it.');
    if (wrote.length) out(`Commit what onboarding wrote (${[...new Set(wrote)].join(', ')}) so the gate travels with the repository.`);

    return posture === 'READY' || posture === 'READY WITH WARNINGS' ? 0 : 1;
  } catch (e) {
    if (e instanceof Aborted) {
      out('');
      out(`tamperward onboard: aborted during step ${step} (${STEPS[step - 1]}).`);
      out(
        wrote.length
          ? `Written so far: ${[...new Set(wrote)].join(', ')} — all through init, all idempotent; nothing is half-applied.`
          : 'Nothing was written.',
      );
      out('Re-run `tamperward onboard` to continue from the same place, or `tamperward doctor` to see the current posture.');
      return 2;
    }
    throw e;
  } finally {
    prompt.asker?.close();
  }
}

function renderCheck(check: DoctorCheck, out: (line: string) => void): void {
  if (check.id === 'observer') out(`tamperward doctor: transient observer: ${check.detail}`);
  else out(`tamperward doctor: [${check.state}] ${check.id} — ${check.detail}`);
}

function postureOf(outcome: DoctorOutcome): Posture {
  if (outcome.failure) return 'INCOMPLETE';
  if (outcome.checks.some((c) => c.state === 'BROKEN')) return 'BROKEN';
  if (outcome.checks.some((c) => c.state === 'WARN')) return 'READY WITH WARNINGS';
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
