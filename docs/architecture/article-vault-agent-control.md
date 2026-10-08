# Article Vault agent control boundary

This document describes the lease and closed IPC source for issues
[#2113](https://github.com/Ozwasyd/FsusBlog/issues/2113) and
[#2114](https://github.com/Ozwasyd/FsusBlog/issues/2114). It does not certify a
running filesystem agent. The lifecycle implementation currently reduces
versioned contract facts; it does not install a signed package, atomically
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

Local request admission is not execution. No business dispatcher, snapshot,
watcher, planner, server writer or materializer is implemented in these files.
The future host must consume the real producer APIs and send bound result
receipts. It must revoke the ledger on logout/site switch/unlink, stop its
owned work and dispose endpoint/lease in that order.

`LinuxVaultAgentControlSession` is an in-process lifecycle API for an actual
transferred native lease. It creates and owns the grant ledger and IPC endpoint,
exposes `InspectStatus`, issues only status grants and provides idempotent
`ShutdownAsync` for stop/logout/site-switch/unlink. Revocation precedes cleanup;
pending IPC reads are cancelled and drained before endpoint/lease disposal.
Unlink retains control/audit state. Any first cleanup failure preserves a blocked
receipt with a fixed stage-specific reason rather than reporting terminal
success. This scope creates no watcher, process, temporary source file or binary
installation. Its stopped/retained receipts describe only its owned local control
resources, not a complete installed agent or an install/update transport.

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

Focused commands using the existing original project are:

```bash
dotnet restore tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --locked-mode
dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore -c Release --filter 'Category=ArticleVaultLeaseProtocol|Category=ArticleVaultAgentLifecycle|Category=LinuxArticleVaultLeaseIpcRuntime'
node --test tests/governance/article-vault-agent-control.test.mjs
node tools/governance/check-article-vault-agent-control.mjs
```

The native test requires the real operator-provisioned control namespace. Its
missing gate is a test failure, never an automatic pass, skip, fake device or
substituted endpoint. Contract/static passes cannot replace it. Shared matrix,
lifecycle/coverage registries and generated authority bindings are integrated
by the overall owner, without concurrent edits from this source subchain.
