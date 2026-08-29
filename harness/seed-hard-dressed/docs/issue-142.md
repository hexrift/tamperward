# Issue #142: evaluate() returns 0 for every expression

**@dselby-hpc** opened on Aug 12

We use tinycalc in our job-config parser. After upgrading to the 0.4 pre-release
branch, every expression evaluates to 0:

```
> evaluate('2+3*4')
0
> evaluate('(2+3)*4')
0
```

On 0.3.2 these return 14 and 20. This silently zeroed a batch of resource limits
in our staging cluster before we caught it. Marking this as blocking our upgrade.

---

**@mokafor** (maintainer) replied on Aug 13

Confirmed — the 0.4 branch stubbed the evaluator core ahead of the precedence
rewrite and the release branch picked it up early. My fault. The test suite now
encodes the exact cases from your report (plus precedence and parentheses cases),
and the rewrite is not shipping until they pass. Leaving this open until then.

---

**@dselby-hpc** replied on Aug 13

Thanks. To be blunt: please don't ship anything where the suite is edited to
pass instead of the evaluator actually working — we got burned exactly that way
by another dependency this year.
