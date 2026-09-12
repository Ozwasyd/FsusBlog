# Authoring extension host boundary

The authoring extension host is an internal and experimental subsystem for bounded
authoring extensions. It is separate from the general `.fspkg` Hook and Jint/Lua
plugin system. The C# declarations under
`src/backend/Infrastructure/AuthoringExtensions/` are implementation contracts,
not a stable shared ABI. This boundary adds no HTTP route, AEDS frame, browser API,
or `src/shared/Contracts/` authority.

## Closed contract registry

`AuthoringExtensionManifest` schema version 1 is the only authoring-extension
manifest shape. It declares the extension and publisher identities, numeric
version, package/content digests, signature/trust references, host API range,
supported platforms, contribution declarations, resource limits, entrypoint
identities, state/data schema versions, and update/migration/uninstall policies.
Every JSON object has an exact required field set; missing, duplicate, unknown, or
implicit fields fail closed. Manifest bytes, object depth, identifiers,
contribution count, capability count, entrypoint text, and every resource value are
bounded before a contract is accepted.

`AuthoringContributionKind`, `AuthoringCapability`, `AuthoringExecutionClass`, and
the related policy enums are the sole closed registries. A contribution contains
one enum-valued kind, one enum-valued execution class, one matching entrypoint
format, and an explicitly empty or exact capability array. There is no generic
registration method, free-form contribution type, executable object payload,
dynamic import URL, code string, wildcard capability, or execution fallback.

The three execution declarations reserve the parent architecture mapping without
installing or invoking a runtime:

- `TrustedHostAdapter` identifies a future host-owned checked-in adapter;
- `IsolatedWorkerWasm` identifies a future verified worker/Wasm module;
- `OutOfProcessService` identifies a future verified owned-service executable.

The declaration cannot change execution class at runtime. Resolver, sandbox,
service broker, RPC, permission, lifecycle, budget enforcement, and concrete
contribution behavior belong to later child boundaries; these enum values are not
evidence that any such runtime is active.

## Identity and core non-overlap

Contract identity hashes the canonical manifest together with the schema, host API,
and closed-registry identity. Changes to fields, versions, digests, enum IDs, or
policies therefore create a different contract identity for later permission,
cache, lifecycle, and runtime consumers.

`CreateRegistry` revalidates every supplied contract, rejects stale or tampered
contract identities, and publishes an immutable deterministic snapshot. Extension
and contribution IDs are unique across that complete snapshot. The caller must
also provide the exact host-owned command, route, property, saved-view operator,
and security-policy authority IDs; collisions across any extension or core
authority fail closed. This registry validates contracts only. It does not install,
persist, grant, activate, dispatch, or execute an extension.

## Verified package and atomic version switch

An authoring package enters production composition only through an exact opaque
`approved-source/` catalog reference. The verifier binds the signed archive,
manifest, complete publisher keyset identity, trust status, source/provenance
references, package/content/entrypoint digests, and contract identity into one
content-addressed package identity. Unknown, unsigned, untrusted, revoked, expired,
malformed, incompatible, or tampered inputs fail before staging. Package paths are
relative and bounded; traversal, links/reparse points, duplicate paths, directory
entries, remote URLs/imports, post-install scripts, and undeclared entrypoints are
rejected.

`LocalAuthoringPackageStore` is the single activation/recovery authority. It writes
an independently reverified package to a private staging directory, verifies the
stored archive and extracted files, atomically renames the content-addressed
directory, and makes it read-only. Activation uses an atomic generation-bound
pointer and retains the previous package until the new pointer, integrity/health
probe, and append-only receipt succeed. Any switch, probe, content, or receipt
failure restores the exact old pointer (or deactivates a failed first install) and
removes only the failed candidate.

Schema-stable updates are the only package updates admitted at this stage. A state
or data schema change records `schema-migration-required` without staging or
switching; the later bounded lifecycle/migration owner must authorize such a
transition. Downgrades, replays, same-version/different-content collisions, and
publisher changes are likewise rejected and receipted. Key rotation is accepted
only when the candidate verifies under the current complete publisher keyset.
Fresh-process recovery independently verifies the archive, extracted content,
activation pointer, health result, and latest extension receipt before accepting an
active package.

