# Superseded pre-counted-frame artefact

`walk.pre-final-burn.json` is the earlier `pools/counted/walk.json` (built 2026-09-05, on the
500-base frame, before the sacrificial pilot completed). It is preserved, not deleted: it predates
the FINAL 901-repo `pilot_dedup` and the extended counted frame, so it was superseded rather than
edited. The active counted frame is `../walk.json`, derived deterministically from
`frame/walk-order-ext.json` minus the final `pilot_dedup` (see its `audit` block). The Sep-5
`counted-s0` shard was a stale slice of this superseded walk and was removed.
