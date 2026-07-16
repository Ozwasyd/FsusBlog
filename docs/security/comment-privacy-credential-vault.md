# Comment privacy credential vault

## Decision

The production browser vault is memory-only. Persistent credential storage is completely disabled: FsusBlog does not provide a WebAuthn PRF, `hmac-secret`, non-exportable WebCrypto wrapping-key, or AEAD envelope mode for comment privacy credentials. A future persistent mode requires a separate security review and must not reuse this memory-vault label.

The vault never opens an IndexedDB object store. On first credential preparation and every private-state purge, it best-effort deletes the legacy `fsusblog-comment-privacy-credentials` database. A blocked or failed deletion is a migration failure: the local generation rotates, all reachable memory copies are purged, and credential preparation fails closed.

## Local isolation

Each browser realm starts with a random local vault generation. Logout, login/account switch, account deletion, credential revocation, issuer-key rotation, credential/root/epoch retirement, feature disable, panic wipe, session expiry, shared-device cleanup, and migration failure rotate that generation before asynchronous cleanup begins.

The generation is not derived from a user id, account subject, session id, Cookie, or server response. It is not sent in an HTTP request, proof request, worker message, log, telemetry payload, or cross-tab event. It exists only in the page realm and is part of the in-memory map key. Account switch therefore cannot address a record created under the previous generation even when cleanup of a browser subsystem is delayed.

Cross-tab lifecycle events contain only a fixed reason, a local random event id, and a timestamp. `BroadcastChannel` is preferred; restricted browsers fall back to an immediately removed `localStorage` event. A received event purges locally without rebroadcasting, preventing loops.

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

Private/incognito storage denial, Safari/iOS eviction, missing crypto, blocked legacy deletion, worker failure, and malformed metadata all fail closed to public-only commenting. No text/legacy credential path is used as a fallback.

## Browser script boundary and residual risk

Strong-anonymous pages must not load third-party script. Production HTML、Public AOT 与静态响应统一下发 `require-trusted-types-for 'script'; trusted-types vue fsusblog fsusblog-spa-entry`：`vue` 只对应当前 Vue runtime 的固定 policy name，应用侧只创建 module-private `fsusblog` policy，并仅允许固定同源 comment prover、固定同源 service worker（可选单一 immutable `build`）与同源、无 query/hash、构建 hash 命名的应用 Worker；Public AOT bootstrap 的闭包内 `fsusblog-spa-entry` 只把服务端已解析的单一同源 SPA entry 与 modulepreload 转为 `TrustedScriptURL`，Vite runtime modulepreload helper 保持关闭，稳定 SPA alias 只 import hashed entry。导航进度条只使用固定 DOM 与外部 CSS。禁止 `default`、`*`、`'allow-duplicates'`、外部/blob URL、任意 worker/prover query、service worker 非 immutable-build query 或对外暴露 policy object。普通 Development/Vite HMR 不启用 Trusted Types enforcement；本地 release acceptance 使用 production CSP 覆盖，同时仍保留 Development fixture endpoints。

`fsusblog` policy 只通过命名窄封装进入 sink：allowlist/fallback 已清洗 HTML 才能生成 `TrustedHTML`；`application/json`、`application/ld+json`、`application/octet-stream` 数据 script 才能生成 `TrustedScript`；评论 prover 只能把无 query/hash/credential 的同源固定路径 `/wasm/comment-privacy-prover.js` 生成 `TrustedScriptURL`；service worker 只接受同源 `/sw.js` 和可选的单一 immutable build id；Markdown 与 captcha/commentPrivacy/perception-v2/pospace/pow/wasmDecode Worker 只接受各自命名的同源、无 query/hash 构建文件。manifest 中 wasm 和 proving key 同样固定为 `/wasm/comment-privacy-prover.wasm` 与 `/wasm/comment-privacy-prover.zkey`，校验失败时在 fetch/import 之前 fail closed。原始字符串写 `innerHTML` / `script.src` / `serviceWorker.register` / `Worker` 的非复现测试、恶意 HTML/外部或 blob URL 负例、Vue 应用就绪与 public page 无第三方 script 的浏览器验收共同构成发布证据。

The credential runtime creates no `window`/`globalThis` vault, generation, enumeration, dump, secret export, or Trusted Types policy export.

Memory-only storage reduces persistence and shared-device reuse; it does not make a compromised same-origin realm safe. XSS executing before a purge, a malicious browser extension, a compromised browser/OS, debugger access, memory snapshots, swap, or device forensics may observe live material. Browser backup/sync does not contain a credential database because persistent mode is disabled, but browser/OS memory artifacts remain outside application control.

## Operations and rollback

If credential-vault behavior, root metadata, browser cleanup, or prover sink validation is suspect, disable ZK anonymous comments through the reloadable anonymous-comment policy. Clients observing the transition purge and fall back to public-only behavior without restarting the backend; anonymous、登录、admin、notification stream 与非 ZK binary 路径不受影响。Trusted Types 是全站 production XSS boundary，不能为单个匿名评论路径热关闭；若 policy/CSP 与已发布前端不兼容，应先热关 ZK，再回滚整组前端与 CSP 发布版本，不能加入 wildcard/default policy 作为应急绕过。Do not restore the legacy IndexedDB vault or a text credential fallback.

The production release gate statically rejects credential IndexedDB open/write paths, an enabled persistence label, server identity in the local generation channel, missing lifecycle reasons, worker cleanup removal, window/global secret exports, raw privacy-prover script sinks, and permissive Trusted Types policy/CSP names. It also loads `security/privacy/comment-privacy-credential-vault.release-plan.json`, requires the cross-account negative, real fake-IndexedDB dump/deletion, two-tab purge, and Trusted Types non-reproduction evidence IDs in the `privacy-zk-comment-matrix` tier, and verifies that `check:privacy-zk-frontend` executes their files. Production evidence projection then requires exactly one passing assertion for each declared test name from the same run-bound Vitest report and records the evidence IDs and report digests in the functional-stage receipt.

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
