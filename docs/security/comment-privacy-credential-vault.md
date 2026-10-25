# Comment privacy credential vault

## Decision

The production browser vault is memory-only. Persistent credential storage is completely disabled: FsusBlog does not provide a WebAuthn PRF, `hmac-secret`, non-exportable WebCrypto wrapping-key, or AEAD envelope mode for comment privacy credentials. A future persistent mode requires a separate security review and must not reuse this memory-vault label.

The vault never opens an IndexedDB object store. On first credential preparation and every private-state purge, it best-effort deletes the legacy `fsusblog-comment-privacy-credentials` database. A blocked or failed deletion is a migration failure: the local generation rotates, all reachable memory copies are purged, and credential preparation fails closed.

## Local isolation

Each browser realm starts with a random local vault generation. Logout, login/account switch, account deletion, credential revocation, issuer-key rotation, credential/root/epoch retirement, feature disable, panic wipe, session expiry, shared-device cleanup, and migration failure rotate that generation before asynchronous cleanup begins.

The generation is not derived from a user id, account subject, session id, Cookie, or server response. It is not sent in an HTTP request, proof request, worker message, log, telemetry payload, or cross-tab event. It exists only in the page realm and is part of the in-memory map key. Account switch therefore cannot address a record created under the previous generation even when cleanup of a browser subsystem is delayed.

Cross-tab lifecycle events contain only a fixed reason, a local random event id, and a timestamp. `BroadcastChannel` is preferred; restricted browsers fall back to an immediately removed `localStorage` event. A received event purges locally without rebroadcasting, preventing loops.

Login/account-switch publication waits for the sending tab's unified private-state purge to complete before any `login` event is emitted. Panic wipe independently rechecks Cache Storage and removes every `fsus-` cache after registry cleanup. Service-worker registration accepts only same-origin `/sw.js` with no query or one canonical immutable release id; mutable aliases are rejected before the Trusted Types sink.

## Material lifetime and cleanup

Credential secret, commitment, issuer signature, revocation witness, and revocation-handle hash are cloned only at explicit ownership boundaries. Overwrite, expiry, rotation, lifecycle purge, or failure fills reachable `Uint8Array` buffers with zero before releasing them. JavaScript best-effort zeroization cannot prove removal of engine, OS, swap, crash-dump, or forensic copies.

Proof inputs are copied into transferable buffers. Transfer detaches the page-side copy; the privacy worker clears its request views in `finally`, and lifecycle purge terminates the worker. Proof response buffers are cleared after the ticket request completes. Secrets are never copied to DOM state, console output, telemetry, or error payloads.

Panic wipe combines four boundaries and returns completion evidence to its caller:

1. rotate generation and run every registered memory/worker purge handler;
2. delete the legacy credential IndexedDB database;
3. send `privacy.clear` to active, waiting, and installing Service Workers and wait for `control-complete` acknowledgement;
4. delete every `fsus-*` Cache Storage namespace in both page and Service Worker contexts.

Normal logout/shared-device cleanup preserves explicitly public immutable static assets while deleting shell/search history and sensitive legacy entries. Panic wipe deliberately deletes all FsusBlog caches.

## Rotation and failure behavior

Before a vault lookup, the provider binds cached material to credential epoch, circuit id/numeric id/layout, issuer public-key hash, credential root, and revocation root. A change records the new binding, aborts all in-flight preload/proof work, purges and returns unavailable for that attempt. A later attempt obtains a new blind-signed credential. Old work cannot refill the vault after rotation.

The issuer response's `expiresAtUnixMs` must be finite and still in the future before signature acceptance. Cached material expires at the earlier of that credential expiry and the metadata's root expiry; the provider rechecks this bound after revocation work. Invalid or elapsed expiry fails closed instead of creating a non-expiring memory entry.

Private/incognito storage denial, Safari/iOS eviction, missing crypto, blocked legacy deletion, worker failure, and malformed metadata all fail closed to public-only commenting. No text/legacy credential path is used as a fallback.

Suite selection is centralized in `commentPrivacyCredentialProvider.ts`. Pure credential, issuer metadata, issue payload/response and suite contracts live in the import-free `commentPrivacyContracts.ts`; `commentPrivacyBlindRsaSuite.ts` consumes that contract and never imports the provider. An aborted operation or suite exception remains an opaque unavailable/null result and all temporary byte ownership rules below stay unchanged. The contract checker rejects reverse imports and snapshots the public type set so a later suite cannot silently create a fallback path.

## Browser script boundary and residual risk

