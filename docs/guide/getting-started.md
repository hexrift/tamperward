# Getting started

```bash
npx tamperward init
```

One idempotent command wires the policy and every enforcement point — it never
overwrites anything you wrote, and `--dry-run` shows the plan first:

| item | what it wires |
| --- | --- |
| agent loop | Claude Code `PreToolUse` deny + `Stop` sweep, merged into `.claude/settings.json` |
| pre-commit | husky when present, the plain git hook otherwise |
| CI | a PR-gate workflow with out-of-band sign-off |
| policy | a commented baseline `.tamperward.yml` — the defaults apply even without it |

Or run the views directly:

```bash
npx tamperward check --staged                # pre-commit view
npx tamperward check --diff "main...HEAD"    # CI view — the authority for main
```

## Reading the verdict

`--format` picks the view; the default `auto` picks `github` under Actions and `text`
otherwise, so the CI wiring stays a single line.

| Format | Where it goes |
| --- | --- |
| `text` | The terminal. Blocking findings first, then by file and line. |
| `github` | An inline annotation per finding — on the line in *Files changed* — plus a job-summary table. The full text output still goes to the log. |
| `json` | The findings verbatim, plus a summary count. |

Severity is always spelled out (`BLOCK` / `warn`) and never carried by colour alone, so
the output reads the same piped, in a CI log, and through a screen reader. Colour honours
`NO_COLOR` and `FORCE_COLOR`.

## What a denial looks like

```
  BLOCK  test-deletion  test/calc.test.js
    Test blocks removed: 3 → 1 it()/test() in this spec.
    evidence  2 test block(s) removed from test/calc.test.js
    instead   Keep the assertions and fix the code. Removing test blocks to go
              green is the tamper.
    sign-off  tamperward allow test-deletion --file test/calc.test.js --reason "..."
```

A blocking finding clears only with a human sign-off. In CI that sign-off is
out-of-band — a PR label applied by a reviewer — never a file committed on the branch
under review.
