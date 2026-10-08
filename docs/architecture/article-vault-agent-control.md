# Article Vault agent control boundary

This document describes the lease and closed IPC source for issues
[#2113](https://github.com/Ozwasyd/FsusBlog/issues/2113) and
[#2114](https://github.com/Ozwasyd/FsusBlog/issues/2114). It does not certify a
running filesystem agent. The lifecycle implementation reduces versioned facts
and owns persistent local control resources; it does not install a signed package, atomically
update a binary, start processes, or produce a verified rescan.

## Sole protocol and native ownership

`ArticleVaultAgentProtocol` defines protocol version 1. Its request registry
contains only observe-batch, request-planner, execute-verified-plan,
materialize-verified-instruction, inspect-status, cancel and revoke. Every
request binds site, Vault, device, agent instance, user session, root digest,
binary digest/version, protocol, generation, lease receipt, request identity,
deadline and cancellation identity. Each command accepts only its closed
content-addressed reference kind. A reference is not proof that its producer
admitted a plan, batch or instruction.

Requests are bounded to 16 KiB. Missing/unknown/duplicate fields, numeric or
unknown enum values, incompatible protocol versions and arbitrary path,
shell, body, network, service-object or credential fields fail closed. Parser
errors expose only a stable reason without retaining an input-bearing inner
exception. Command receipts contain command class, identities, byte count,
digests, status and reason; completed requires a canonical result reference.

`LinuxVaultWriterLeaseScope` consumes the existing Linux root verifier. It
binds a canonical root and mount to one site/Vault/device, opens a resident
control file through descriptor-relative no-follow traversal, verifies native
ownership/permissions and holds nonblocking exclusive `flock` until disposal.
The lock filename derives from site and Vault, independently of agent or root,
so a second instance cannot choose a different lock merely by changing its
agent identity. A different root for an existing Vault is blocked by journal
binding validation. There is no mtime election or automatic takeover of a
live process's expired lock.

The lease journal is bounded to 1 MiB and records canonical, chained acquire,
renew, release, revoke and expire receipts. Each transition validates owner,
generation, previous receipt and deadline. Appends flush to disk. A process
that has acquired the actual kernel lock may revoke its dead predecessor's
active receipt before advancing generation. An incomplete append, invalid
chain or exhausted budget blocks and requires explicit recovery/retention
work. The implementation never truncates, replaces or deletes the lock inode.
Current commands also revalidate root/control-file identity and permissions.
Wall-clock rollback and expiration block; Linux `CLOCK_BOOTTIME` bounds a live
lease across machine suspension. Revocation retains the lock until owned work
has stopped and the scope is disposed.

## Explicit Linux runtime gate

The fixed current-user namespace is `/run/user/<euid>/fsusblog-vault`. An
operator or the eventual trusted installation owner must provision a 0700
directory and the site/Vault's resident 0600 regular lease file. Both must be
owned by the current effective user; the file must have one link. The code
does not create the directory/file, change their persistent permissions,
install credentials or substitute a task-local namespace. Missing namespace,
ownership, mode, architecture, local filesystem or native admission fails
closed. Only Linux X64/Arm64 is implemented here.

`LinuxVaultLocalIpcEndpoint` creates one ephemeral Unix stream socket inside
that namespace, secures it to 0600, checks its native identity and requires
actual current-user `SO_PEERCRED` on accepted peers. It has no TCP/listen-all
constructor. Existing socket files block startup. The listener uses a native
bind wrapped in a managed socket, because the
[.NET 10 managed bind/dispose implementation](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Sockets/src/System/Net/Sockets/Socket.cs)
automatically unlinks its bound pathname; explicit inode/device checking is
required before deleting this endpoint. A replaced endpoint is retained and
reported as unowned rather than deleted. An interrupted process can leave a
stale socket requiring explicit owned recovery; startup never removes it
implicitly.

Each connection carries exactly 32 opaque token bytes, a four-byte big-endian
frame length and one closed request. Reads are bounded by a cancellation scope
and 30-second timeout. The secret is zeroed after admission or failure. Grants
are scoped to the current binding, lease generation and one command purpose,
expire within 30 seconds and never outlive the lease. Rotation invalidates the
previous token for that purpose. Revocation invalidates all grants before
revoking the lease. The replay ledger rejects duplicate IDs and blocks at
4096 requests rather than evicting old IDs. It is session-local; durable
operation idempotency remains the canonical operation owner's responsibility.

Local request admission is not execution. `ServeNextAsync` keeps the admitted
peer connection open, dispatches the closed request and sends a four-byte
big-endian length followed by one bounded command receipt. It reparses and binds
the result to the original request, including frame size, deadline and cancellation
identity. Service objects, bodies and credentials cannot enter that response.

`ArticleVaultAgentDispatchScope` registers bounded, host-supplied canonical planner
inputs and exact operation pointers. It snapshots inputs, uses the original
`ArticleVaultSyncPlanner.Build` and consumes verified histories through
`IArticleVaultAgentCanonicalOperations`. Execute requests are pinned to their
registered request/cancellation identities and original plan reference/digest; cancel targets only the exact operation
and signals its owned in-flight request. Cancellation then calls the canonical
checkpoint writer with its exact expected predecessor. A not-started/rejected
server stage can become Cancelled; an unknown/accepted stage becomes
RecoveryRequired and retains its exact server receipt. The dispatcher verifies
the returned history and the lifecycle owner fsyncs the new pointer before IPC
can return it. A conflicting append or missing read-back never reports durable
cancellation. An interrupted accepted result
retains its canonical digest with recovery-required semantics.

`ArticleVaultAgentCanonicalOperationAdapter` is a server composition adapter over
the original sealed execution store, checkpoint store and sync executor. It verifies
persisted results before and after the original executor's result-replay path. It
uses the existing `IArticleVaultOperationCheckpointStore.AppendAsync(identity,
plan, checkpoint, token)` solely for cancellation facts, after original
`ValidateAppend` checks. It adds no second store or article writer. Recovery
journal `StageAsync` requires its original resolution/proposal/backup association
and is not a generic cancellation API. The current canonical
`ReadThroughAsync` is an immutable historical-prefix read, not current-tip admission.
First execution without a persisted result therefore blocks with
`agent_current_operation_execution_admission_missing`. #2106 must supply an actual
current-operation compare/admit/execute handler serialized against canonical
cancellation before that path can execute new work. The host must supply its
trusted session bridge; this adapter does not register itself in DI or provision
service credentials in the local agent. It requires the server boundary's trusted
admin principal and refuses sealed bundles belonging to another principal.

Normal commands require this control owner's Running/no-rescan lifecycle and
matching lease receipt. The actual current factory remains Starting/rescan-required.
Observe-batch additionally needs native observation admission. Materialization
blocks with `agent_native_conditional_materializer_missing`: root-issued reads,
enumeration and operation temporary preparation are not a final conditional
replace/remove, complete metadata admission or atomic base commit. Accepted source
and immutable resolution proposals also grant none of those capabilities. No second
planner, snapshot/watcher, proposal store, operation store or materializer is added.

`LinuxVaultAgentControlSession` is an in-process lifecycle API for an actual
transferred native lease. It creates and owns the grant ledger, IPC endpoint and
lifecycle journal, exposes `InspectStatus`/`InspectInventory`, provides purpose-bound
`CreateCommandGrant`, and provides idempotent
`ShutdownAsync` for stop/logout/site-switch/unlink. Revocation precedes cleanup;
pending IPC reads are cancelled and drained before endpoint/lease disposal.
Unlink retains control/audit state. Any first cleanup failure preserves a blocked
receipt with a fixed stage-specific reason rather than reporting terminal
success. This scope creates no watcher, process, temporary source file or binary
installation. Its stopped/retained receipts describe only its owned local control
resources, not a complete installed agent or an install/update transport.

The resident lifecycle journal is the site/Vault digest plus `.agent-lifecycle`
inside the same fixed namespace. It requires an operator-provisioned current-user
0600 regular file; it does not create the file or alter persistent permissions.
An exclusive journal handle remains held through terminal receipt persistence,
including after the revoked writer lease closes. Records are hash-linked, bounded
to 16 KiB each and 1 MiB total, fsynced, and retain at most eight exact canonical
operation pointers. Those pointers include the original identity and named checkpoint
sequence/digest; operation transitions stay in #2106's existing store. Incomplete,
exhausted or uncertain writes block explicit recovery and are never truncated or
silently retried. Unlink retains this journal and user Markdown.

Registration is unusable if its pointer was not durably recorded. A new lease
generation retains prior pointers and starts rescan-required; it cannot restore a
persisted Running state or discard unfinished operations. Root manifest and full
control binding are recorded. Old-agent pointers are recovery evidence, not grants
for a new agent/session. A complete restart still requires actual root/source-tree,
watcher/rescan and canonical operation revalidation producers.

## Lifecycle contract and remaining producers

`ArticleVaultAgentLifecycle` models installed, starting, running, stopping,
stopped, updating, rollback-required, crashed, reconnecting, unlinking,
removed and retained-control-state. Its initial receipt is stopped and requires
runtime admission. Runtime receipts bind platform, binary identity, lease/IPC,
previous/new states and durable recovery references. Recovery requires root
manifest, current source tree, watcher watermark, rescan receipt and operation
receipt inventory digests; an in-memory watermark is insufficient. Events
during transitions are blocked with rescan-required semantics.

Failed updates retain the old binary digest and enter rollback-required. A
health fact cannot invent the new binary's runtime binding or clear recovery.
Unlink terminal states require a cleanup producer receipt and cannot restart.
These are contract assertions: serialized digests or a running state do not
constitute trust, native ownership, atomic update or rescan qualification.

`ArticleVaultAgentRescanBoundary.RecordRequiredRescan` consumes the exact
canonical #2112 tracker and records a bound obligation's digest. It stops or
retains blocked observation; `AwaitingNativeVerification` is never interpreted
as completed recovery. The native root-use and terminal rescan producers remain
required. These contract/control-session receipts do not yet provide durable
full-agent crash reconstruction or a signed installation/update producer.

Still required from actual owners are signed binary/package trust admission,
platform support/IPC integration, download/stage/atomic-switch/health/rollback,
owned process/watch/temp cleanup, #2112 complete rescan/recovery, and canonical
planner/execution/materialization/operation APIs. Windows/macOS implementations
and all independent runtime acceptance remain outstanding. No package mapper,
FsusUI syntax parser, snapshot/watcher, sync winner or product UI is duplicated.

Ordinary dispatch checks using the existing original project are:

```bash
dotnet restore tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --locked-mode
dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore -c Release --filter 'Category=ArticleVaultAgentDispatch'
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore -c Release --filter 'FullyQualifiedName~ArticleVaultAgentCanonicalOperationAdapterTests'
node --test tests/governance/article-vault-agent-control.test.mjs
node tools/governance/check-article-vault-agent-control.mjs
```

These unit/source checks provide no independent native QA clearance. The saved
environment has absent provisioned control state and unsupported overlayfs; its
earlier runtime failures remain unaccepted. No lease/kernel concurrency audit is
part of this dispatch increment. Contract/static passes cannot replace native
acceptance. Shared matrix,
lifecycle/coverage registries and generated authority bindings are integrated
by the overall owner, without concurrent edits from this source subchain.
