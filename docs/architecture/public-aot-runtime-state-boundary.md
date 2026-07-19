# Public AOT runtime state boundary

`IPublicAotRuntimeState` is the single owner of request-visible render state and SSR health state:

```text
PublicAotShellService
  -> IPublicAotRuntimeState
       -> PublicAotSsrRuntimeState
```

The module projects source, renderer version, backfill status, render state, and asset mode into `HttpContext.Items`. It also classifies and records backfill failures, records successful backfills, and clears route quarantines during invalidation. It never calls back into the shell.

`PublicAotShellService` retains only use-case sequencing and logging. Header values, state names, failure classes, circuit/quarantine behavior, and invalidation ordering remain unchanged.

The module is singleton-scoped like its underlying SSR state. Rollback requires no endpoint, cache, database, or AEDS migration.
