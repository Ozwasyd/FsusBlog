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
contract identity. This stage validates requested ceilings only; later runtime
stages own measurement, cancellation, quarantine, and telemetry.

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

## Stage boundary

The current stages validate the contract and package supply chain, resolve fixed
execution classes, can run verified Wasm in the isolated Linux worker, and define
one exact grant and transactional mutation authority. They can run an owned Linux
service and enforce already-issued opaque network/file grants. Production grant
persistence, consent UI, canonical document composition, the other reserved RPC
handlers, data migration, and runtime lifecycle state remain unavailable. Each later
child must recheck the verified package identity and implement its own fail-closed
acceptance before any additional operation can occur.

The general [plugin sandbox](plugin-sandbox.md) continues to own `.fspkg` Hook
execution through its Level 1 Jint/Lua application sandbox. Neither subsystem may
reuse the other's manifest, capability registry, package store, identity, grant,
lifecycle, or fallback authority implicitly.
