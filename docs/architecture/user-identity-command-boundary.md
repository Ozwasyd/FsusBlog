# User identity command boundary

`UserProfileCommandService` owns public-handle changes and self-service account
retirement. It now executes those commands directly instead of forwarding them
to `UserService`:

```text
IUserProfileCommandService
  -> sys_user identity mutation
  -> credential and session retirement transaction
  -> session-validation publication
  -> blacklist and account-snapshot invalidation
```

Account retirement keeps session revocation, credential tombstoning, identity
reset, MFA clearing, and validation-cache publication in one transaction. A
failed transaction performs best-effort cleanup of any pre-commit validation
snapshots and remains fail closed.

Endpoint and response contracts are unchanged. The legacy `IUserAuthService`
no longer exposes account deletion; callers use the dedicated profile command
port. Cache and blacklist failures retain the existing operational rollback
behavior.
