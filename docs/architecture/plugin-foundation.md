# Plugin package and Registry foundation

This document owns the v1.3.0 plugin package, manifest, Registry and lifecycle
foundation. It does not authorize plugin code execution or Hook dispatch. Permission
requests are interpreted by the separate default-deny
[plugin sandbox boundary](../security/plugin-sandbox.md); native C# loading, Raw
SQL, a public marketplace and automatic updates remain unavailable.

This `.fspkg` Registry and Hook namespace does not own the separate
[authoring extension manifest registry](authoring-extension-host-boundary.md).
Authoring extension manifests and execution declarations cannot be registered in
or inferred from `plugin_registry`, and neither system supplies a compatibility
fallback for the other.

## Package boundary

A plugin package uses the `.fspkg` extension and is a zip archive. The minimum
accepted package is:

```text
manifest.json
<runtime entry>
<config schema>
signature/checksums.json
signature/signature.sig
```

Assets and optional administrative UI files may be present when referenced by the
manifest. `PluginPackageReader` treats every archive as hostile data:

- the compressed package, expanded total, individual entry and entry count are
  bounded;
- absolute paths, `..`, empty segments, backslashes and duplicate paths fail
  closed;
- unknown Manifest fields, unsupported runtimes, malformed semantic versions,
  incompatible host ranges, missing entries, unknown Hook/capability names and
  unknown permission fields fail closed;
- the config document must use the closed, recursively validated JSON Schema subset
  declared by the foundation (typed object/property/array nodes, required names,
  enum, scalar bounds and closed additional-properties semantics); unsupported
  keywords fail closed;
- `signature/checksums.json` must cover every payload entry exactly once, and every
  SHA-256 comparison uses fixed-time equality;
- signature metadata is mandatory. Deployments that configure an
  `IPluginPackageSignatureVerifier` also require its verification result before a
  package can become installable.

The machine-readable Manifest contract is
`src/shared/Contracts/Plugins/plugin-manifest.schema.json`. Runtime code uses the
closed `PluginManifest`, `PluginRuntimeDescriptor`, `PluginConfigSchema` and
`PluginPackage` models. The reader never extracts files and never invokes package
code.

## Registry and lifecycle

`plugin_registry` is the cluster authority. Each row stores the verified manifest,
the complete `.fspkg` bytes, its SHA-256 digest, lifecycle state, enabled bit,
timestamps and a monotonic compare-and-swap version. Package bytes are deliberately
stored in PostgreSQL rather than a node-local directory, so any homogeneous node
can read the same verified snapshot after startup.

The foundation exposes these transitions:

```text
verified package -> Installed -> Enabled -> Disabled -> Enabled
                         |           |          |
                         +-----------+----------+-> Uninstalled
```

`Uninstalled` keeps the manifest and package digest as durable identity evidence but
clears package bytes. Duplicate install IDs never replace an existing row.
Enable/disable/uninstall use the Registry version as optimistic concurrency control;
a conflicting writer is retried within a small bound and otherwise fails without
guessing the winning state.

The administrative configuration editor maps enum choices to UI keys while
retaining the declared JSON values. Object values match independently of property
order; array order and scalar types remain significant. Selecting an object,
array or null sends that original JSON value, not its UI key or display label.
This presentation mapping does not replace schema validation or the sensitive
action proof required before configuration writes.

Primitive controls read only their declared value kinds from the complete JSON
draft. Non-enum object, array and null fields keep editable JSON text separately
while it is incomplete, has the wrong declared type, or contains numbers that
the existing JSON serializer cannot preserve. Numeric overflow, underflow and
rounding are rejected instead of being saved as null or a different value;
equivalent decimal notation and exactly preserved large values remain valid.
Such text cannot replace the last valid value or enable a configuration write.
Correcting it restores the write action; the backend still owns full schema
validation and authorization.

The broader lifecycle vocabulary remains:

```text
Discover -> Verify -> Install -> ResolveDependencies -> ValidateManifest
-> PrepareRuntime -> RegisterHooks -> Activate -> Execute -> Deactivate -> Uninstall
```

The package issue implements the inert Discover/Verify/Install and durable state
transition portion only. The permission layer turns the verified manifest into an
administrator-readable `PluginPermissionPlan`; it does not make package verification
an implicit grant. Runtime preparation, dependency resolution, Hook registration
and execution belong to later plugin-system boundaries.

## Failure isolation and rollback

Package verification finishes before the first Registry write. Invalid archives,
checksum/signature failures and duplicate IDs therefore cannot mutate a previously
installed plugin. A failed enable/disable CAS likewise leaves the winning Registry
row unchanged.

Operational degradation does not require an application restart: set an affected
plugin to `Disabled` through the lifecycle owner before its future runtime is
dispatched. Registry readers on all nodes then observe the same state. The additive
`plugin_registry` table remains during rollback; an N-1 build ignores it. Do not
drop the table or erase package evidence during rollback.

Before a future dispatcher invokes plugin code, it must apply the [Hook Dispatcher permission and failure checks](plugin-hook-dispatcher.md#permission-budget-and-failures): check isolation, construct the closed Level 1 sandbox/resource guard, expose only a plugin-scoped Host API proxy, and recheck capability for every operation. Detailed limits, quarantine transitions, and fail-closed no-restart handling remain in the [Plugin permission and sandbox boundary](../security/plugin-sandbox.md).
