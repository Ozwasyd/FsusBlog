# Authoring extension capability and isolation boundary

The authoring extension manifest is a request declaration, not an authorization.
The host grants no document, selection, mutation, query, network, filesystem,
diagnostic, state, database, process, DOM, or host-private authority merely because
a manifest passed contract validation. This is an internal/experimental boundary;
it defines no HTTP endpoint, AEDS frame, browser contract, or stable
`src/shared/Contracts/` ABI.

## Closed capability requests

`AuthoringCapability` is the only request vocabulary. It distinguishes document
range read, full-document read, selection read, mutation request, article query,
exact brokered network destination, approved filesystem-root read or proposed
write, diagnostic report, and extension-state read/write. The capability array is
required even when empty. Empty is the default authority. Owning a command,
diagnostic, or trusted-adapter declaration does not imply full-document, network,
filesystem, or mutation access.

Unknown numeric values, duplicates, arrays larger than the closed registry,
wildcards, and broad names such as `editor`, `all`, or `trusted` cannot enter a
verified contract. Network destination, filesystem root and purpose are later
grant scope, not arbitrary strings carried by this manifest. Database, Redis,
repository, `IServiceProvider`, secrets, Cookie/JWT/Passkey material, and raw host
objects are not authoring capabilities.

## Declaration bounds and identity

Every contribution declares exactly one execution class and the matching closed
entrypoint format. The manifest cannot request a fallback class. Entrypoints are
bounded identities or package paths; URL schemes, parent traversal, control
characters, and code-like delimiters fail closed. Package, content, and entrypoint
digests use exact lowercase SHA-256 identities.

Resource declarations cover positive CPU time, wall time, memory, request/response
size, concurrency, queue, and object-depth bounds, plus explicit restart, network,
file, and state byte ceilings. A zero brokered-I/O ceiling declares no such budget;
negative or host-exceeding values fail closed. These values are included in the
contract identity. Runtime admission uses those exact ceilings and binds its queue
gate to the policy digest; policy drift cannot inherit another policy's capacity.

Linux runtime measurement is host-owned and reads only the owned sandbox process's
CPU, resident memory, and I/O counters. Brokered restart/network/file/state counters
enter the same measurement record. Missing or failed measurement is itself a
breach: no plugin result is accepted, the exact lifecycle generation is
quarantined, and core continuity is rechecked. Live breach cancellation and final
measurement are both required, so a process cannot continue merely because its
result would otherwise fit the response limit.

Telemetry contains only bounded identities, stable reason codes, counters, and a
timestamp. It excludes content, source text, document IDs as content, payloads,
credentials, and free-form exception text. Collection creates no export authority;
support bundles require a separate explicit approval. Durable telemetry storage and
real Linux pressure/escape/starvation evidence remain uncomposed acceptance
blockers rather than grounds for a simulated production claim.

The authoring registry also receives closed core command, route, property,
saved-view operator, and security-policy identity sets. It rejects duplicate core
identities and any extension/contribution collision with them. Registry schema and
enum values contribute to the registry identity, so a vocabulary change cannot
silently reuse an older contract identity.

## Package supply-chain isolation

A package manifest is trusted only after the archive digest and ECDSA signature
verify against the exact selected publisher key in the complete bounded keyset.
The keyset identity covers every publisher key, public-key digest, validity window,
and revocation time; adding, removing, rotating, expiring, or revoking a key changes
that identity. Package identity also covers the signature, trust result,
source/provenance references, manifest and contract identities, archive, payload,
content, entrypoint, and schema declarations.

Verification rechecks the trust interval and cancellation immediately before
returning the sealed package after archive reading and validation. Expiry at the
return boundary or a clock before the trust evaluation fails closed; the selected
key's future revocation still caps the trust interval.

Only opaque local approved-source identities enter the production composition.
PAT/bearer markers, URLs, query/fragment syntax, traversal, dynamic downloads,
post-install execution, and runtime self-update have no package authority. Staged
content is host-owned, content-addressed, and read-only after independent
verification. A fresh read rechecks archive and extracted-file digests rather than
trusting filesystem metadata.

Atomic activation does not grant a capability or execute a contribution. A schema
change remains fail-closed until the later migration owner exists. Failed health,
content, or receipt checks restore the previous verified package and never restore
revoked permissions, because permissions are outside this package authority.

## Hybrid resolver and in-process denial

Resolution first rechecks the exact active package identity. A copied, updated,
uninstalled, or content-drifted package cannot produce a ready target. Third-party
packages cannot select `TrustedHostAdapter`; unsupported Worker/Wasm or service
platforms do not fall back to trusted execution, a WebView, iframe, browser shim,
or a class chosen by the package.

Trusted descriptors are checked-in host records, not package payload. The resolver
matches contribution kind/ID, source digest, host API, platform, and the SHA-256 of
the already loaded assembly before returning a target. It never calls
`Assembly.Load`, reflection activation, dynamic import, `eval`, or an arbitrary
callback, and the target carries no editor reference, DOM node, Pinia store,
FsusUI-private instance, database/Redis/service object, or executable payload.

