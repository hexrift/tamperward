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
//
// A marker inside a string literal is text, not a directive: `HEADER = "/* eslint-
// disable */"` in a codemod and a docstring saying "never add # noqa" are the
// maintainer's routine edits, and the per-line quote scan in files.ts excuses them.

import { Change, Detector, Finding } from '../types';
import { addedLines } from '../diff/select';
import { insideStringLiteral, Lang, langOf } from './files';
import { makeFinding } from './finding';

const RULE = 'lint-suppression';

type Pattern = { re: RegExp; why: string };

const PATTERNS: Record<Lang, Pattern[]> = {
  js: [
    { re: /eslint-disable(?:-next-line|-line)?\b/, why: 'eslint-disable suppresses lint rules' },
    // Inline config is the other spelling of the same directive: `/* eslint rule: off */`,
    // `: "off"`, `: 0`, `: [0, …]`. `/* eslint-env */` and `/* eslint rule: "error" */` are not.
    { re: /\/\*\s*eslint\s+(?!-)(?:[^*]*?[\s,])?[\w@/.-]+\s*:\s*\[?\s*(?:["']off["']|off\b|0\b)/, why: 'an inline eslint config turns a rule off' },
    { re: /\bprettier-ignore\b/, why: 'prettier-ignore suppresses formatting checks' },
    { re: /\bbiome-ignore\b/, why: 'biome-ignore suppresses Biome diagnostics' },
  ],
  py: [
    { re: /#\s*noqa\b/, why: '# noqa suppresses flake8/ruff findings' },
    { re: /#\s*(?:ruff|flake8):\s*noqa\b/, why: '# ruff: noqa / # flake8: noqa suppresses every finding in the file' },
    { re: /#\s*type:\s*ignore\b/, why: '# type: ignore suppresses the type checker' },
    { re: /#\s*mypy:\s*ignore-errors\b/, why: '# mypy: ignore-errors suppresses the type checker for the file' },
    { re: /#\s*pyright:\s*ignore\b/, why: '# pyright: ignore suppresses the type checker' },
    { re: /#\s*pylint:\s*disable\b/, why: '# pylint: disable suppresses lint rules' },
    { re: /#\s*pylint:\s*skip-file\b/, why: '# pylint: skip-file suppresses lint for the file' },
    { re: /#\s*nosec\b/, why: '# nosec suppresses bandit security findings' },
    { re: /#\s*fmt:\s*(?:off|skip)\b/, why: '# fmt: off/skip suppresses formatting checks' },
  ],
  go: [
    { re: /\/\/\s*nolint\b/, why: '//nolint suppresses golangci-lint findings' },
    { re: /\/\/\s*lint:ignore\b/, why: '//lint:ignore suppresses staticcheck findings' },
  ],
  rs: [],
  rb: [{ re: /#\s*rubocop:\s*(?:disable|todo)\b/, why: '# rubocop:disable suppresses lint rules' }],
  java: [
    { re: /@SuppressWarnings\s*\(/, why: '@SuppressWarnings suppresses compiler and lint warnings' },
    { re: /\/\/\s*NOSONAR\b/, why: '// NOSONAR suppresses SonarQube findings' },
  ],
  kt: [
    { re: /@(?:file:)?Suppress(?:Warnings)?\s*\(/, why: '@Suppress suppresses compiler and lint warnings' },
    { re: /\/\/\s*NOSONAR\b/, why: '// NOSONAR suppresses SonarQube findings' },
  ],
  php: [
    { re: /\bphpcs:(?:ignore|disable)\b/, why: 'phpcs:ignore/disable suppresses coding-standard checks' },
    { re: /@codingStandardsIgnore(?:Line|Start|File)\b/, why: '@codingStandardsIgnore* suppresses coding-standard checks' },
    { re: /@phpstan-ignore\b/, why: '@phpstan-ignore suppresses static-analysis findings' },
    { re: /@psalm-suppress\b/, why: '@psalm-suppress suppresses static-analysis findings' },
  ],
  cs: [
    { re: /#pragma\s+warning\s+disable\b/, why: '#pragma warning disable suppresses compiler warnings' },
    { re: /\[SuppressMessage\s*\(/, why: '[SuppressMessage] suppresses analyzer findings' },
    { re: /\/\/\s*ReSharper\s+disable\b/, why: '// ReSharper disable suppresses inspections' },
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
          const m = p.re.exec(l.content);
          if (!m || insideStringLiteral(l.content, m.index, lang)) continue;
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
    return out;
  },
};
