# Anonymous Identity Smoke Flow

This runbook verifies cold-start anonymous identity mode after the legacy identity cutover. The reset is destructive by design: old users and historical comments are intentionally cleared, including legacy sessions, legacy Passkey rows, MFA recovery-code hashes, comment moderation rows, and user-bound message state.

Run these checks first against an isolated restored database. Do not run the production cold-start reset until the rehearsal result has been accepted.

## Preconditions

1. Restore the latest site backup into an isolated PostgreSQL database.
2. Point the backend at that database and enable anonymous identity mode.
3. Set `FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS` for exactly one guarded startup.
4. Remove `FSUSBLOG_CONFIRM_IDENTITY_RESET` after the reset startup completes.
5. Keep `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` available for first admin bootstrap.

## Checklist

### cold-start reset

Start the backend once with `FSUSBLOG_CONFIRM_IDENTITY_RESET=DELETE_LEGACY_USERS`. Confirm these production tables still exist and contain zero legacy rows:

- `sys_user`
- `sys_user_session`
- `passkey_credential`
- `comment`
- `comment_region_compliance`
- `comment_moderation_signal`
- `msg_participant_state`
- user-bound `msg_message`
- user-bound `msg_conversation`

Restart without `FSUSBLOG_CONFIRM_IDENTITY_RESET` and confirm the reset no longer runs. A missing or different confirmation value must fail before destructive SQL starts.

### bootstrap admin

Use the admin bootstrap token to create the first admin principal through the Passkey bootstrap flow. Confirm the principal is stored in `admin_principal`, the session is stored in `admin_session`, and a legacy `sys_user.role=admin` row does not grant admin authority.

### Passkey registration/login

Create a fresh anonymous account through the Passkey-first registration flow. Confirm the account has anonymous-safe WebAuthn metadata, no password-first registration requirement, and can log in through Passkey without a legacy username/password proof.

### Recovery Key creation/recovery

Create a Recovery Key and verify that the plaintext is shown once. Use it through the recovery flow to receive a short-lived recovery session token and bind a replacement Passkey. Confirm this path is separate from TOTP MFA recovery codes; TOTP codes must not recover the account or rebind Passkeys.

### anonymous default comment submission

Submit a comment without selecting public sending. Confirm the request uses `CommentCreateV2Request`, `authorMode=anonymous`, `publicSendExplicitlySelected=false`, and the stored comment has nullable `user_id` plus a server-generated anonymous author view.

Verify localized display names for both supported languages:

- `zh-CN`: `匿名用户` plus a curated common name
- `en`: `Anonymous User` plus a curated common human name

Display names must not expose account id, username, public handle, credential id, proof token, nullifier hash, or moderation subject hash.

### public opt-in comment submission

Select public sending explicitly and confirm the UI requires the confirmation control before submit. Confirm the backend receives `authorMode=public` with `publicSendExplicitlySelected=true`, stores the public actor, and rejects public mode when explicit opt-in is missing.

### anonymous policy disabled state

Disable anonymous comments from the admin anonymous-comment policy surface. Confirm anonymous and ZK anonymous controls become unavailable in the frontend, anonymous submissions are rejected by the backend with the anonymous-disabled status, and public comments still require explicit opt-in.

### moderation review

Open the moderation queue and confirm each item can be reviewed without a required `userName`. Anonymous items must show actor display name, author mode, display language, anonymous scope, credential level, reputation bucket, account age bucket, and nullifier/credential actions when the admin principal has the required permissions.

### privacy/ZK release gate

Before release, run the strong privacy gate:

```bash
npm --prefix src/frontend run check:privacy-zk
npm --prefix src/frontend run check:privacy-zk-prod-smoke
npm --prefix src/frontend run check:privacy-zk-prod-release
```

The gate is backed by `security/privacy-zk-comment-matrix.yml` and covers anonymous transport without Cookie or Authorization, strong-anonymous request rejection when credentials are present, fail-closed ZK proof/root/verifier handling, one-shot ticket consumption, scoped nullifier behavior, provider and log redaction, admin non-reversibility, explicit public opt-in, frontend fake-timer/worker/Abort coverage, and deterministic high-concurrency pressure cases.

`check:privacy-zk-prod-smoke` writes `.tmp/security/privacy-zk-prod-smoke.json`. When `AnonymousIdentity:ZkProd:Enabled=false` or the browser prover artifact is not present, the smoke result must be `expected_unavailable` with a trace id and business state. When real Groth16 / circuit-native artifacts are available, pass sanitized real evidence with `--real-evidence` and `--require-real`; the evidence must prove native verifier, wasm prover, circuit-native credential, ticket issue, anonymous submit pending state, omitted identity headers, and sensitive payload redaction. The smoke summary must never contain proof, ticket, credential secret, or nullifier secret material.

## Required Evidence

Attach the smoke notes to the issue or release evidence with:

- reset database row counts
- admin bootstrap principal id
- Passkey registration/login result
- Recovery Key create and recovery result, without plaintext key material
- anonymous default submission id and localized author view
- public opt-in submission id
- anonymous-disabled rejection status
- moderation review screenshot or exported queue item with nullable user id and actor signals
- ZK-Prod smoke summary path, trace id, business state, and either expected-unavailable reason or sanitized real proof -> ticket -> submit -> pending evidence