The production registry is empty until a real reviewed adapter artifact and owner
exist. Consequently no trusted adapter is currently ready, and simulated module
verification is not production evidence. This fail-closed absence is the remaining
terminal acceptance blocker for the concrete-adapter portion of this boundary; it
does not weaken Worker/Wasm or service class isolation.

## Worker/Wasm isolation

Third-party pure-compute modules execute only as verified Wasm in the Linux
bubblewrap runtime. The package cannot supply JavaScript, an assembly, a module
loader, imports, callbacks, or host object references. The Wasm ABI exchanges one
bounded byte payload through copied JSON/base64 frames; response identity and
schema references must exactly match the request.

The runner rejects imports, shared or unbounded memory, memory maxima above policy,
recursive workers, unknown globals, oversized frames, and memory ranges outside
the exported buffer. The OS profile unshares network/mount/PID/user namespaces,
clears the environment, drops capabilities, and binds only the runner, verified
module, Node executable, and runtime libraries read-only. No DOM, editor, Pinia,
FsusUI-private object, network, filesystem API, process API, database, Redis,
service object, `eval`, dynamic import, iframe, or WebView enters the module ABI.

Cancellation, deadline, crash, malformed result, or stale document terminates the
process tree and yields no committable response. Receipts hash document/request
identities and omit plaintext IDs, content, payloads, and secrets. Actual namespace
and escape probes remain part of the Linux runtime test and cannot be replaced by
the static source checks used during light-only development.

## Out-of-process service isolation

Service packages never receive host sockets, filesystem handles, credentials,
database/Redis objects, shell access, or generic URL/path APIs. A verified static
ELF runs in a private bounded bubblewrap/prlimit process tree. Its argv contains
only runtime/content/executable/transport/grant-set digests; environment and logs
contain no grant secret or payload credential. A closed readiness handshake must bind
the runtime, executable, and transport before any request is accepted.

Network grants name one DNS host, port, TLS requirement, purpose, byte ceiling, and
expiry. Two equal public address resolutions are pinned directly to the socket;
redirect, userinfo, fragment, arbitrary URL, private/metadata/loopback address,
rebinding, and oversized response are rejected. File grants name one allowlisted
non-control root, relative path, operation, purpose, byte ceiling, and expiry;
canonical containment, every reparse boundary, file type, and size are rechecked.
Writes remain opaque host-owned proposals until a later permission/RPC owner
accepts them.

Actual detached-child, namespace, DNS/TLS, and symlink probes are runtime evidence.
The light static checks in this stack do not replace those tests; until they run,
terminal process/network/filesystem isolation remains unverified.

## Exact grants and transactional document RPC

Capability issuance is default-deny and produces a digest-bound grant over the
request, runtime, extension/version, contribution/class, capability, document,
site, purpose, optional exact broker destination/root, approval receipt, and
bounded TTL. The authority recomputes the stored grant digest on every use, so a
changed version, class, site, document, purpose, scope, schema-derived runtime
identity, expiry, revocation, or stored-field tamper cannot reuse the grant.
`all` purposes and broad or mixed I/O scopes are rejected. Full-document consent
also binds the exact epoch, revision, and snapshot digest; those fields are
forbidden on grants that do not request full-document content.

The RPC envelope carries only immutable closed DTOs. Mutation requests require an
explicit preview approval and exact snapshot/revision/selection identity. The host
rejects overlapping or invalid ranges, executable markup, stale revisions,
alternate-method bypasses, duplicate request IDs, and transaction receipts whose
plan, document, revision, history, selection, dirty flag, or canonical digest is
inconsistent. Receipt records contain references and digests, not document text,
state bytes, credentials, or secret payloads.

This source boundary does not itself authorize a concrete editor adapter or
consent surface. The required FsusUI consent/document-owner artifacts are separate
dependencies. Reserved read/query/broker/diagnostic/state method enum values have
no implicit handler or fallback authority; absent a reviewed production owner they
remain unavailable. This is intentionally not an HTTP, AEDS, browser, or shared
stable ABI.

## Persistent grant facts

`LocalAuthoringCapabilityGrantStore` implements the existing lifecycle catalog and
RPC grant/read-scope ports over one protected local snapshot. It stores only
already approved records; constructing it, importing a record, or finding a
manifest creates no consent decision or production host registration. A future
composition must supply the existing Data Protection provider, a private owned
root, the clock, and the same store owner to both RPC and lifecycle consumers.
It provides no typed broker I/O approval scope; broker operations still refuse
without that separate approved owner.

Queries revalidate the closed state and every grant digest, compare exact ordinal
coordinates, and omit revoked, expired and not-yet-issued records. Extension and
runtime revocation update that same fact set atomically. Revoked grant identities,
including an explicit revoke before a late store, cannot be imported again.
The 4096-entry and 16 MiB bounds include tombstones; exhaustion refuses new facts
rather than evicting revocation evidence. A missing initialized snapshot or missing
ownership lock requires recovery, never an empty reconstructed grant catalog.

