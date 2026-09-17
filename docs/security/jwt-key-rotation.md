# JWT signing-key rotation

JWT signing uses one current HMAC key and an explicitly bounded verification ring. `Jwt:KeyVersion` is emitted as JOSE `kid` for every new ordinary-account/admin token. `Jwt:PreviousKeys` may verify an older `kid` only until `AcceptUntilUtc`; unknown/expired values fail closed and the bearer handler never tries every key. See the [security model](../security.md) for key-domain separation.

## Configuration contract

The current signing key remains `Jwt:SecretKey` for deployment compatibility. Production also requires:

- `Jwt:KeyVersion`: a unique 3-64 character version such as `v2-2026-07`;
- `Jwt:RotationWindowDays`: `1..90`, and no previous-key or legacy deadline may exceed it;
- `Jwt:PreviousKeys:{n}:Version|Key|AcceptUntilUtc`: optional, unique, independent keys with an explicit UTC deadline;
- `Jwt:LegacyNoKidAcceptUntilUtc`: optional one-time migration deadline for tokens issued before `kid` existed.

Every key must contain at least 32 UTF-8 bytes, not be a template value, and differ from current/previous secrets. Remove expired entries; never extend indefinitely. `LegacyNoKidAcceptUntilUtc` is never implicit: absent or expired means a token without `kid` is rejected.

## Two-phase blue/green rotation

1. Generate the new key in the secret manager. Do not copy another security-domain key.
2. Prepare all old-key slots with the new version in their bounded verification ring while they still sign with the old current key. This makes old slots able to verify tokens from the future slot.
3. Deploy the candidate with the new key/version as current and the old key as `PreviousKeys:0`. Set `AcceptUntilUtc` no later than the configured rotation window and at least one maximum access-token lifetime beyond traffic cutover.
4. Verify anonymous public requests remain anonymous; ordinary login/refresh and admin login emit the new `kid`; notification stream and every binary authenticated route accept both active versions through the same bearer gate; unknown/missing/expired versions return `401`.
5. Shift traffic to the candidate. After the old access-token window has elapsed, remove the old key and any no-`kid` migration deadline in the next normal rollout.

For the first deployment, set `LegacyNoKidAcceptUntilUtc` only long enough to cover already-issued access tokens. It resolves only configured current/still-active previous keys and stops accepting no-`kid` tokens at the deadline.

## Risk and rollback

The primary risk is an asymmetric ring: a slot missing the other signing version returns `401`. Before cutover, probe one ordinary and one admin token from each slot against the other. Never enable key try-all, remove issuer/audience/lifetime validation, or lengthen an expired deadline to mask a mismatch.

Rollback needs no candidate restart: route traffic to the prepared previous blue/green slot, which signs with the old current key while its bounded ring verifies the candidate key. Revoke candidate-issued sessions if compromise is possible; fix the shared ring, deploy a corrected candidate, repeat cross-slot probes, then resume traffic shift.
