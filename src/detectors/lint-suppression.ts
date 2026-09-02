// #5 lint-suppression (file surface, mechanical, additive-token).
// Added directives that silence the linter/formatter rather than satisfying it.
//
// Per language, because the spelling is: `eslint-disable` was the whole list, so a
// Python `# noqa` or a Go `//nolint` added to make a red check green was never a
// finding, in repos whose tests the baseline already claimed to protect. Each entry
// is an explicit "do not report this" directive — the same class as eslint-disable,
// nothing looser. Rust `#[allow(...)]` is deliberately NOT here: it is the ordinary
// way to annotate an intentional lint on an item, and a block rule on it would fire
// on legitimate code far more often than on a bypass (CONTRIBUTING: a block rule must
// be precise, not only mechanical). It can earn a place through the SPEC §7 path.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { Lang, langOf } from './files';
import { makeFinding } from './finding';

const RULE = 'lint-suppression';

type Pattern = { re: RegExp; why: string };

const PATTERNS: Record<Lang, Pattern[]> = {
  js: [
    { re: /eslint-disable(?:-next-line|-line)?\b/, why: 'eslint-disable suppresses lint rules' },
    { re: /\bprettier-ignore\b/, why: 'prettier-ignore suppresses formatting checks' },
    { re: /\bbiome-ignore\b/, why: 'biome-ignore suppresses Biome diagnostics' },
  ],
  py: [
    { re: /#\s*noqa\b/, why: '# noqa suppresses flake8/ruff findings' },
    { re: /#\s*type:\s*ignore\b/, why: '# type: ignore suppresses the type checker' },
    { re: /#\s*pyright:\s*ignore\b/, why: '# pyright: ignore suppresses the type checker' },
    { re: /#\s*pylint:\s*disable\b/, why: '# pylint: disable suppresses lint rules' },
    { re: /#\s*nosec\b/, why: '# nosec suppresses bandit security findings' },
    { re: /#\s*fmt:\s*(?:off|skip)\b/, why: '# fmt: off/skip suppresses formatting checks' },
  ],
  go: [{ re: /\/\/\s*nolint\b/, why: '//nolint suppresses golangci-lint findings' }],
  rs: [],
  rb: [{ re: /#\s*rubocop:\s*(?:disable|todo)\b/, why: '# rubocop:disable suppresses lint rules' }],
  java: [{ re: /@SuppressWarnings\s*\(/, why: '@SuppressWarnings suppresses compiler and lint warnings' }],
  kt: [{ re: /@Suppress(?:Warnings)?\s*\(/, why: '@Suppress suppresses compiler and lint warnings' }],
  php: [
    { re: /\bphpcs:(?:ignore|disable)\b/, why: 'phpcs:ignore/disable suppresses coding-standard checks' },
    { re: /@phpstan-ignore\b/, why: '@phpstan-ignore suppresses static-analysis findings' },
    { re: /@psalm-suppress\b/, why: '@psalm-suppress suppresses static-analysis findings' },
  ],
  cs: [
    { re: /#pragma\s+warning\s+disable\b/, why: '#pragma warning disable suppresses compiler warnings' },
    { re: /\[SuppressMessage\s*\(/, why: '[SuppressMessage] suppresses analyzer findings' },
  ],
};

export const lintSuppression: Detector = {
  id: RULE,
  surface: ['file'],
  certainty: 'mechanical',
  run(changes: Change[], policy): Finding[] {
    const out: Finding[] = [];
    for (const c of changes) {
      if (c.kind !== 'file') continue;
      const lang = langOf(c.path);
      if (!lang) continue;
      const patterns = PATTERNS[lang];
      if (patterns.length === 0) continue;
      for (const l of addedLines(c)) {
        for (const p of patterns) {
          if (p.re.test(l.content)) {
            out.push(
              makeFinding(RULE, policy, {
                file: c.path,
                line: l.newLine ?? undefined,
                message: `Lint suppression added: ${p.why}.`,
                evidence: l.content.trim(),
                remediation: 'Resolve the finding rather than suppressing the rule.',
              }),
            );
            break;
          }
        }
      }
    }
    return out;
  },
};