The existing native regular-file guard limits this implementation to Linux x64
and arm64, rejecting unavailable file identity owners. One non-thread-affine gate
and exclusive cross-instance file lock remain held by the original read scope
until disposal, so cooperative instances and processes refuse replacement or
revocation while publication owns it. State bytes are protected under a dedicated
Data Protection purpose bound to the canonical root; malformed, duplicate,
unknown, corrupt or wrong-key state fails closed. Writes flush a private temporary
file before atomic replacement. Tests use synthetic grants and private test keys,
including a fresh process and a process that encounters a held read scope.

This is normal same-root/key process restart persistence, not cross-node exclusion,
power-loss durability, consent issuer qualification, or rollback-resistant storage.
The snapshot generation is not an independent monotonic security anchor: restoring
an old complete authenticated filesystem backup requires the separate recovery
and revocation authority, and must not be treated as permission restoration.
No StateStore, ReceiptStore, coordinator, migration or shared DI composition is
introduced by this local grant owner.

## Command invocation isolation

Command metadata is data, not executable UI authority. The signed closed record
may request only known context facts, capabilities, surfaces, schemas, and one
bounded shortcut chord. FsusBlog resolves shortcut conflicts without replacing a
core or user binding and exposes the same state to every FsusUI command surface.
An extension cannot install a global keyboard listener, receive a DOM/editor
object, splice source text, or choose an undeclared execution class.

Execution rechecks an exact active grant set for the command version, runtime,
class, contribution, and document before and after the isolated call. Revocation
or grant-identity replacement while work is pending makes the result stale. The
frontend independently binds lifecycle generation, document epoch/ID, revision,
selection, request, package/content/runtime, and schemas before it sends one
canonical FsusUI transaction. Any abort, permission change, document switch,
selection/revision drift, malformed range, oversized result, or CAS rejection
commits nothing.

The browser projection has no ambient network, package-loading, or host bridge
authority. Online/extension-enabled values must arrive as closed host facts, and
their presence alone grants nothing. The current production route deliberately
receives no command feed until a reviewed internal owner exists; the fixture and
test executor are evidence for consumer behavior only, not a production adapter
or permission boundary.

## Lifecycle revocation and state ownership

Lifecycle receipts are closed, monotonically sequenced, generation-bound, and
hash chained. Disable, update, rollback, and uninstall address the exact active
generation; a delayed old-generation revoke cannot remove newer resources.
Workers and service processes enter the active set before use and are released by
reference, while a concurrent revoke owns termination and disposal after removing
the same reference. Termination failure remains a non-empty resource report even
if disposal succeeds, so the lifecycle cannot publish a false disabled state.

State scope includes extension/version, site, user, optional document, and schema.
Migration requires equal site/user/document coordinates and exact old/new versions
and schema declarations. Only rename-key, delete-extension-key, and set-default
transforms exist; record, byte, transform-count, and duration ceilings are
mandatory. Uninstall does not imply deletion. A separate retained-data approval
binds package, scope, record count, byte count, and approval receipt before the
extension-owned state authority may delete anything.

This stage has no automatic self-enable/update, compatibility shim, package scan,
or command/UI registration. The generic host-resource port is deliberately
uncomposed until a production owner can atomically revoke registrations, RPC,
grants, jobs, and surfaces and persist lifecycle/state evidence. The in-memory
test doubles prove state-machine behavior only; they are not restart or production
recovery evidence.

## Stage boundary

The current stages validate the contract and package supply chain, resolve fixed
execution classes, can run verified Wasm in the isolated Linux worker, and define
one exact grant and transactional mutation authority. They can run an owned Linux
service, enforce already-issued opaque network/file grants, and apply host-owned
runtime measurement plus generation-bound quarantine. Production grant/lifecycle/
telemetry persistence, consent UI, canonical document composition, support-bundle
authorization, the other reserved RPC handlers, and real pressure/starvation
evidence remain unavailable. The local protected grant store above is an
uncomposed source implementation, not production consent or host activation. Each later child must recheck the verified package
identity and implement its own fail-closed acceptance before any additional
operation can occur.

The canonical terminal matrix is
`config/testing/authoring-extension-terminal-matrix.json`; its single local/CI
command is `node tools/security/check-authoring-extension-terminal-matrix.mjs`.
Audit mode verifies registry and fixture ownership while reporting external
blockers. Diagnostic catalog overrides must equal the checker checkout's canonical
source-owned inventory. Terminal acceptance requires independently verified
current-run producer evidence for every domain; its original domain/CI receipt
join remains unregistered. Current evidence mode checks declared artifact bytes
but always refuses accepted-receipt creation, including complete synthetic sets;
artifact status and hashes alone are not execution, freshness, or source binding.
Missing, unknown, failed, or hash-tampered evidence also remains rejected. Synthetic verifier tests exercise
only that fail-closed machinery and are never runtime, browser, platform, or
core-editor evidence. CI receipt-join registration remains blocked until those
producers and their current-run artifact paths exist.

The general [plugin sandbox](plugin-sandbox.md) continues to own `.fspkg` Hook
execution through its Level 1 Jint/Lua application sandbox. Neither subsystem may
reuse the other's manifest, capability registry, package store, identity, grant,
lifecycle, or fallback authority implicitly.
