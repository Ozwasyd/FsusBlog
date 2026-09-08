# Passkey signature-counter risk response

This document defines the WebAuthn `signCount` state machine shared by ordinary-account Passkey login and step-up. It handles only counter results after signature, challenge, RP ID, and UP/UV verification; it does not change FIDO validation, Cookie, JWT, or independent admin-principal boundaries.

## State machine

| Stored | Actual | Outcome | Behavior |
| ------ | ------ | ------- | ---- |
| `0` | `0` | `Unsupported` | Accept the assertion; keep the counter at `0` and update `LastUsedAt`. |
| Any non-negative value | `> stored` | `Advanced` | Advance the counter and `LastUsedAt` through signCount + rowVersion CAS. |
| At least one side non-zero | `<= stored` | `Risk` | Reject the assertion, record a high-value non-monotonic event, and apply the configured response. |
| CAS fails after verification | Any | `ConcurrentConflict` | Re-read counter/rowVersion; accept if concurrency already advanced it, otherwise retry CAS at most once. |

`InvalidSignCount` may enter `Unsupported` only when authenticator data also gives `0 -> 0`. Other `InvalidSignCount` values and verified non-monotonic values enter `Risk`; an ordinarily invalid signature remains an ordinary assertion failure. No path may describe a risk signal as a confirmed credential clone.

## Risk-response configuration

`PasskeyCounterRisk:ResponseAction` is read per request and can be changed through a reload-capable source without a restart:

- `reject_credential`: default. Reject this anomalous credential assertion, retain existing Sessions, and do not send `SessionRevoked`.
- `revoke_account_sessions`: enable only with existing account-level compromise evidence and manual policy approval. Revoke all active Sessions for the account, update the account snapshot generation, and send a de-identified revocation notification.
- Missing, misspelled, or unknown values safely fall back to `reject_credential`; they must not implicitly expand to account-wide revocation.

The current Session schema does not persist the login credential source, so the default policy cannot claim to revoke only “Sessions created by this credential.” Until provenance is implemented, credential-only rejection avoids affecting unrelated devices; do not substitute guessed device fingerprints, User-Agent, or IP for credential provenance.

## Observability and privacy

Low-cardinality security telemetry records `counter_unsupported`, `counter_advanced`, `counter_non_monotonic`, `counter_concurrent_conflict`, and a final action: `counter_unchanged`, `counter_updated`, `accepted_after_reload`, `counter_retry_updated`, `reject_credential`, `revoke_account_sessions`, or `assertion_rejected`.

Logs may contain only the account subject hash, flow, anomaly type, and fixed action category. Never record the raw credential ID, challenge, authenticator data, signature, Session ID, or token. Audit may use the internal credential row ID as a protected target reference, but event text must say “non-monotonic counter risk,” never “confirmed clone.”

## Failure and rollback

- A Risk response still rejects the assertion on any side-effect failure. Under default `reject_credential`, temporary audit/telemetry unavailability does not widen Session impact; under explicit `revoke_account_sessions`, persistent Session-revoke failure fails closed and later notification/cache-invalidation failure does not restore Sessions.
- If false positives or concurrent conflicts rise, hot-update to `reject_credential`; counter checks remain enabled and non-monotonic assertions remain rejected.
- For code rollback, return to the previous serving slot with `reject_credential`; never disable WebAuthn counter validation or restore blind update.

## Verification coverage

`PasskeyServiceTests` lock down `0 -> 0`, `0 -> N`, `N -> N+1`, `N -> 0`, `N -> N`, and `N -> N-1` classifications. `PasskeyCounterRollbackIntegrationTests` cover login, step-up, backup-eligible credentials, default non-revocation, explicit account-level revocation, and response failure. `PasskeySignCountConcurrencyTests` use a PostgreSQL stale rowVersion and two concurrent assertions to verify CAS-conflict rereads without real hardware.
