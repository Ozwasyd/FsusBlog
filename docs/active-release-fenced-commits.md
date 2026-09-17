# Active release fenced database commits

This document defines the PostgreSQL commit boundary for `active-singleton` workers. Transaction-outside reads by the ordinary `IActiveReleaseCommitGuard` can cancel work early but cannot prove that the fence stayed unchanged between the read and database commit. Every `active-singleton` PostgreSQL mutation must enlist through `IActiveReleaseTransactionalCommitGuard` inside the business transaction.

## Atomic boundary

`ActiveReleaseFencedTransaction.ExecuteAsync` performs these steps in one SqlSugar/PostgreSQL transaction:

1. Execute the business mutation.
2. Read `releaseId + slot + generation + imageDigest + processInstanceId` from the execution context.
3. Acquire `pg_advisory_xact_lock_shared` under the same key as the fence mutation, then run `SELECT ... FOR SHARE` for the exact active owner in `sys_deployment_fence`.
4. Use the same CTE to write the token to `sys_fenced_commit`.
5. Commit the business mutation and token row.

If the owner does not match, the CTE creates no token row, the guard throws `ActiveReleaseFenceLostException`, and the entire business transaction rolls back. The shared advisory lock and `FOR SHARE` row lock remain until business commit; acquire/revoke use the same key with an exclusive advisory lock and `FOR UPDATE`. A fence change therefore waits for the old transaction to commit, with no gap-lock window when the singleton row is absent. If revocation or replacement completes first, the old transaction sees no matching active owner when enlisting and must roll back. This covers revocation after a pre-check, recovery from a long GC pause, and a Redis partition; the transaction decision reads only the PostgreSQL durable witness introduced by #1118, never a stale Redis snapshot.

`sys_fenced_commit` stores the commit token, operation scope, mutation key, release/slot/generation/digest, process instance, and enlist time. A rolled-back transaction leaves no token row, so a visible token is equivalent to successful commit of its business transaction. Operation scope and mutation key must contain neither user input nor secrets.

Current wiring covers:

- scheduled-publish article status and outbox insert;
- article-mutation outbox claim, heartbeat, edge, retry, and complete transitions;
- article-view projection and watermark transaction; and
- log-cleanup visit/RUM/audit/pseudonym/fenced-token delete chunks.

`sys_fenced_commit` is retained for 30 days and cleaned by the same fenced-transaction cleanup chunk. Each cleanup transaction leaves its own new token, so the ledger is never emptied into an unauditable state.

File, object-storage, and in-process mutations retain the existing `IActiveReleaseCommitGuard` and worker lease; they do not pretend to be PostgreSQL atomic transactions.

## Periodic audit and alerting

`ActiveReleaseFencedCommitAuditWorker` periodically reads recent tokens and checks the durable fence's generation and activation/revocation times for:

- token generation higher than the durable fence;
- different identity/digest at the same generation;
- a revoked same-generation fence with token time at or after revocation; or
- an old-generation token at or after new-generation activation.

Violations use Critical logs and add:

- `fsus.active_release_fenced_commit.enlistments{result,operation_scope}`
- `fsus.active_release_fenced_commit.audits{result}`
- `fsus.active_release_fenced_commit.violations{result}`

Audit detects and alerts; it cannot automatically roll back unknown business side effects after the fact. The actual blocking boundary is the transaction's row lock plus token insert.

## No-restart rollback

If the new guard, table capacity, or audit misbehaves, set the reloadable `ActiveReleaseFencedCommit:MutationEnabled=false`. This does not return to an unsafe transaction-outside check: every wired PostgreSQL mutation throws `ActiveReleaseFencedCommitPausedException` before commit and rolls back. Reads, the notification stream, public binary reads, and existing pending outbox work remain available. After investigation, restore `true`, verify a clean durable fence and audit, then resume worker mutations.

`ActiveReleaseFencedCommitAudit:Enabled=false` pauses only periodic scanning; it cannot disable the transaction guard. Interval, recent window, and batch size are read from configuration on every round, so no restart is needed.

## API and security boundary

This change adds no public, login, admin, notification-stream, or binary endpoint and changes no DTO/AEDS frame. The admin fence endpoint remains loopback + `system.config`; anonymous and login requests do not touch the commit-token table. Tokens do not enter responses, log labels, or client evidence.
