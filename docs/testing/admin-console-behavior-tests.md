# Admin-console behavior-test boundary

Admin-console evidence is observable behavior, never C#, TypeScript, Vue, router, or documentation string matching. The [testing strategy](../testing.md) owns the matrix; browser acceptance follows the [browser contract](browser-contract.md).

## Backend boundary

- Read route existence, HTTP method, `admin_permission`, and `fixed_ip` limits from live `EndpointDataSource` metadata.
- `TestServer` verifies authorization/high-risk operations: ordinary or under-authorized principals get `403`; missing/invalid Admin step-up proofs get `428`; only a valid consumed proof reaches mutation.
- The anonymous-account list uses real DTO JSON plus AEDS round trip and a fixed public field set; it excludes `LastLoginIp`, passwords, private keys, sessions, devices, and internal failure details.
- PostgreSQL tag deletion blocks on an `article_tag` reference and leaves tag/relation rows unchanged; the endpoint never detaches article tags silently.
- PostgreSQL service tests cover Integrity retry `failed -> retrying` and clearing its internal failure summary; endpoint tests cover permission, origin, and one-time step-up proofs.
- Service and `TestServer` jointly cover moderation reload, rollback, and runtime-state changes; success writes a high-value audit and invalidates comment cache.

## Frontend boundary

- API unit tests check URL, method, AEDS request/response frames, mutation parameters, and `X-Fsus-Mfa-Proof`, not function source.
- Integrity-console components cover success-empty, load-error, and proof-retry states: obtain Admin step-up proof, send the selected proof ID, then refresh.
- Router/persistent-navigation tests own permission visibility and unauthorized redirects; browser acceptance owns module navigation, primary actions, empty states, and recovery.
- The retired username/password path is guarded by the real route surface, application-port reflection, and residue governance; frontend mutations send only anonymous `accountId`.

## Failure and recovery

Read failures preserve the page shell and become retryable without exposing internal details. Shared errors present high-risk mutation `403`, `428`, `409`, and service failures. A new step-up ceremony permits retry; an old proof never is.

## Ownership

Units own DTO, AEDS, service-state, and frontend interaction; PostgreSQL owns real persistence side effects; `TestServer` owns the endpoint pipeline; browser acceptance owns the complete visibility-to-result path. The test matrix closes coverage, mutation, retention, and release evidence.
