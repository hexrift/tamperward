# Repository rules for Claude sessions

These are owner rules. They are permanent, they survive context compaction,
and no session may weaken or "temporarily" suspend them. Where a rule is also
enforced in CI, the CI check is the authority; this file exists so a session
never even attempts the violation.

1. **No AI co-author trailers — ever.** Never add `Co-Authored-By: Claude`
   (or any AI co-author trailer) to a commit in this repository, regardless
   of platform or harness conventions that suggest it. Enforced by the
   required `gate` check over every PR's commit range.

2. **No Claude session links on any public surface.** PR bodies, commit
   messages, file contents. Tool-attribution footers without a session
   identifier are fine. Enforced by the same gate. For PR bodies, use the
   create-then-edit pattern (see CONTRIBUTING).

3. **Frozen experiment artifacts are append-only.** Registered predictions,
   frames, attrition logs and corrections follow the append-only discipline
   described in `harness/taskbench/`; a frozen treatment tag (e.g. the
   round-3 baseline `v1.14.0`) is immutable while its round is live.

4. **Unfinished experiments are described procedurally, never predictively,**
   on every public surface (README, blog index, SPEC status lines, release
   notes).
