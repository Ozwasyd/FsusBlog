# Private request generations

`PrivateRequestRuntime` assigns every private frontend request a generation lease. A generation is a monotonic in-memory number: it contains no account, admin, Cookie, permission, or session identifier and is never written to a URL, storage, telemetry, or `BroadcastChannel`.

## Boundaries

`account` covers account APIs and optional-auth reads that may carry an account-specific projection; `admin` covers independent administrator-session APIs; `public` covers anonymous reads, which do not register identity-switch aborts and are unaffected by generation changes.

Generated binary routes derive scope from the authoritative route descriptor's `auth` field. Legacy `binaryUrl` calls must declare `privateScope`; private APIs using direct `fetch` or `binaryRequest` must use `runPrivateRequest`. A promise resolves only while its response generation equals the current generation, so Pinia, composables, and direct callers share one commit barrier. Logout, session expiry, and account switch advance account generation and abort registered requests; admin logout/session change advances only admin generation. Optional-auth public transport is not forcibly aborted, but a previous-identity projection is discarded before commit.

## Risk and no-restart rollback

This mechanism does not change server Sessions, Cookies, AEDS frames, or API responses. Stale responses exit with `AbortError`, which existing composable abort branches may safely ignore. Rollback is a frontend static-asset rollback and needs no backend restart; server authorization remains final. Separate account and admin generations prevent account logout from needlessly cancelling valid admin requests.
