# Ordinary-account session authentication context

This document defines ordinary-account `UserSession` login provenance, authentication freshness, step-up proof, Cookie duration, and session-list privacy. The independent admin principal/session plane does not reuse these fields or proofs. See the [security model](../security.md) and [Refresh Token lineage](refresh-token-lineage.md) for canonical cross-cutting rules.

## Security invariants

- A Session records how it was initially authenticated, not authorization for every later sensitive action.
- `MfaVerified` and JWT `mfa` are migration/coarse-policy/audit signals only, never sufficient sensitive-operation proof.
- Sensitive actions require a short-lived, one-time proof bound to account, current Session, and action; refresh neither copies, renews, nor reissues it.
- Passkey provenance stores only the internal `passkey_credential` row ID; the raw credential ID never enters JWT, URL, logs, telemetry, or ordinary session lists.
- Write and compare all authentication/step-up times in UTC. Invalid enums, missing auth time/current Session, or database/JWT Session mismatch fail closed.

## Fields and login provenance

The generated sections and controlled prose claims below carry the field list, methods, strengths, and current relations. The design rule is only that a Session records initial provenance and sensitive actions require separate action-bound proof.

## JWT and refresh

Request validation trusts the server-side active Session; JWT is neither a one-time proof nor a credential-secret store. The generated refresh context below is authoritative for exact preserved/omitted fields.

The generated refresh section and directional claims uniquely carry refresh-preservation and prohibition relations; this prose does not duplicate them. See [JWT signing-key rotation](jwt-key-rotation.md) for key lifecycle.

## Action-bound step-up proof

Sensitive operations use action-bound proof. The generated section and directional claims below are the sole authority for exact binding and consume-once relations.

The generated section alone specifies step-up freshness key, default, and range. Audit projections never replace one-time proof-cache state.

## Duration policy and Cookie

Generated sections alone specify duration-mode/Cookie projections and exact idle/absolute enums and durations; no handwritten compatibility table is maintained here.

## Session-list privacy

`GET /api/binary/auth/sessions` returns only the account's active Sessions and the minimum safe-display data:

- public revocation identifier and whether it is the current Session;
- coarse device label;
- creation and last-activity times;
- login method and duration policy;
- Passkey friendly name, only when present.

Never return internal `AuthenticatedCredentialRowId`, raw WebAuthn credential ID, Refresh Token, JWT, proof, raw IP, full User-Agent, exact authenticator/device fingerprint, or cross-site high-entropy identifiers. Missing credential rows/names use a stable low-information fallback, never an internal ID. Displayed auth strength/MFA is not authorization; sensitive actions revalidate the current Session and consume action-bound proof.

## Migration and acceptance boundary

Migration states are not a compatibility copy of current auth enums. Database-migration documentation and executable tests own migration mechanics and runtime acceptance; this authority does not duplicate mappings, exact durations, or an acceptance matrix.

## Current session duration modes

<!-- fsus-doc-claim
claimId: authentication-session-permission.duration-modes
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.duration-modes
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.duration-modes -->
- `browser_session`
- `persistent_30d`
<!-- FSUSBLOG-GENERATED:END auth.session.duration-modes -->

### Generated session, credential, MFA and step-up facts

<!-- fsus-doc-claim
claimId: authentication-session-permission.idle-expiry-policy
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.idle-expiry-policy
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.idle-expiry-policy -->
| Key | Value |
| --- | --- |
| admin | 8 hours |
| browser_session | 7 days |
| persistent_30d | 30 days |
<!-- FSUSBLOG-GENERATED:END auth.session.idle-expiry-policy -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.absolute-expiry-policy
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.absolute-expiry-policy
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.absolute-expiry-policy -->
| Key | Value |
| --- | --- |
| admin | 12 hours |
| browser_session | 30 days |
| persistent_30d | 90 days |
<!-- FSUSBLOG-GENERATED:END auth.session.absolute-expiry-policy -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.refresh-context-table
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.session.refresh-context
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.session.refresh-context -->
| Key | Value |
| --- | --- |
| doesNotPreserve | ["access_token","last_step_up_at","last_step_up_method","refresh_token","step_up_proof"] |
| mayUpdate | ["idle_expires_at","last_seen_at","refresh_generation","refresh_token_hash","session_mode"] |
| preserves | ["auth_method","auth_strength","auth_time","authenticated_credential_row_id","duration_policy"] |
<!-- FSUSBLOG-GENERATED:END auth.session.refresh-context -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.step-up-freshness
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.step-up.freshness
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.step-up.freshness -->
| Key | Value |
| --- | --- |
| configurationKey | Security:StepUp:FreshnessMinutes |
| default | 5 minutes |
| maximum | 15 minutes |
| minimum | 1 minutes |
<!-- FSUSBLOG-GENERATED:END auth.step-up.freshness -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.step-up-binding-table
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.step-up.binding
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.step-up.binding -->
- `account`
- `account_subject`
- `action`
- `expiry`
- `session`
- `token`
<!-- FSUSBLOG-GENERATED:END auth.step-up.binding -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.passkey-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.passkey.states
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.passkey.states -->
| Key | Value |
| --- | --- |
| credentialPresence | ["absent","present"] |
| enrollment | ["cancelled","completed","completing","expired","pending"] |
<!-- FSUSBLOG-GENERATED:END auth.passkey.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.mfa-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.mfa.states
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.mfa.states -->
- `disabled`
- `enabled`
- `pending_enrollment`
<!-- FSUSBLOG-GENERATED:END auth.mfa.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.recovery-states
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.recovery.states
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.recovery.states -->
- `active`
- `revoked`
- `used`
<!-- FSUSBLOG-GENERATED:END auth.recovery.states -->