Strong-anonymous pages load no third-party script. The site-wide contract is the [security model](../security.md): production HTML, Public AOT, and static responses use `require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry fsusui-markdown-feature`. `vue` names the fixed Vue runtime policy; the app alone creates module-private `fsusblog`; FsusUI owns `fsusui-markdown-feature`; and the AOT closure owns `fsusblog-spa-entry`, converting only the server-resolved single same-origin SPA entry/modulepreload to `TrustedScriptURL`. It permits only fixed same-origin comment prover, `/sw.js` service worker (no query or one immutable `build`), and hash-named same-origin workers. Vite's runtime modulepreload helper stays off; the stable SPA alias imports the hashed entry; the progress bar uses fixed DOM and external CSS. Reject `default`, `*`, `'allow-duplicates'`, third-party/external/blob URLs, arbitrary worker/prover queries, mutable service-worker queries, and exported policy objects. Development/Vite HMR has no Trusted Types enforcement; local release acceptance overlays production CSP while retaining Development fixture endpoints.

Named `fsusblog` wrappers are the only sinks: sanitized allowlist/fallback HTML → `TrustedHTML`; `application/json`, `application/ld+json`, or `application/octet-stream` data scripts → `TrustedScript`; fixed no-query/hash/credential `/wasm/comment-privacy-prover.js` → `TrustedScriptURL`; `/sw.js` and named Markdown/commentPrivacy/perception-v2/pospace/pow/wasmDecode workers accept only same-origin hash-named files. The manifest fixes `/wasm/comment-privacy-prover.wasm` and `/wasm/comment-privacy-prover.zkey`; validation fails before fetch/import. Tests/evidence cover raw-string `innerHTML`/`script.src`/`serviceWorker.register`/`Worker` non-reproduction, malicious HTML and external/blob negatives, Vue readiness, and a public page with no third-party script.

The runtime creates no `window`/`globalThis` vault, generation, enumeration, dump, secret export, or Trusted Types policy export. Memory-only storage limits persistence/shared-device reuse but not a compromised same-origin realm: pre-purge XSS, extensions, browser/OS compromise, debugger, memory snapshots, swap, and forensics may observe live material. Browser backup/sync has no credential database, but browser/OS memory artifacts remain outside application control.

## Operations and rollback

If vault behavior, root metadata, browser cleanup, or prover sinks are suspect, hot-reload the anonymous-comment policy to disable ZK. Clients purge and use public-only mode without backend restart; anonymous, login, admin, notification stream, and non-ZK binary paths are unaffected. Trusted Types is the site-wide production XSS boundary and cannot be hot-disabled for one path: if policy/CSP is incompatible, disable ZK first, then roll back the frontend and CSP together; never add wildcard/default policy. Do not restore the legacy IndexedDB vault or text credential fallback.

The production gate rejects credential IndexedDB open/write paths, enabled persistence labels, server identity in the local generation, missing lifecycle reasons, removed worker cleanup, window/global secret exports, raw prover sinks, and permissive Trusted Types/CSP names. It loads `security/evidence-contracts/comment-privacy-credential-vault.release-plan.json`, requires cross-account, real fake-IndexedDB dump/deletion, two-tab purge, and Trusted Types non-reproduction evidence IDs in `privacy-zk-comment-matrix`, verifies `check:privacy-zk-frontend` executes their files, then requires exactly one passing assertion per declared test from the same run-bound Vitest report and records evidence IDs/report digests in the functional-stage receipt.

## Verification matrix

| Scenario | Expected result |
| --- | --- |
| Anonymous request | Public metadata remains credential-free; failed privacy preparation returns public-only behavior. |
| Logged-in request | Login/account switch rotates generation before the next credential can be prepared. |
| Admin request | Revoke and feature-disable success trigger the same cross-tab purge; no credential bytes enter admin responses or telemetry. |
| Notification stream | Session-expiry/revocation stops authenticated runtime and purges credential state in every tab. |
| Binary transport | Credential issue/ticket wire contracts stay unchanged; local generation is absent from AEDS requests and proof transcript. |
| Cross-account | Account B causes a new issuance and cannot address account A's generation. |
| Two tabs | Remote logout purges the receiving tab once and does not rebroadcast. |
| IndexedDB dump | Legacy database deletion leaves no secret/signature/witness record; runtime never opens a replacement store. |
| Rotation | Epoch/issuer/root/circuit change purges, aborts in-flight work, returns unavailable once, then reissues. |
| Panic | Memory, worker, legacy IndexedDB, Service Worker state, and Cache Storage are cleared with acknowledgement/result evidence. |
