# RiskControl production tracking plan

RiskControl consolidates all risk signals, decisions, challenges, proofs, enforcement, audit, and admin policy. The current perception challenge surface contains only `perceptionCharacterV3`, `perceptionLocalizationV2`, and `perceptionMicroInteractionV2`; V2 serves Localization and Micro-interaction only, not character or text tasks. All providers share `SecurityChallengeEnvelope`, `SecurityChallengeAssignment`, and the one-time proof contract.

## Production architecture

```text
Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy
```

- Endpoints declare the action and route key through `WithRiskAction(...)`; business handlers do not select challenges.
- `SecurityChallengeOrchestrator` issues assignments only from registered providers in server-policy order; a missing provider, invalid kind, persistence failure, or proof-mint failure fails closed.
- `SecurityChallengeEnvelope` is the authoritative ordered set of required members. Clients must not reorder, delete, replace, or self-degrade members.
- After provider verification succeeds, only the unified `X-Fsus-Challenge-Proof` is minted; a business filter consumes it once and verifies action, route, subject, IP, device, kind, policy version, and expiry bindings.
- Browser proofs remain in process memory and never enter URLs, Web Storage, BroadcastChannel, logs, or reconnect state.

## Current challenge policy

V3 is the sole current implementation for character-perception challenges. LocalizationV2 and MicroInteractionV2 continue to use `fsu.challenge/perception-sealed@v2`, an AEAD sealed token, coordinate/step responses, a render recipe, and `RecipeHash`. The public payload omits the expected answer, coordinates, steps, and semantic labels; after unsealing, the server verifies assignment, recipe, action, route, subject, IP, device, and policy bindings, then applies the Redis attempt gate and consume-once.

Policy references only kinds present in the current manifest and provider-ready. When a client reports insufficient capability, it may return only a low-cardinality reason and the original assignment binding; the server rereads current policy, revokes the old assignment, and issues another policy-allowed member or rejects. Clients cannot choose a substitute kind.

## Rollout and rollback

Production progresses through `observe -> enforce -> strict` while retaining `disabled` and incident-only `lockdown`. A no-restart rollback uses the admin binary policy API to switch affected actions to `observe` or restores the last-known-good snapshot; never roll back by restoring retired providers, an alias parser, a JSON fallback, or weakly bound proofs.

Every stage must cover:

- Anonymous requests: challenge/proof binding for public reads, anonymous comments, and notification preflight.
- Authenticated requests: Passkey, recovery, and authenticated comments cannot bypass current policy.
- Admin requests: policy writes still require the admin principal, `system.config`, and `X-Fsus-Mfa-Proof`.
- Notification stream: use only a path-bound short-lived grant; reconnects must not reuse proofs.
- Binary: issue, verify, envelope, proof, and business resumption use AEDS throughout; unknown or retired numeric kinds fail closed.

After each switch, record the active policy version, readiness, issue/verify/replay/revoke metrics, 428/429 rates, Redis/PostgreSQL error rates, and rollback-drill results. See [RiskControl production rollout gates](risk-control-rollout.md) for operations.
