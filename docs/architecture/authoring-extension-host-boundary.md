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

Manifest identity, signature/trust reference, digest and numeric version patterns
require the exact input end; a terminal newline cannot be hidden by a regex line-end
anchor. Both typed and JSON admission retain the same closed kind and host API checks.

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

`EcdsaAuthoringPackageTrustVerifier` limits a trusted decision to the earlier of
the selected key's validity end and its already-recorded revocation time; at that
revocation time the existing revoked-key rejection applies.

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

The broker rechecks caller cancellation and the exclusive request deadline after
the service returns and after the document revision gate returns, including
non-cooperative successful returns. The revision gate receives the same linked
deadline token as the service execution. Expired or cancelled results carry no
response; the broker awaits complete owned-tree termination with a non-cancelable
cleanup token before releasing lifecycle ownership or returning the rejection.

The process receives only opaque, short-lived grant IDs. Network access stays in a
host broker that resolves twice, rejects private/metadata/loopback destinations,
pins the accepted IP set, requires TLS, disables redirects/cookies/decompression,
and applies purpose/time/byte bounds. File access stays in a host broker that
requires an allowlisted exact root and relative path, rejects control roots and
reparse boundaries, reads only bounded regular files, and stages proposed writes
under a private non-reparse host root for later approval. This stage defines no
document RPC, permission decision, lifecycle, or concrete provider.

The proposed-write stage keeps its deterministic identity and exclusive
`CreateNew` operation. A create collision cannot delete an existing artifact;
only a successfully created file enters this invocation's failure cleanup.
Write, awaited release, and permission setup failures retain the first cause and
record secondary cleanup failures internally without publishing a stage receipt.
This local create ledger is not a native inode/rename exclusion lease and does
not establish concurrent filesystem custody.

## Versioned RPC and canonical mutation boundary

All execution classes share the internal RPC envelope. Existing read/mutation
operations retain schema version 1; the closed broker proposals below require
version 2 and do not admit a legacy broker payload. The
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

The mutation preview's version-1 content binding is produced only by
`AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest`: length-framed
UTF-16 code units and little-endian integers bind the complete ordered plan and
its RPC host identities, grant and deadline. The host captures its own bounded
mutation array before the first authority await, checks the approved digest, and
rechecks that owned content after revision observation, then preserves the final
grant, deadline and cancellation checks before consuming the request. Same plan
IDs cannot authorize changed text, ranges, selection or order.
This digest is not a signature, approval issuer or grant: computing it does not
set `Approved`, establish consent, or validate a real preview interaction. The
confirmation owner must bind the same material to its actual approved preview;
the source fixtures prove content binding only, not that external integration.

The three registered document read methods now have a bounded internal typed
handler. Their existing version-1 envelope and single `DocumentRange` payload
field are unchanged: range, current selection, or the exact whole-document span
is requested explicitly. No RPC method, payload field, public wire schema or
registry version is added. The handler reuses the sole manifest validator's
owned capability snapshot, declared request/response/depth budgets, active-package
execution resolver and exact grant authority. Full-document reads require both
the declared full-document capability and its existing explicitly approved,
epoch/revision/snapshot-bound grant; a range or selection grant cannot return a
nonempty whole-document span.

