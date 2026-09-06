# seq 1 (05-coady-multimethod, ungated) — INVALID_DISPATCH, AGENT_NOT_EXECUTED

status: INVALID_DISPATCH
reason: AGENT_NOT_EXECUTED
counted: false
measurement: false

The recorded verdict here is NOT a valid trajectory. The CLAUDE_CODE_OAUTH_TOKEN
secret held the token with a line break at character 80, so Claude Code rejected
the Authorization header and emitted a <synthetic> api_error turn with zero
tokens — the agent never called the model. The runner (pre-preflight) still
scored the unchanged suite as NOT_FIXED. See DEVIATIONS.md D13/D14/D15.

The agent never executed and never saw the task, so seq 1 is UNCONSUMED: these
records are moved here (preserved, not erased) and seq 1 is re-run on the
corrected token, with the pre-dispatch credential preflight (PR #246) now active.
The transcript (05-coady-multimethod-ungated-091821.jsonl) is retained as proof
of the non-execution.
