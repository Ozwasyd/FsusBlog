# Passkey metadata and PasskeyEnabled projection

This document defines the security boundary for ordinary-account Passkey assertion metadata and `sys_user.passkey_enabled`. The WebAuthn credential set is the physical source of truth; the Boolean projection only reduces common account-snapshot query cost.

## Assertion metadata

Login and ordinary-account step-up both parse authenticator data after successful FIDO verification and use the same `PasskeyService` CAS update:

| Value | Source | Persistence rule |
| --- | --- | --- |
| `SignCount` | verified assertion | Advance only after comparing the original counter and PostgreSQL `xmin` rowVersion. |
| `LastUsedAt` | server UTC time | Update only with a successful CAS. |
| `BackupEligible` | authenticator-data BE flag | Update in the same SQL statement as counter/LastUsedAt. |
| `BackupState` | authenticator-data BS flag | Update in the same SQL statement as counter/LastUsedAt; it may change in either direction. |
| flags snapshot version | server constant `1` | Identifies the current BE/BS parsing semantics; it is not persisted as identity, authorization, or a device fingerprint. |

After CAS failure, re-read counter and rowVersion. If the database already reached the current assertion's counter or higher, an older assertion may not write BE/BS; if advancement is still needed, retry one complete metadata CAS only. If it cannot converge, return `credential_metadata_conflict` and do not create a login Session. BE/BS changes are not compromise signals and do not revoke existing Sessions.

`PasskeyMetadata:AssertionUpdateMode` defaults to full updates. If Fido2NetLib flag parsing or database compatibility fails, hot-update a reload-capable source to `counter_only`; the next request still updates counter and LastUsedAt but freezes BE/BS temporarily without disabling signature validation, counter checks, or CAS. Remove the override after repair to restore full updates without a restart.

## PasskeyEnabled source of truth

The invariant is:

```text
EXISTS(passkey_credential WHERE account_id = sys_user.id)
    == sys_user.passkey_enabled
```

Registration inserts the credential and `PasskeyEnabled=true` in one transaction. Recovery Key binding likewise inserts the credential, revokes old credentials per policy, and sets the projection true in one transaction. Credential deletion uses a row-lock transaction and sets the projection from the remaining fact set. Account deletion removes all credentials and zeros the projection in one transaction. Business authorization, WebAuthn allow-lists, and recovery decisions continue to read the credential facts, never the Boolean alone.

After schema compatibility and the account-subject invariant, startup runs `passkeyProjectionInvariant`. Drift records only a count and fixed reason `credential_fact_mismatch`, never account ID, credential ID, public key, user handle, or authenticator data, and blocks later bootstrap tasks.

## Offline check and repair

Run the read-only check with the same secret/env-file inputs as the backend:

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj -- passkey-projection --check --env-file /run/secrets/fsusblog.env
```

The check output contains only `status`, mode, and counts. After drift is found, stop concurrent schema/manual mutations or use a controlled maintenance window before running:

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj -- passkey-projection --repair --confirm-repair --env-file /run/secrets/fsusblog.env
```

Repair rebuilds the Boolean only from credential `EXISTS`. It increments each affected account's `AccountSnapshotVersion` before the database transaction commits; Redis-invalidation failure rolls back the database mutation, while an already-successful extra version bump is safe. Output and logs still contain counts only, not the repaired-account list.

## Credential list and recovery hint

The existing Passkey credential list returns only internal management row ID, friendly name, creation/last-use times, AAGUID category, and BE/BS; it does not return the WebAuthn credential ID, public key, user handle, or raw authenticator flags. The internal row ID is only for authenticated rename/delete routes and is not a WebAuthn identifier.

IdentityCenter derives a recovery hint only from credential count, `BackupEligible`, and account `recoveryEnabled`: it suggests a second Passkey or Recovery Key only when there is one non-backupable credential and no Recovery Key; it does not repeat the hint when multiple or backupable credentials or a Recovery Key exist. The hint is local derived display, does not block login, and uploads no new data. Marking the credential that created the current Session waits for a trusted Session-provenance contract; do not substitute AAGUID, User-Agent, IP, or a guessed device fingerprint.

## Risk and rollback

- Metadata CAS failure rejects the assertion and never creates a “Session created but metadata not committed” partial-authentication state; `counter_only` is the no-restart flags-update degradation, never a blind update.
- Repair failure retains the old projection and returns non-zero while a subsequent check still exposes drift. For emergency startup-gate rollback, keep traffic on the previous slot, run offline repair, then re-enable the candidate; never make business code trust only `PasskeyEnabled`.
