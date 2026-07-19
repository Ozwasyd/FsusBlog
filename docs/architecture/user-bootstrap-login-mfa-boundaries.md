# User bootstrap, login, and MFA boundaries

Anonymous-account creation and login-session creation are independent runtime
boundaries. `AnonymousAccountBootstrapService` owns anonymous identity
normalization and the account-creation transaction. `UserLoginWorkflowService`
owns login eligibility, replacement-session fencing, token issuance, and the
new-session transaction. Neither service calls back into `UserService`.

```text
IAnonymousAccountBootstrapService
  -> anonymous account insert and physical subject projection

IUserLoginWorkflowService
  -> account lookup and login restrictions
  -> replacement-session transaction and validation-cache publication
  -> access and refresh token issuance

IUserMfaCommandService / IUserMfaVerificationService
  -> UserService MFA state machine
```

`UserService` is now scoped to the MFA state machine. The command and
verification ports deliberately resolve to the same scoped instance so setup,
verification, recovery-code consumption, and administrative reset share one
owner without a forwarding facade. The Core account read path uses
`IUserAccountReader`; it no longer re-enters `UserService`. The unused aggregate
`IUserAuthService` contract was removed after all runtime consumers moved to
these narrow ports.

Endpoint, response, cookie, and binary-frame contracts are unchanged. Login
transaction failure remains fail closed. If a transaction rolls back after a
pre-commit revocation fence was published, the login service performs the
existing best-effort fence invalidation without authorizing a revoked session.
