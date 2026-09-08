# Frontend session-refresh coordination

Ordinary-account pages no longer infer Access Token lifetime from page-start time. A successful `GET /api/binary/auth/me` response supplies `X-Fsus-Access-Expires-At-Utc`; the client schedules refresh from that absolute server time minus a fixed safety margin. Missing or invalid metadata is a protocol failure, not a hard-coded TTL fallback.

Refresh uses one leader: Web Locks first serializes `fsus-auth-refresh-leader`; if unavailable, a separate `fsus-auth-refresh` BroadcastChannel performs short-round elections; if both are unavailable, only current-tab in-flight deduplication remains. Events contain only `v/type/round/contender/at/outcome`, never a Token, Session ID, account ID, proof, or user profile.

After rotation the leader requests `/auth/me` to confirm the Cookie session and new absolute expiry; a follower receiving success also only revalidates `/auth/me`, never another refresh POST. If the leader exits, the lock releases or the round times out and followers may elect again. When Web Locks works without BroadcastChannel, `localStorage` stores only the last settlement's millisecond timestamp for the next lock holder's `/auth/me` decision; the hint has no identity, Token, Session ID, or result body and cannot authorize.

The Refresh Token POST is non-idempotent and never auto-replayed after a network error. An unknown result uses bounded revalidation backoff from 5 to 60 seconds and retries only idempotent `/auth/me`; only authentication failure advances `authGeneration`, cancels old-identity requests, and clears private browser state. During network failure state stays `authenticated`/`unknown`, not `Guest`. Defense in depth returns `409 Conflict` for an old same-Session token within the short race window without deleting Cookie or revoking the family; later reuse follows replay revocation and fails closed.

## Runtime rollback

- A browser policy may disable Web Locks, falling back to BroadcastChannel election; without BroadcastChannel it falls back to single-tab in-flight deduplication. Neither path requires a restart or restores automatic refresh-POST replay.
- The new response header is additive HTTP metadata and does not change AEDS frame numbers or POD layout. Old clients ignore it; new clients stop automatic refresh and expose a protocol error when it is missing.
