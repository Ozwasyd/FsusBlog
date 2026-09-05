# Recovery Passkey completion consistency

This document defines how a short-lived recovery session safely completes Passkey rebinding after a Recovery Key has been verified once. It supplements [security.md](security.md) and [API design philosophy](api/design.md); it adds no endpoint, AEDS frame, or text fallback.

## State and persistence boundary

The unified cache stores these recovery-session states:

| State | Meaning | Allowed next action |
| ------ | ------ | ---------------- |
| `pending` | Completion has not started, or the previous attempt failed safely | Atomically claim as `completing` |
| `completing` | A normalized request hash holds a 90-second short lease | Same and different concurrent requests return an explicit conflict; after lease expiry it may recover to `pending` |
| `completed` | The database completed the logical commit | Accept only idempotent success for the same request after the database durable marker confirms it |

State transitions use `IUnifiedCache.TrySetStringIfValueAsync` compare-and-set, never a non-atomic read-then-write overwrite. The old four-field recovery-session payload is still read as `pending`, so short-lived sessions issued during a rolling release can continue; new payloads use a versioned state envelope.

The raw recovery-session token exists only within the request. The database stores only its full SHA-256 `recovery_session_hash`, with a unique index limiting one logical completion per recovery session; it also stores the SHA-256 `recovery_request_hash` of the normalized AEDS bytes for `PasskeyRegisterCompleteRequest`. The same token plus the same request may return idempotent success; the same token plus a different request returns `RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST`.

## Commit order

1. Query the durable marker in the database. On the same request, clean the cache and return idempotent success; on a different request, reject.
2. Use compare-and-set to claim a valid `pending` session as `completing` with request hash, lease id, and expiry.
3. Read the registration challenge and validate the WebAuthn authenticator; on failure, restore the exact lease to `pending`.
4. In one database transaction, insert the new credential with its durable marker, revoke old credentials according to recovery-session options, and set `PasskeyEnabled` to `true` for a non-deleted account.
5. After commit, advance `AccountSnapshotVersion`, delete the Passkey registration challenge, then try to mark the cached session `completed`.

Any write failure in step 4 rolls back the whole transaction. A step-5 failure does not duplicate the credential: the current request returns a retryable result and releases the recovery session; the next same request first hits the durable marker, then repeats the idempotent version advance and challenge deletion. Advancing the version once more only expires old snapshots sooner; it cannot restore old account state.

## Concurrency, failure, and response loss

| Scenario | Server result | Retryability |
| ------ | ------------ | ---------- |
| Authenticator validation fails | No credential is written and no challenge is deleted; restore `pending` | Retry completion with the same recovery session |
| Database error/transaction rollback | Credential, old-credential revocation, and Passkey flag do not commit; restore `pending` | Retry with the same recovery session |
| Double submission for one session | Only the compare-and-set winner writes; the database unique index is the second guard | At most one logical completion |
| DB committed but HTTP response was lost | Retry identifies the same request from the durable marker | Idempotent success with no duplicate write |
| A different request is submitted after completion | Durable request hash does not match | Return an explicit conflict |
| Worker aborts while `completing` | Recover `pending` after the short lease expires | No need to use the Recovery Key again |

## Migration and rollback

`20260711-post-recovery-passkey-completion-idempotency` adds nullable `recovery_session_hash` and `recovery_request_hash` columns to `passkey_credential`, plus a unique index on non-null recovery session hashes. Nullable columns leave old credentials unchanged, and the migration is repeatable.

There is no runtime downgrade switch because disabling the durable marker would reintroduce duplicate binding. For no-restart containment, first use an external gateway with dynamic routing to pause new `/api/binary/auth/recovery-key/verify` requests, avoiding further Recovery Key consumption while retaining the complete entry to drain issued short-lived sessions; this repository provides no such hot switch. If the complete entry itself must be isolated, reject verify/complete together after the drain window while retaining Redis sessions and database markers. After restoring the entry, the same request can be replayed. A code rollback must retain the new columns and unique index and roll the application back only after all short-lived recovery sessions expire; never delete the marker or return to “consume the session before writing.”

## Acceptance coverage

Directed test code covers authenticator failure, database provider exception, transaction rollback, response loss, double-submit, successful replay, different-request conflict, expired `pending`, successful retry after an expired `completing` lease, and old-envelope compatibility. The mapped binary complete endpoint directly executes `RouteEndpoint.RequestDelegate` and decodes successful `EmptySuccess`, concurrent conflict, and retryable-failure `ApiError`; PostgreSQL integration starts with the raw recovery token, enters `RecoveryKeyService`, independently computes the SHA-256 session marker and canonical AEDS request hash, and compares them byte-for-byte with the durable credential row. Unified verification must still actually run these tests; this phase does not claim they have run:

| Entry | Expected |
| ------ | ------ |
| Anonymous recovery binary begin/complete | Recovery session remains available; success remains AEDS `EmptySuccess` and errors remain AEDS `ApiError` |
| Ordinary login request | Existing Passkey register/login and step-up semantics are unchanged |
| Admin request | The independent admin principal and admin Passkey flow do not enter the recovery-session state machine |
| Notification stream | No frame, authentication, or session protocol changes; account-snapshot invalidation does not change the stream contract |
| Binary contract | Reuses existing `PasskeyRegisterCompleteRequest` and `EmptySuccess`; no fields are added or reordered |

All three former static gaps now have direct test code:
`ExpiredCompletingLease_RecoversPendingAndCompletesSameRequestRetry`,
the mapped-endpoint frame matrix in `RecoveryPasskeyCompletionEndpointTests`, and
`RawRecoveryToken_FlowsThroughCompletionAsSha256AndCanonicalRequestHashOnly`.
These acceptance projections are landed but not yet executed; mark them passed only after unified verification produces real success results.