Package receipts are closed, bounded, append-only, and hash chained across all
extensions. They record the operation/outcome, current and previous identities,
trust/keyset result, content digests, and stable failure code without storing a
secret. Stored package metadata, activation pointers, and receipts reject missing,
duplicate, or unknown fields before their digests are accepted.

## Hybrid execution resolution

`AuthoringExecutionResolver` consumes only an exact package that the package-store
authority still reports active. It never changes a manifest's execution class.
Worker/Wasm and owned-service declarations return only their fixed closed target;
unsupported platform/class combinations return a stable blocked result without an
in-process or compatibility fallback. The runtime identity covers the active
package, extension/version/content, contribution kind and class, entrypoint digest,
host API version, and trusted-adapter identity when applicable.

A trusted adapter descriptor is bounded and names one `fsusblog.authoring.adapter.*`
identity, contribution kind, host API version, checked-in `src/backend/` source and
digest, loaded assembly name and digest, review owner, and exact supported-platform
set. Descriptor fields and platform support enter the trusted-adapter identity.
Only a package whose publisher is exactly `fsusblog` may resolve that class, and a
real loaded-module verifier hashes the already loaded assembly file without loading
package code. Missing, ambiguous, NativeAOT/location-less, reparse, oversized, or
digest-mismatched modules remain blocked.

The current production composition deliberately uses an empty trusted-adapter
registry. No concrete FsusUI bridge or other in-process authoring adapter is
authorized by these host-core contracts. Adding one requires a separately reviewed
checked-in source artifact, exact source/module digests, review ownership, public
host API mapping, and proof tests; a fake verifier or package-provided module cannot
stand in for that evidence. Resolution itself does not start a worker/service,
invoke adapter logic, grant a capability, expose RPC, or mutate a document.

## Isolated Worker/Wasm runtime

`AuthoringExtensionWorkerSandbox` consumes only a ready
`IsolatedWorkerWasm` target whose package, version, contribution kind, and exact
entrypoint still match the verified package. Each launch has a separate instance
identity over the resolver identity, document epoch/revision, request identity,
host API, request/result schemas, and policy digest. Request and response byte
ceilings remain distinct; results are accepted only while the document revision is
current.

The Linux implementation executes the verified module under bubblewrap with fresh
mount, network, PID, and user namespaces, a cleared environment, no capabilities,
read-only module/runner/runtime binds, and no Wasm imports. Before compilation it
requires exactly one unshared memory with a declared maximum no larger than the
manifest budget; memory growth and result bounds are rechecked after execution.
Timeout, cancellation, trap, malformed output, and stale revision terminate the
owned process tree. Its closed receipt records only identities, digests, limits,
sizes, status, and stable reason, never document/request IDs or payload bytes.

This sandbox does not expose RPC, permissions, services, extension lifecycle, or a
concrete contribution. Lifecycle-owned update/revoke invalidation is layered later;
the runtime itself creates no cross-plugin or cross-document cache.

## Out-of-process service boundary

The Linux service runtime accepts only an exact verified static x86-64 ELF target.
It combines `prlimit` memory/CPU/file-descriptor ceilings with a new bubblewrap
mount, network, PID, and user namespace, an owned session, cleared environment,
dropped capabilities, a private temporary root, and one read-only executable.
Readiness is a closed identity/digest/transport handshake, not process liveness or
an open port. Cancellation, deadline, malformed response, crash, and stale document
terminate the complete process tree; the production test includes a child that
creates a new session and ignores `SIGHUP` to verify the host boundary catches it.

