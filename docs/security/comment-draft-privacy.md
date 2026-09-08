# Comment draft privacy

## Security goals

Draft persistence follows the publishing identity:

- `zk_anonymous`: the body exists only in current Vue-component memory and cannot be recovered after refresh, tab close, or browser restart.
- `public`: after the user explicitly enables “show my name publicly,” the body may be best-effort persisted in `localStorage` for refresh/restart recovery.

There is no PRF-encrypted vault, and anonymous bodies never enter `sessionStorage`, IndexedDB, or Cache Storage. Future encrypted persistence needs a separate key-lifecycle, cross-account-unlinkability, recovery, migration, and browser-backup threat-model review; it cannot reuse the [credential-vault](comment-privacy-credential-vault.md) conclusion.

## Storage contract

The public key is `fsus:comment-public-draft:v2:<local-scope>:<article>:<reply>`. `local-scope` is browser-cryptographic random data, never an account-id hash/encoding. Logout, account switch, expiry, deletion, and panic wipe delete the scope with its draft, so keys cannot compare account lifecycles. The payload contains only schema `version = 2`, public body, `savedAt`, and `policyHash`; it excludes `authorMode`, `publicSendConfirmed`, account id, and anonymous credential/proof. Initialization does not migrate `fsus:comment-draft:v1:*` (which may contain raw account IDs and anonymous plaintext); it deletes those entries.

## Lifecycle and cleanup

| Event | Public persistent draft | Anonymous memory draft | Publish behavior |
| --- | --- | --- | --- |
| Public edit with the same policy hash | Save and auto-restore public mode | None | Normal |
| Public → anonymous | Delete the matching public copy first | Keep current memory | Deletion failure fails anonymous closed |
| Policy hash change | Keep as review candidate | Do not auto-load | User explicitly reviews; body enters editor and identity resets |
| Logout/account switch/session expiry/account deletion | Delete scope and all drafts | Clear | New account creates a new scope |
| Credential revoked/issuer-key rotation/root retired/epoch changed | Unrelated public drafts survive | Clear current anonymous body | Prepare a new credential before editing |
| Feature disabled | Unrelated public drafts survive | Clear current anonymous body | Anonymous entry closes; public still requires explicit choice |
| Panic/shared-device/migration failure | Delete scope, legacy entries, and all drafts | Clear | Restart only from clean state |

If storage APIs are unavailable, public drafts become memory-only and anonymous mode gains no persistent sink. If an old copy is readable but cannot be deleted, show cleanup failure and pause anonymous submission so the disk copy cannot be linked to new anonymous text.

## Automated gates

`tools/security/check-comment-draft-privacy.mjs` requires that:

1. The composer owns no Web Storage, IndexedDB, or Cache Storage write sink.
2. The sole persistent owner and runtime validator accept only public payloads.
3. The owner contains no account id, author mode, public confirmation, or `zk_anonymous`.
4. The registry records the v2 public prefix, local scope, and v1 legacy purge.
5. Frontend scanning rejects anonymous mode becoming adjacent to persistent browser writes.

Focused behavior tests cover public/anonymous switching, same-policy recovery, explicit review after policy changes, account switch, credential-epoch cleanup, legacy cleanup failure, and scope rotation.

## Risk and no-restart degradation

Public drafts remain browser plaintext and may be read by site backups, browser sync, or malicious extensions; only explicitly public-name content may persist. On cleanup or anonymous-lifecycle failure, hot-reload `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` or `AnonymousIdentity:ZkProd:Enabled=false`. The next policy refresh performs a `feature-disabled` purge, clears anonymous memory, and leaves public comments and drafts working. Stronger response uses the existing panic wipe for all FsusBlog private browser state. This does not change admin, notification-stream, or binary API contracts and needs no backend restart.
