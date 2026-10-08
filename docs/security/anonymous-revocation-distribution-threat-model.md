# Anonymous revocation distribution threat model

## Boundary

The origin publishes one public, immutable full snapshot and optional delta for
an attested `(epoch, version, revocationRoot)`. Every browser fetches the same
URL without credentials or a request body. The target revocation handle exists
only in the browser privacy worker while it derives the non-membership witness.
Root metadata carries typed snapshot/delta coordinates, including an exact delta
base, rather than a URL. The decoder binds every coordinate to the current root
and rejects extra URL/path fields before the generated route builder runs.

## Threats and controls

| Threat | Fail-closed control |
| --- | --- |
| Handle correlation at origin/CDN | No credential input exists in URL, query, header or body; two credentials have the same transcript shape and response bytes. |
| Artifact tamper | Worker recomputes canonical SHA-256 content hash, public hash-binding and sparse-Merkle root. |
| Rollback or fork | Root-attested epoch/version/root pins the artifact; cached version may only advance by an exact delta base. |
| Stale artifact | `expiresAtUnixMs` must be in the future and root metadata must still match. |
| Old endpoint revival | `/revocation-witness` is a body-independent 410 tombstone; frames 186/187 are retired and have no DTO/codec. |
| Browser resource exhaustion | Dynamic 1-4 MiB download and 2-4 s worker CPU budgets abort locally; there is no credential-specific network fallback. |
| Secret leakage | Handle transfer is zeroized in the worker; worker errors are sanitized and no logging/telemetry call receives handle, entries or witness. |

The artifact contains public revoked hashes but no account mapping, credential
commitment, credential leaf, subject, cookie, session, IP or device identifier.
