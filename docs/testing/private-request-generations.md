# Private Request Generation Verification

Focused tests use deferred Promises to cover:

- Account A's slow, unfinished response followed by a switch to account B: the old signal is aborted, A's result cannot reach the Store, and B's new-generation request can commit.
- Administrator-session change: only old admin requests are cancelled; the account generation is unaffected.
- Optional-auth public read: transport is not proactively cancelled on identity change, but the old-account projection is rejected before return.
- Component unmount: the caller's `AbortSignal` continues propagating to the shared lease.
- `BroadcastChannel` `logout`/`expired`/`user-expired`/`account-switch`: `PrivateSurfaceRuntime` advances the generation before clearing the Store.

Scenario boundaries: anonymous public binary requests do not register cancellation; authenticated requests use the account generation; admin requests use an independent admin generation; the private-page runtime stops Notification Stream on identity change; and binary decoding must still pass the generation commit check.

The static gate `check-private-request-generation.mjs` rejects new bypasses for:

- legacy `binaryUrl` calls without declared `privateScope`;
- direct `fetch`/`binaryRequest` in the API directory without `runPrivateRequest`;
- binary transport missing the shared lease or response commit check;
- identity changes that do not advance the generation.
