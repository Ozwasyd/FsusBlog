# Temporal source observation ingress

`validateTemporalSourceObservation({ kind, context, observation }, authority)`
checks complete actual source observations before a temporal CLI reports success.
It consumes `createTemporalContract` from the existing pure temporal owner, with
the explicit policy and immutable ledger supplied by the caller. It performs no
filesystem reads, clock observation, receipt creation or qualification sealing.

| Kind | Required actual fields |
| --- | --- |
| backend | businessEpochUtc, backendCulture, postgresTimezone |
| node | businessEpochUtc, timezone, locale, nodeTimezone, monotonicClockSource |
| postgres | businessEpochUtc, timezone |
| browser | businessEpochUtc, browserBusinessEpochUtc, timezoneId, locale, backendCulture, postgresTimezone, nodeTimezone |

The transport matches the existing verifier and Node child handshake. Browser
`timezoneId` and `locale` map to `timezone` and `uiLocale`; PostgreSQL `timezone`
maps to `postgresTimezone`. Explicit conflicting aliases are rejected before
normalization. Browser transport establishes the existing `browser-runtime`
validation boundary; an explicitly different boundary is rejected. Every required
field comes from the actual observation. Optional actual fields and original
evidence are retained and checked by the shared contract where registered.
No missing values are filled from the planned context.

The result is a frozen validated observation, not a receipt or proof that a
process, browser or database was actually executed. The existing owner remains
responsible for authenticated collection, source/run/producer binding, real
clock operation and independent replay. Caller-supplied observations cannot
grant runtime acceptance through this function.

The existing `tools/test/verify-temporal-producers.mjs` command uses this API
for every observation kind after loading the context and observation JSON:

```javascript
validateTemporalSourceObservation({ kind, context, observation }, readTemporalReplayAuthority());
```

The command retains its existing catalog branch, error reporting and command
output. Only the per-kind observation dispatch uses this complete-ingress call;
there is no parallel runtime collector and the shared pure validator retains its
partial-observation API. Canonical matrix registration belongs to its current
owner. Actual command controls cover complete, empty and drifting observations
for each kind, malformed JSON, unsupported kinds and catalog verification.
Native, database, browser, complete matrix and product acceptance remain
independent of these source and command-ingress controls.