<!-- fsus-doc-claim
claimId: authentication-session-permission.credential-session-revocation
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.credential-session-revocation
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.credential-session-revocation -->
| Key | Value |
| --- | --- |
| failureModes | ["admin_principal_disabled","authentication_context_mismatch","refresh_token_replay","session_absolute_expired","session_idle_expired","session_mismatch","session_revoked","step_up_proof_consumed","step_up_proof_invalid"] |
| transitions | {"account_ban":{"effect":"refresh_reissues_restricted","from":"session_mode_normal","to":"session_mode_restricted"},"account_delete":{"effect":"mode_revoked","from":"sessions_active","to":"sessions_revoked"},"admin_principal_disable":{"effect":"login_and_step_up_denied","from":"principal_active","to":"principal_disabled"},"passkey_counter_risk":{"effect":"revoke_sessions_bound_to_credential","from":"credential_present","to":"credential_present"},"passkey_delete":{"effect":"revoke_sessions_bound_to_credential","from":"credential_present","to":"credential_absent"},"recovery_key_verify_with_session_revoke":{"effect":"optional_passkey_revoke","from":"sessions_active","to":"sessions_revoked"},"refresh_token_replay":{"effect":"compromise_refresh_family","from":"family_active","to":"family_revoked"},"session_logout_or_revoke":{"effect":"publish_revocation_snapshot","from":"session_active","to":"session_revoked"}} |
<!-- FSUSBLOG-GENERATED:END auth.credential-session-revocation -->

### Verified directional authentication relations

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.mfa-enabled-step-up-method
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.mfaEnabledStepUpMethod
render: relation-subject-predicate-object
-->

`auth.relation.mfa-enabled-step-up-method`: `auth.mfa.state.enabled` conditionally `permits-proof-method` `auth.step-up.mfa-proof` when `account is active and the requested credential mutation accepts the MFA proof method`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-auth-strength
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyAuthStrength
render: relation-subject-predicate-object
-->

`auth.relation.passkey-auth-strength`: `auth.method.passkey` `results-in` `webauthn_uv` when `successful user-verifying Passkey assertion`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-is-not-totp
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyIsNotTotp
render: relation-subject-predicate-object
-->

`auth.relation.passkey-is-not-totp`: `auth.method.passkey` does not `is-equivalent-to` `auth.method.totp` for `all authentication and step-up scopes`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.recovery-auth-strength
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.recoveryAuthStrength
render: relation-subject-predicate-object
-->

`auth.relation.recovery-auth-strength`: `auth.method.recovery_key` `results-in` `auth.strength.recovery` after `successful Recovery Key login completion`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.recovery-does-not-mint-step-up
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.recoveryDoesNotMintStepUp
render: relation-subject-predicate-object
-->

`auth.relation.recovery-does-not-mint-step-up`: `auth.recovery.completion` does not `mints` `auth.step-up.proof` for `successful Recovery Key login completion without a separate step-up flow`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.step-up-binding
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.stepUpBinding
render: relation-subject-predicate-object
-->

`auth.relation.step-up-binding`: `auth.step-up.proof` `is-bound-to` `account+session+action+token+expiry` during `proof validation and consumption`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.step-up-consume-once
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.stepUpConsumeOnce
render: relation-subject-predicate-object
-->

`auth.relation.step-up-consume-once`: `auth.step-up.proof` `may-be-consumed` `exactly-once` when `matching account, session, action, token, and unexpired proof`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.refresh-preserves-auth-context
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.refreshPreservesAuthContext
render: relation-subject-predicate-object
-->

`auth.relation.refresh-preserves-auth-context`: `auth.refresh.rotation` `preserves` `auth_method+auth_strength+auth_time+duration_policy+authenticated_credential_row_id` when `active session context passes fail-closed validation`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.refresh-does-not-rebuild-step-up
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.refreshDoesNotRebuildStepUp
render: relation-subject-predicate-object
-->

`auth.relation.refresh-does-not-rebuild-step-up`: `auth.refresh.rotation` does not `rebuilds-or-extends` `auth.step-up.proof` for `all refresh rotations`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-delete-revokes-bound-sessions
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyDeleteRevokesBoundSessions
render: relation-subject-predicate-object
-->

`auth.relation.passkey-delete-revokes-bound-sessions`: `auth.passkey.credential-delete` `revokes` `sessions-bound-to-deleted-credential` when `credential row is deleted successfully`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.

<!-- fsus-doc-claim
claimId: authentication-session-permission.relation.passkey-delete-does-not-revoke-unbound-sessions
behaviorId: authentication-session-permission
claimType: binary-relation
factPath: facts.authRelationClaims.passkeyDeleteDoesNotRevokeUnboundSessions
render: relation-subject-predicate-object
-->

`auth.relation.passkey-delete-does-not-revoke-unbound-sessions`: `auth.passkey.credential-delete` does not `revokes` `all-account-sessions` when `credential row is deleted successfully`; scope: `current-account`, `bound-session`, `declared-action`, `declared-subject`.