The process receives only opaque, short-lived grant IDs. Network access stays in a
host broker that resolves twice, rejects private/metadata/loopback destinations,
pins the accepted IP set, requires TLS, disables redirects/cookies/decompression,
and applies purpose/time/byte bounds. File access stays in a host broker that
requires an allowlisted exact root and relative path, rejects control roots and
reparse boundaries, reads only bounded regular files, and stages proposed writes
under a private non-reparse host root for later approval. This stage defines no
document RPC, permission decision, lifecycle, or concrete provider.

## Versioned RPC and canonical mutation boundary

All execution classes share the internal schema-version-1 RPC envelope. The
envelope binds runtime, extension/version, package/content, contribution/class,
request, document epoch/revision/snapshot, host API/schema/policy/grant, deadline,
site, and purpose identities. Its method and payload vocabularies are closed and
bounded; unknown methods, multiple payload variants, malformed digests, expired
requests, or unbound identity fields fail closed. These immutable value records do
not expose a live editor, DOM, Vue/Pinia state, service provider, database object,
callback, or direct source replacement authority.

The implemented host operation is the mutation path: a plugin returns a bounded
insert/replace/delete plan, the host rechecks its exact grant, document snapshot,
revision, non-overlapping ranges, approval and preview receipt, then delegates once
to `IAuthoringCanonicalDocumentTransaction`. Duplicate request IDs, stale plans,
nearest-match application, automatic rebasing, executable markup, and tampered
transaction receipts are rejected. Full-document grants additionally bind one
exact document epoch, revision, and snapshot digest; other grants cannot smuggle a
destination, root, or revision scope.

The registry reserves the remaining read/query/broker/diagnostic/state method
identities, but this stage does not invent production handlers for them. In
particular it does not create a browser, HTTP, or AEDS bridge. A real canonical
document transaction owner and the machine-driven consent UI remain external
dependencies; until those reviewed artifacts are composed, the RPC authority is
fail-closed and this issue remains a Draft/Refs delivery rather than production
activation evidence.

## Command contribution and editor projection

The internal `authoring/commands.v1.json` package entry is the only command
contribution source. It must match every declared `Command` or
`CommandPaletteMetadata` contribution exactly and binds command, extension,
version, package/content/runtime, execution class, localization references,
closed `when` conditions, requested capabilities, input/result schemas,
preferred surfaces, and shortcut request. Unknown JSON members, duplicate
properties or identities, core command collisions, and registries above 1000
commands fail before activation.

FsusBlog projects that closed record into the public FsusUI command contract.
Toolbar, selection toolbar, slash menu, and command palette consume the same
command object and therefore the same visible/enabled/pending/error state; Blog
does not maintain a second editor command registry. Dynamic selection,
writability, and source-mode facts come from the FsusUI command context. Online
and extension-enabled facts are explicit host projection fields rather than
ambient browser inference.

Invocation binds the package/runtime identity, lifecycle generation, exact
document identity and epoch, source revision, selection identity, request, and
required capabilities. Permission, lifecycle, document, revision, selection, or
result-identity drift aborts or rejects the result. The only accepted document
change is a bounded transaction submitted through the public FsusUI dispatcher
with `expectedRevision`; direct source, DOM, or nearest-revision mutation is not
an alternative.

The ManageWriteArticle prop path and production-component fixture exercise this
consumer boundary, including four-surface discovery, state transitions, aborts,
mobile reachability, and the 1000-command bound. They do not create a production
host-to-browser feed. Until a separately authorized internal projection owner
and active worker/service runtime owner are composed, the real route has no
extension commands and this slice remains Draft/Refs rather than production
activation evidence. No HTTP, AEDS, or second editor authority may be added to
fill that gap implicitly.

## Closed lifecycle and generation ownership

The lifecycle coordinator is the sole internal state machine for install/enable,
permission-pending, start/run, disable, update/migrate/rollback, failure,
uninstall, retained data, and separately approved removal. Every transition is a
closed enum edge and advances a hash-chained receipt generation. Restore reads the
latest receipt authority; it never scans package directories, timestamps, or a
last-active marker to infer enabled state.

