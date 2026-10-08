# JWT signing-key rotation

Ordinary-account and administrator access tokens use one current HMAC key. `Jwt:KeyVersion` is emitted as JOSE `kid` for every token. Validation requires that exact value and the current signature; missing, old, unknown, padded, and differently cased versions are rejected. The single key is parsed once at registration and shared by both authentication planes. See the [security model](../security.md) for key-domain separation.

## Configuration contract

- `Jwt:SecretKey`: at least 32 UTF-8 bytes of independent, non-template signing material;
- `Jwt:KeyVersion`: an explicit unique 3-64 character safe version such as `v2-2026-07`;
- `Jwt:Issuer`, `Jwt:Audience`, and `Jwt:AccessTokenExpiresMinutes`: the existing issuer, audience, and access-token lifetime rules.

The current binding rejects unknown signing configuration. There is no second validation key or token grace period. Session TTLs, concurrency limits, and WebAuthn/TOTP/recovery algorithms do not change with signing-key rotation.

## Atomic current-key cutover

1. Stop authenticated traffic and quiesce session/token issuance across serving processes. Create and verify a restorable backup through the qualified offline migration owner before destructive conversion.
2. Use the offline migration/session invalidation producer to revoke or delete every pre-cutover ordinary and administrator session and invalidate all old refresh families. Require the semantic target verification to prove that none remains usable; do not convert an old MFA boolean into current authentication strength.
3. Generate a new independent signing key and explicit version in the secret manager. Configure every serving process with that one current pair before authenticated traffic resumes.
4. Verify current ordinary/admin tokens carry the same exact `kid`, current context claims agree with their session rows, and refresh preserves method, strength, and authentication time. Correctly signed no-`kid` tokens, old/unknown versions, and tokens signed by the previous key must fail authentication, clear the applicable cookies, and create no session or refresh state.
5. Verify old access tokens, refresh tokens, and session identifiers are unusable before opening traffic. Repeating or resuming interrupted migration must preserve the complete invalidation postcondition.

Changing a signing key alone proves neither refresh-token invalidation nor removal of old session rows. The offline producer, its isolated provider run, backup/restore evidence, and target verification are required acceptance gates. An unavailable producer or failed gate blocks the cutover; source checks cannot replace these receipts.

## Risk and recovery

Different current pairs across serving processes cause authentication failures. Stop the cutover, then repair forward under the same full invalidation requirement. Backup recovery must restore a verified coherent database and deploy a single current key, with complete session/refresh invalidation before serving resumes. Routing traffic to an earlier slot that signs with an old key is not an accepted recovery path. Never enable key try-all, restore token grace periods, or remove issuer/audience/lifetime validation to hide a mismatch.
