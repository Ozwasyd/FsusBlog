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

## Stability and rollback

The contract is currently internal/experimental and may change only by advancing
its closed schema or registry version and updating its validators and tests in the
same change. Unsupported host API ranges, platforms, entrypoint mappings, versions,
or registry identities remain rejected; compatibility never falls back to the
generic plugin system or a less isolated class. Rolling back this stage removes no
runtime or durable state because this boundary creates neither.
