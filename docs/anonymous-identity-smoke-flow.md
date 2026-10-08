# Anonymous Identity Smoke Flow

This runbook verifies anonymous identity mode after the account-subject physical projection cutover. Existing users, comments, credentials, sessions and message state are preserved; release acceptance is a deterministic expand/backfill/readiness sequence, not a destructive maintenance action.

Run these checks first against an isolated restored database, then repeat the same read-only acceptance queries against production before routing traffic to the candidate.

## Preconditions

1. Restore the latest site backup into an isolated PostgreSQL database.
2. Point the backend at that database and enable anonymous identity mode.
3. Apply `20260711-pre-account-subject-hash-expand`, drain previous-version account writers, then apply `20260711-post-account-subject-hash-backfill`.
4. Keep `FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN` available for first admin bootstrap.

## Checklist

### physical account-subject projection

Confirm existing account and comment counts are unchanged by the projection migration. Then run the same invalid-projection predicate used by the permanent startup gate:

```sql
SELECT COUNT(*) AS invalid_account_subject_count
FROM sys_user
WHERE account_subject_hash IS NULL
   OR btrim(account_subject_hash) = ''
   OR account_subject_hash !~ '^[0-9a-f]{64}$';
```

The result must be `0`. The operator shorthand `account_subject_hash IS NULL OR account_subject_hash = ''` is covered by the stricter query above, which also rejects whitespace-only and malformed digests. Confirm the candidate reports `accountSubjectHashInvariant=ok` before it receives traffic. After migration history is already present, temporarily injecting a null into an isolated rehearsal database must make the candidate fail readiness/startup; restoring the projected digest must recover startup without deleting account data.

Create one anonymous account with a public handle and one without. Confirm both inserts persist `account_subject_hash`, issued access tokens carry that exact value, and subsequent public-handle or Passkey-handle changes do not change it. Confirm an old account snapshot payload without the field misses the `account:subject-v1:*` cache namespace and is reread from PostgreSQL.

### bootstrap admin

Use the admin bootstrap token to create the first admin principal through the Passkey bootstrap flow. Confirm the principal is stored in `admin_principal`, the session is stored in `admin_session`, and a legacy `sys_user.role=admin` row does not grant admin authority.

### Passkey registration/login

Create a fresh anonymous account through the Passkey-first registration flow. Confirm the account has anonymous-safe WebAuthn metadata, no password-first registration requirement, and can log in through Passkey without a legacy username/password proof.

### Recovery Key creation/recovery

Create a Recovery Key and verify that the plaintext is shown once. Use it through the recovery flow to receive a short-lived recovery session token and bind a replacement Passkey. Confirm this path is separate from TOTP MFA recovery codes; TOTP codes must not recover the account or rebind Passkeys.

### anonymous default comment submission

Submit a comment without selecting public sending. Confirm the request uses `CommentCreateRequest`, `authorMode=anonymous`, `publicSendExplicitlySelected=false`, and the stored comment has nullable `user_id` plus a server-generated anonymous author view.

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

The gate is backed by `security/matrices/privacy-zk-comment.yml` and covers anonymous transport without Cookie or Authorization, strong-anonymous request rejection when credentials are present, fail-closed ZK proof/root/verifier handling, one-shot ticket consumption, scoped nullifier behavior, provider and log redaction, admin non-reversibility, explicit public opt-in, frontend fake-timer/worker/Abort coverage, and deterministic high-concurrency pressure cases.

`check:privacy-zk-prod-smoke` writes `.tmp/security/privacy-zk-prod-smoke.json`. When `AnonymousIdentity:ZkCommentPolicy:Enabled=false` or the browser prover artifact is not present, the smoke result must be `expected_unavailable` with a trace id and business state. When real Groth16 / circuit-native artifacts are available, pass sanitized real evidence with `--real-evidence` and `--require-real`; the evidence must prove native verifier, wasm prover, circuit-native credential, ticket issue, anonymous submit pending state, omitted identity headers, and sensitive payload redaction. Real evidence must include local `artifacts.*.path` and `artifacts.*.sha256` entries for `r1cs`, `provingKey`, `verifyingKey`, `nativeVerifier`, `wasmProver`, `proofFixture`, `publicInputs`, and `tamperCases`; the smoke and release gates recalculate SHA-256 from those files, and the first five hashes must match `artifactHashes`. The smoke summary must never contain proof, ticket, credential secret, or nullifier secret material.

## Required Evidence

Attach the smoke notes to the issue or release evidence with:

- pre/post account and comment row counts plus the zero-result invalid account-subject query
- admin bootstrap principal id
- Passkey registration/login result
- Recovery Key create and recovery result, without plaintext key material
- anonymous default submission id and localized author view
- public opt-in submission id
- anonymous-disabled rejection status
- moderation review screenshot or exported queue item with nullable user id and actor signals
- ZK-Prod smoke summary path, trace id, business state, and either expected-unavailable reason or sanitized real proof -> ticket -> submit -> pending evidence with local artifact path/SHA bindings

## Current authentication methods

<!-- fsus-doc-claim
claimId: authentication-session-permission.methods
behaviorId: authentication-session-permission
claimType: generated-section
generatedSectionId: auth.methods.active
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN auth.methods.active -->
- `enrollment`
- `other`
- `passkey`
- `recovery_key`
<!-- FSUSBLOG-GENERATED:END auth.methods.active -->
