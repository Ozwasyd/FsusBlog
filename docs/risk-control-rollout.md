# RiskControl production rollout gates

This document defines the current RiskControl production rollout, incident response, and no-restart rollback boundaries. The perception challenge set contains only `perceptionCharacterV3`, `perceptionLocalizationV2`, and `perceptionMicroInteractionV2`; the latter two share the sealed V2 provider, while V3 alone handles character tasks.

## Runtime controls

Valid modes are fixed: `disabled | observe | enforce | strict | lockdown`. The active `security_policy_snapshot` provides global/action modes, challenge kinds, subsystem modes, and a last-known-good pointer; the admin binary policy API is the only hot-write entry point. Provider configuration and the DI registry must match the capability manifest; unknown kinds and unready providers must not issue.

Default risk bands select only current providers: low-risk requests are allowed; medium-low risk may require `sha256PowV1`; character perception uses `perceptionCharacterV3`; higher risk may combine `perceptionLocalizationV2 + sha256PowV1`; MicroInteractionV2 is used only by an explicitly enabled strict policy, and requests at the block threshold are rejected. PoSpace retains explicit resource gating; insufficient client capability grants no self-degradation right.

## Rollout order

| Stage | Scope | Required gate |
| ---: | --- | --- |
| 1 | global `observe` | readiness, metrics, audit, provider registry, and simulator agree |
| 2 | public-read enforce | anonymous public reads and crawler/preview paths follow policy |
| 3 | auth/recovery enforce | authenticated requests accept only the current challenge/proof; recovery remains no-store |
| 4 | comment enforce | anonymous and authenticated comments run challenge/queue/block before persistence |
| 5 | notification enforce | preflight consumes the proof once; WebSocket consumes only a short-lived grant |
| 6 | admin enforce | admin principal, permissions, and MFA proof cannot be replaced by an ordinary RiskControl proof |
| 7 | selected strict | enable only after prior-stage error budgets are stable |

`lockdown` is incident-only to block anonymous writes; it is not a regular rollout stage.

## Pre-production checklist

- Active policy, last-known-good, provider registry, and capability manifest use the same current kind set.
- Redis supports atomic one-time semantics for envelope, attempt, used, and proof; PostgreSQL challenge/attempt audit is writable.
- The RiskControl check at `/api/ops/health/ready-detail` is ready.
- V3, LocalizationV2, and MicroInteractionV2 issue/verify/replay/tamper tests pass; retired numeric kinds fail closed.
- Anonymous, authenticated, admin, notification-stream, and binary acceptance all pass.
- The browser writes no proof, sealed truth, raw IP/device, or admin session to persistent storage or logs.

## Failure matrix

| Failure | Behavior | Live response |
| --- | --- | --- |
| Redis consume-once unavailable | required challenge fails closed | Switch audited policy to `observe` or restore LKG; do not bypass consume-once |
| PostgreSQL challenge audit unavailable | issue/verify fail closed | Restore the database or enable an LKG that requires no new challenge |
| active policy missing/corrupt | readiness is not ready; only a verified LKG is usable | Restore LKG; do not assemble defaults in an endpoint |
| provider/manifest mismatch | that kind fails closed | Remove the unavailable kind from active policy or switch to `observe` |
| old frontend capability manifest | server returns stable 409; client performs only one normal full-page reload | Before reload, write the current build-version session guard; if the same old build mismatches again, fail closed: no reload loop and no old kind/alias/fallback |
| sealed token/recipe/binding invalid | verify rejects and mints no proof | Repair the key/provider; do not accept an old schema or weak validation |
| proof expired/replayed/mismatched | 428; business handler does not execute | Reissue; do not relax action/route/identity binding |
| invalid notification grant | stream does not upgrade | Rerun preflight; do not reuse the original proof |

## No-restart rollback

Use `/api/binary/admin/security/risk-control/options` to hot-switch affected actions to `observe`, or use the rollback endpoint to restore `LastKnownGoodSnapshotId`. This retains risk scoring, audit, and metrics while stopping new challenge enforcement. After repair, promote again from `observe`. Do not use a restart, retired kind, compatibility alias, text/JSON fallback, client-selected fallback, or proof reuse as rollback.

For every switch, record the policy version, operator, reason, readiness, five-path acceptance samples, issue/verify/replay/revoke metrics, 428/429 rates, and Redis/PostgreSQL error rates.

When the frontend receives `security_challenge_client_capability_incompatible`, it treats it as a static-resource switch signal, not a new challenge type. The client writes its capability-manifest version to a `sessionStorage` guard, then calls `window.location.reload()`; if storage is unavailable, the guard already exists, or the old build is still served after reload, it remains unavailable. This path must not retry issue, map to another kind, restore a retired wire name, or use a JSON/text challenge fallback.
