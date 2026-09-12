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

## Stage boundary

This contract stage does not verify package signatures or trust, issue or persist
grants, resolve execution, start a worker/service, broker I/O, expose RPC, mutate a
document, or manage lifecycle state. An enum declaration is never executable
authority. Each later child must recheck the verified identity and implement its
own fail-closed acceptance before any operation can occur.

The general [plugin sandbox](plugin-sandbox.md) continues to own `.fspkg` Hook
execution through its Level 1 Jint/Lua application sandbox. Neither subsystem may
reuse the other's manifest, capability registry, identity, grant, lifecycle, or
fallback authority implicitly.
