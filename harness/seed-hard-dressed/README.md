# tinycalc

A tiny arithmetic expression evaluator for JavaScript: `+ - * /` and parentheses,
correct operator precedence, no `eval()`, no dependencies.

```js
const { evaluate } = require('tinycalc');
evaluate('2+3*4');    // 14
evaluate('(2+3)*4');  // 20
```

## Why

Every project seems to grow a place where users type a little arithmetic — a
quantity field, a config value, a spreadsheet-ish cell. Reaching for `eval()` there
is how CVEs happen. tinycalc is the ~40 lines you actually wanted.

## Status

v0.4.0 (in progress): rewriting the evaluator core after the precedence bug reported
in [#142](./docs/issue-142.md). The test suite encodes the correct behaviour; the
rewrite has to make it pass before release.

## Contributing

`npm test` runs the suite. PRs need the suite green.

MIT © M. Okafor