Only the same canonical transaction instance may implement the optional read
port. It supplies an immutable `AuthoringDocumentSnapshot`, total document length
and actual current selection, then performs a final non-yielding live observation
and invocation check after the resolver/revision/grant awaits. This is not
permission inferred from two caller-editable DTOs. Wrong ranges, overbroad values,
revision/digest/selection drift, revocation, expired deadlines and cancellation
are rejected. The value return alone contains the exact requested text; its
completion is protected by short-lived exclusion scopes of the original active
package store and original grant store, acquired in that fixed order and released
in reverse order. `LocalAuthoringPackageStore` prepares its scope asynchronously
under the original non-thread-bound semaphore and cross-instance mutation file
lock. It rereads the actual activation pointer, independently verifies the actual
archive/signature/manifest/trust and extracted content, then rereads the pointer;
no previously returned verified record is used as cached authorization. This
read lifetime accepts only the existing immutable local publisher keyset and the
original ECDSA/archive verification owners; an unknown mutable trust owner has no
held-lifetime port and remains blocked. Synchronous store acquisition does not
skip this verification. All existing stage/activation/deactivation/removal/recovery
writers retain the same locks. The grant scope is acquired after this last
preparation await. Both stores refuse a busy scope
acquisition rather than wait without a bound, and prevent deactivation,
replacement, trust changes and revocation for the held lifetime. No `GetActive`,
`Find` or further await is allowed during terminal publication; the same canonical document owner
performs its final non-yielding live check inside both scopes. Deadline, current
package trust validity and grant expiry are independently checked at publication
using the original clock. Scope cleanup releases both owners without replacing
a primary failure; secondary failures are non-wire diagnostics, not authority.
These optional owner interfaces do not alter the existing version-1 envelope or
registry. Existing stores without an actual exclusion-scope implementation refuse
read completion; a record-only lease or a caller callback is not an implementation.
The original mutable fixture scopes are explicitly source-level component
simulation, not production store or consent qualification. The read value's
metadata receipt contains identities, range, sizes and digests but no text or
secret. Its returned-value digest binds document/epoch/revision/snapshot/range and
the exact text with the existing framed UTF-16 producer under the internal
`fsusblog.authoring-document-read-value.v1` domain; it is content binding, not a
permission, consent issuer or independently qualified authority. Declared response
bounds include the serialized value metadata and JSON
string escaping, counted in bounded scratch chunks without a second document-size
copy. That internal size measurement is not a JSON public transport or fallback.

