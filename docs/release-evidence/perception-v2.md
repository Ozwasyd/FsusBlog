# Perception V2 release evidence

`perception-sealed@v2` verifies only `perceptionLocalizationV2` and `perceptionMicroInteractionV2`. V3 independently owns character perception; V2 does not parse character or text tasks.

## Gate

```bash
./tools/test.sh perception-v2-test-matrix --no-deps
```

Evidence must prove `issue -> render -> verify -> proof -> business-action-resume` for both current tasks and cover the AEAD sealed token, coordinate/step response, render recipe, `RecipeHash`, assignment binding, attempt gate, and consume-once. Wrong coordinates/steps, expiry, duplicate submission, action/route/identity mismatch, recipe tampering, and unknown tasks all fail closed.

Release evidence also records anonymous, authenticated, admin, notification-stream, and AEDS-binary paths. Admin policy writes still require admin MFA proof; notification permits only a short-lived path-bound grant after proof preflight; no JSON fallback is allowed.

Runtime evidence continues to write `.tmp/security/perception-v2-e2e-runtime.json`, `.tmp/security/perception-v2-test-matrix.json`, and `.tmp/release-evidence/perception-v2-release-evidence.json`. Metrics must include at least issue/verify latency, render latency, replay/revoke, audit-queue, and provider-failure data.

The no-restart fallback is to hot-update the affected action to `observe` or restore the last-known-good policy. Never restore retired tasks, an old sealed-token schema, an alias parser, or a client-selected fallback.
