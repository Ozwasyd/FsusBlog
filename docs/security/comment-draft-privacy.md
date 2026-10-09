# Comment draft privacy

## Security goals

Draft persistence follows the publishing identity:

- `zk_anonymous`: the body exists only in current Vue-component memory and cannot be recovered after refresh, tab close, or browser restart.
- `public`: after the user explicitly enables “show my name publicly,” the body may be best-effort persisted in `localStorage` for refresh/restart recovery.

Persistence recovers the body, not consent to a publishing identity. Every restored public draft, including one with the current policy hash, first enters explicit review. Restoration resets `authorMode` to `zk_anonymous` and `publicSendConfirmed` to false, leaves current in-memory text untouched, and preserves the saved candidate until review or discard. The Checkbox remains unchecked and disabled during review. Reviewing loads the recovered body, removes its saved copy through the existing cleanup boundary, and resets identity/confirmation again. Public attribution requires a deliberate Checkbox choice in this composer after review; a prior composer or draft cannot supply that confirmation.

There is no PRF-encrypted vault, and anonymous bodies never enter `sessionStorage`, IndexedDB, or Cache Storage. Future encrypted persistence needs a separate key-lifecycle, cross-account-unlinkability, recovery, migration, and browser-backup threat-model review; it cannot reuse the [credential-vault](comment-privacy-credential-vault.md) conclusion.

## Storage contract

The current public key is `fsus:comment-public-draft:v3:<local-scope>:<article>:<reply>`. `local-scope` is browser-cryptographic random data, never an account-id hash/encoding. Logout, account switch, expiry, deletion, and panic wipe delete the scope with its draft, so keys cannot compare account lifecycles. The existing payload contains only schema `version = 3`, public body, `savedAt`, `policyHash`, and `clientMutationId`; it excludes `authorMode`, `publicSendConfirmed`, account id, and anonymous credential/proof. Initialization does not migrate `fsus:comment-draft:v1:*` (which may contain raw account IDs and anonymous plaintext); it deletes those entries. Identity restoration changes neither this schema nor its storage owner.

After explicit review, this composer may retain the existing mutation identity only in memory. An unchanged body with the same policy and article/reply draft key may reuse it after the user deliberately confirms public attribution, preserving retry idempotency. Reading another draft key clears the reviewed retry identity, including when that key has no stored draft. Clearing the body ends this retry transaction; entering the same text again starts a new mutation. Anonymous submissions never use this public retry identity. Discard and the existing anonymous-memory/account/privacy purge clear it.

## Lifecycle and cleanup

| Event | Public persistent draft | Anonymous memory draft | Publish behavior |
| --- | --- | --- | --- |
| Public edit with the same policy hash | Save; restore as review candidate without restoring identity or confirmation | Keep current memory until explicit review | Review recovers the body; public attribution requires a new Checkbox choice |
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
4. The registry records the current v3 public prefix, local scope, and v1 legacy purge.
5. Frontend scanning rejects anonymous mode becoming adjacent to persistent browser writes.

The scanner still contains stale v2 prefix/version assertions against the existing v3 owner and registry; that known failure is not a waiver or a reason to change the runtime schema.

Focused behavior tests cover public/anonymous switching, mandatory review for matching and changed policies, preservation of unreviewed stored and in-memory bodies, explicit Checkbox reconfirmation, public retry identity continuity, anonymous submission identity separation, cleanup failure, account switch, credential-epoch cleanup, legacy cleanup failure, and scope rotation.

## Risk and no-restart degradation

Public drafts remain browser plaintext and may be read by site backups, browser sync, or malicious extensions; only explicitly public-name content may persist. On cleanup or anonymous-lifecycle failure, hot-reload `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` or `AnonymousIdentity:ZkProd:Enabled=false`. The next policy refresh performs a `feature-disabled` purge, clears anonymous memory, and leaves public comments and drafts working. Stronger response uses the existing panic wipe for all FsusBlog private browser state. This does not change admin, notification-stream, or binary API contracts and needs no backend restart.