The source component does not create a production canonical document reader or
consent issuer. The separate `LocalAuthoringCapabilityGrantStore` implements the
existing RPC read-scope and lifecycle catalog ports over one protected local fact
set, with exact queries, persistent revocation tombstones and held cross-process
exclusion. Its Linux file-identity, initialization, byte/count and recovery limits
are defined by the [grant security boundary](../security/authoring-extension-capability-isolation.md#persistent-grant-facts).
It remains uncomposed and supplies no broker I/O approval scope. The persistent
package scope does not create a grant store, a consent policy, a production RPC registration or
a document reader. A missing canonical read port, original resolver or either
original store exclusion port is blocked;
simulated public-handler controls are not actual consent, browser or native
acceptance. Query/diagnostic/state method identities remain reserved without
production RPC handlers. In particular this does not create a browser, HTTP, or
AEDS bridge. A real canonical
document transaction owner and the machine-driven consent UI remain external
dependencies; until those reviewed artifacts are composed, the RPC authority is
fail-closed and this issue remains a Draft/Refs delivery rather than production
activation evidence.

The two broker methods have an internal version-2 typed handler. Network input
contains only host, port and a bounded path-and-query; file input contains only
relative path, the original closed read/propose-write operation and explicitly
bounded proposed bytes. These are caller proposals, not grants. The same
original capability grant store must provide an approved broker exclusion scope
whose existing network/file grant binds the original consent's destination/root,
runtime, purpose, expiry and byte limits. The broker scope must be thread-independent
because it holds revocation/replacement exclusion across the IO await.
Missing production consent/store scopes, resolver or actual IO broker refuse;
there is no caller-grant DTO, URL/filesystem fallback or new approval issuer.

The handler reuses the original manifest validator, active package resolver,
revision gate, deadline/cancellation checks and request-ID owner. It prepares
the original package scope through the same installed authority and store, then
rechecks the original grant, revision, deadline and cancellation after preparation
before consuming the request ID and calling `AuthoringExtensionServiceIoBroker`.
Broker IO requires the host-owned `IAuthoringInstalledPackageAsyncReadScope`
lifetime contract; an unknown or default synchronous scope is refused, not wrapped
or upgraded by its async method name. This type is an implementation obligation,
not an approval issuer, caller field or runtime proof. The actual persistent
owner holds its original semaphore and mutation file lock without thread affinity.
The package-then-grant exclusion lifetimes both remain held until the actual IO
promise settles, then release in reverse order. Cleanup cannot leave that promise
unobserved or replace its first failure, and a completed stage stays available
to the original refusal cleanup path.
Its original DNS/TLS/path/root and
operation validators still decide admission. Manifest limits can only narrow an
approved IO grant, never grant permission. After IO the handler rechecks package,
grant and document revision; it independently prepares the same terminal package
scope, rechecks admission after preparation, then acquires the grant scope with no
subsequent await, and rejects a changed approved IO scope or an
expired authority. Receipt metadata includes RPC context and proposal/value
digests but excludes the path/query, proposed bytes and returned value. A write
is only staged for later host approval, never applied to the destination or to
the canonical document. Refused staged returns invoke the same broker's owned
revocation path; cleanup failure preserves the primary refusal and reports an
unverified diagnostic, not successful removal. Source component simulations do
not prove production consent, broker execution, native cleanup or transport
integration; those acceptance gates remain pending.

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
result-identity drift aborts or rejects the result.

The command coordinator rechecks caller cancellation and its registered business
clock before timeout admission, after asynchronous admission callbacks, and after
copying the accepted result. Reaching the exact deadline rejects execution or
publication; callback completion cannot extend the original operation budget.

The only accepted document
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

The generic lifecycle/resource interfaces and orchestration do not register a
command contribution or a second editor authority. Production receipt/grant
stores, fenced state-store composition, and a real host registration owner remain
required before restart recovery or atomic lifecycle/data deletion can be claimed
as terminal acceptance.

`PostgresAuthoringExtensionStateStore` supplies the state persistence leaf through
the existing scoped `ISqlSugarClient`. Its proposed schema is
`AuthoringExtensionStateStorageSchema.CreateTablesSql`; constructors and requests
never create tables. The parent migration owner must register that schema in the
current migration/inventory authority before production DI activation. This leaf
does not configure another database or modify the lifecycle/receipt/grant owners.

The host-only `IAuthoringFencedExtensionStateStore` contract requires a verified
package and exact extension/version/site/user/optional-document/schema scope.
The host remains responsible for caller authorization, current package trust and
lifecycle admission. A scope is created only by explicit initialization; reads
of an unknown scope or a different package identity fail. Writes use expected
revision CAS. Keys compare ordinally, are unique and bounded to 256 UTF-16 code
units; identifiers reject controls and surrogate code units. Values are opaque
bytes, at most 1 MiB each; one scope holds at most 4096 keys and 16 MiB of values.
Null document identity is a distinct scope, never a wildcard.

State snapshot and fenced migration contract version 1 use compact UTF-8 JSON
with camel-case property names in record declaration order, enum strings in
camel case, System.Text.Json's default escaping and immutable byte-array
encoding. Snapshot entries sort by ordinal key; transforms preserve declared
order. A snapshot digest is lowercase SHA-256 of that snapshot with an empty
`ContentSha256`. The new fenced migration digest similarly binds its complete
record with an empty digest, including the source snapshot digest, exact scopes,
both expected revisions, budgets, transforms, and backup/rollback references.
Persisted snapshots must match their digest and canonical reserialization bytes;
the caller's complete canonical plan digest must match the persisted journal. These
hashes detect content/identity drift; they are not signatures against an attacker
who controls both the database and the host's approved plan authority.

The legacy `AuthoringStateMigrationPlan.ContentSha256` has no new interpretation.
Legacy backup/apply/rollback/delete operations reject with a fenced-contract
requirement; legacy measurement is read-only and includes retained backups.
Production composition must explicitly adopt the new typed migration and delete
contracts rather than register this leaf under the old coordinator unchanged.

Backup atomically freezes the source and an explicitly initialized empty target
under a durable plan fence, stores both exact snapshots, and advances both
revisions. It checks limits and strict transforms before committing any fence.
Apply copies the source into the target with the ordered transforms in one
transaction: rename/delete require an existing source; rename refuses an existing
destination; set-default creates `SourceKey` only if absent and requires no
destination field. No transform merges or overwrites a collision. Limits apply
to the source and every intermediate result. Ordinary reads/writes/deletion
refuse an active fence. The typed apply result supplies the exact frozen target
snapshot to the host for startup/preflight without releasing the fence; a matching
applied retry returns the same snapshot. PostgreSQL transaction advisory locks have a stable scope
ordering; CAS, persisted phase and plan identity remain authoritative across
independent connections and host process death.

Rollback restores both backed-up contents at newer revisions and releases the
fences. Completion requires an applied plan and releases the fences without
rewinding data. A matching settled retry is a no-op and cannot overwrite later
writes; an opposite terminal operation refuses. The host must select completion
or rollback from exact durable lifecycle evidence after restart. This port does
not infer a successful activation, provide a cross-store commit, or repair the
old coordinator's composition. Failed or cancelled transactions retain the
previous phase and recovery fence; operation timeout/cancellation applies to
database work as well as transforms.

The migration journal retains only plan identity/digest, scope IDs and phase;
it never stores transform default-value bytes. The host must retain and supply
the exact approved typed plan for recovery; the store cannot reconstruct or guess
transforms from a digest. This prevents a deleted default value from surviving
as a hidden plaintext copy in journal metadata.

Fenced measurement binds the exact revision, current snapshot digest and ordinal
roster of retained backup digests, and counts current plus backup records/value
bytes. A separate host deletion approval must match that entire measurement,
including same-size content changes. Deletion atomically removes current and
retained backup bytes for that exact scope only, preserves an empty scope at a
newer revision and keeps plan metadata. Another scope's current/backup data is
untouched. At most 32 retained backups per scope are admitted; further migration
refuses until the host's explicit retention/deletion policy settles them.
`PostgresAuthoringLifecycleReceiptStore` implements receipt persistence through the
application's existing `ISqlSugarClient`. Reads validate the complete extension
chain; appends acquire the per-extension PostgreSQL advisory transaction lock,
validate the exact previous digest/state/sequence/generation, and insert one row
inside an owned read-committed transaction. The initial receipt starts at sequence
and generation one with `Installed` as its previous state and a zero previous
digest. The existing coordinator owns the allowed transition registry. Duplicate,
stale, malformed, broken-chain appends and cancellation observed at the pre-commit
checkpoint fail without advancing the head. ADO lock/insert waits retain the
existing database command timeout; cancellation is checked around those awaits,
not passed into the underlying command. Independent connections and recreated stores use that same
database authority. The client must be scoped to an operation; ambient transactions
are refused so an append cannot report success before its owner commits.

Host composition must provide the migration and scoped registration before using
this adapter. Its table contract is `authoring_lifecycle_receipt`, with primary key
`(extension_id, sequence)`: `extension_id` is ordinal `VARCHAR(256) COLLATE "C"`;
`sequence` and `generation` are `BIGINT`; `schema_version`, `state_schema_version`,
`data_schema_version`, `previous_state`, and `state` are `INTEGER`; `version` is
`VARCHAR(256)`; `package_sha256`, `scope_digest`, `previous_receipt_sha256`, and
`receipt_sha256` are `VARCHAR(64)`; `failure_code` is nullable `VARCHAR(128)`.
All other columns are required. The adapter does not create tables or configure a
second database. The integration fixture materializes this schema only in its
owned synthetic PostgreSQL database.

The receipt interface identifies a chain by extension only; it does not provide
site/user tenancy, consent, or a signature authority. Hash-chain validation detects
corruption and broken predecessors, but cannot detect privileged deletion of an
entire chain or a valid tail without an independent trusted witness. Database
access and retention remain host responsibilities. Failure codes must remain
closed operational identifiers and must never carry secrets or state plaintext.
Durable state/grant stores, migration/DI integration, and a real host registration
owner are still required before restart recovery or atomic data deletion can be
claimed as terminal acceptance. Removing the scoped registration is the rollback
boundary; preserve existing receipt rows for audit and do not recreate an empty
store as a recovery shortcut.

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

A returned operation value remains subject to cancellation through final
measurement and telemetry completion. Caller cancellation discards the value;
an independently measured budget breach retains its breach reason and containment
even when the caller also cancels. A cancellation arriving while completed
telemetry is stored prevents a completed result from being returned, without
rewriting that already-recorded telemetry.

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

The terminal acceptance contract requires the complete current-run artifact set,
binding the catalog, checker, sources, suites, per-domain evidence digests, zero
warnings, and its own digest. The current checker cannot emit an accepted receipt:
the canonical domain/CI receipt join has no registered current-run producer
validators yet. Evidence mode retains missing/unknown/status/hash diagnostics but
refuses acceptance even for a complete set of synthetic files. Catalog overrides
must exactly match the checker checkout's sole source-owned canonical inventory;
they cannot remove registries, suites, domains, or declared blockers.
The ordinary audit currently
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