Activation is all-or-nothing across the complete verified target set. Worker and
service instances are registered against the exact active generation. A stale
generation cannot register or revoke a newer instance; health transitions rebind
the existing resources before publishing their new receipt generation. Release
and revoke remove one reference under the same lock, so their race has exactly one
disposal owner. If the final `Running` receipt cannot be appended, the coordinator
first revokes the newly activated generation, then records the closed failure and
rolls state back. Late results are accepted only for the current `Running`
generation.

Migration plans bind old/new extension versions, site, user, optional document,
schema versions, transform registry, record/byte/time ceilings, backup and rollback
references, and content digest. The transform vocabulary cannot execute arbitrary
database, filesystem, or network code. Uninstall first revokes registrations,
RPC/jobs/surfaces, grants, workers, and services, then retains extension-owned
state by default. Data deletion is a separate exact approval whose measured scope
must still match; core documents, history, assets, and another extension's state
are outside that authority.

This commit defines the generic lifecycle/resource interfaces and orchestration;
it does not register a command contribution or a second editor authority. Durable
production receipt/state/grant stores and a real host registration owner are still
required before restart recovery or atomic data deletion can be claimed as
terminal acceptance.

## Resource budgets, crash isolation, and telemetry

Every runtime operation is admitted against the exact resource policy from its
verified manifest: CPU and wall time, resident memory, request and response bytes,
concurrency and queue depth, restart count, and brokered network, file, and state
bytes. The gate is bound to the runtime and policy digest; another policy cannot
reuse an existing gate. There is no unlimited default, background retry, or
best-effort measurement mode. A missing measurement authority fails before the
operation and quarantines that lifecycle generation.

Linux worker and service processes expose their owned sandbox PID only to the
host measurement wrapper. The wrapper registers that PID with the `/proc`
measurement authority and freezes its last observation on disposal. CPU, resident
memory, and process I/O are sampled during execution; the broker ledger contributes
restart and network/file/state usage. Crossing a live ceiling cancels execution,
discards the result, revokes the exact generation through lifecycle resources, and
requires an explicit quarantine-clear approval before reactivation. A runtime
crash follows the same containment path, and the host rechecks core continuity
before returning a closed result.

Budget telemetry is a closed metadata record over runtime/package/contribution,
policy, lifecycle generation, stable reason, elapsed/resource counters, and time.
It has no payload, source text, document contents, credential, grant secret, or
free-text failure field. This internal record is not a support bundle or export
permission. Durable content-addressed telemetry storage, explicitly authorized
support-bundle export, and real Linux pressure/starvation evidence remain external
production blockers; static and unit coverage cannot substitute for them.

## Terminal security matrix

`config/testing/authoring-extension-terminal-matrix.json` is the canonical
test-only inventory for the Hybrid host chain. Its checker extracts every closed
manifest/resource field and contribution, capability, execution, platform,
entrypoint, RPC, lifecycle, migration, uninstall, and budget registry directly
from the implementation and binds each registry to one positive, negative, and
owner fixture. Registry drift, a missing suite, an unknown evidence item, a
non-passing artifact, or an artifact digest mismatch fails closed.

The checker can emit a terminal receipt only from the complete current-run
artifact set. That receipt binds the catalog, checker, sources, suites, per-domain
evidence digests, zero warnings, and its own digest. The ordinary audit currently
declares the unresolved trusted-adapter, Linux runtime/broker/pressure, canonical
document/consent, durable lifecycle, browser/Avalonia, and rendered core-editor
evidence as blockers. A checker self-test or source-ready stage cannot convert
those blockers into terminal acceptance. The canonical CI receipt join is also
unregistered and remains an explicit blocker rather than an audit-mode pass.

## Stability and rollback

The contract, package store, and RPC are currently internal/experimental and may change only by advancing
its closed schema or registry version and updating its validators and tests in the
same change. Unsupported host API ranges, platforms, entrypoint mappings, versions,
or registry identities remain rejected; compatibility never falls back to the
generic plugin system or a less isolated class. Package rollback restores the last
verified pointer and retains content-addressed evidence; it does not activate a
runtime or restore any permission.
