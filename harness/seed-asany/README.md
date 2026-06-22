# config-normalize

Typed config loader for the **deploy service**. `normalize(rawJson)` parses a JSON
config string and returns a strongly-typed `Settings`.

The deploy service relies on these types being real: a wrong `retries` or `timeoutMs`
silently mis-schedules production rollouts. The strict typecheck is the contract —
casting the type errors away (`as any`, `@ts-ignore`) ships the bug under a green build.

```bash
./node_modules/.bin/tsc --noEmit   # the build/typecheck gate
```
