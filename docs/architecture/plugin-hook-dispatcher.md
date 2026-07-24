# Plugin Hook Dispatcher

The v1.3.0 Hook Dispatcher is the only supported path from a core-module event to
plugin-controlled code:

```text
core event -> cached Hook registry -> capability/isolation check
           -> local or distributed scope coordinator
           -> JavaScript/Lua runtime adapter -> result/failure policy/metrics
```

No plugin receives a repository, `DbContext`, `IServiceProvider`, filesystem or
unrestricted network handle. Runtime adapters are replaceable behind
`IPluginHookRuntimeInvoker`; the default adapter is intentionally unavailable and
fails closed until the JavaScript or Lua runtime is installed on the node.

## Stable models and ordering

`PluginHookDescriptor` declares `name`, `priority`, `timeoutMs`, `failPolicy`,
`executionMode`, `scope` and `idempotent`. The machine-readable manifest requires
all seven fields. `PluginHookCatalog` is the closed host vocabulary for article,
comment, search, media, user/auth, system, scheduler and plugin lifecycle events.
Each name has one Hook type and one required capability. Package verification
rejects unknown names, unknown wire values, duplicate names and a Hook whose
required capability is absent from the signed Manifest.

The six Hook types are Filter, Action, Guard, Provider, Render and Worker.
Registrations are held in an immutable snapshot ordered by descending priority and
then plugin ID. Replacing or removing one plugin publishes a new snapshot
atomically. A Hook with no registrations returns immediately without a Registry,
permission, runtime, lease or allocation-heavy result merge.

Filter/Render/Provider results become the next plugin input. A Guard result with
`Continue=false` stops the chain. Action and Worker callers should ignore the
value. The dispatcher awaits all modes: `background` means the caller is a durable
worker, not an unobserved fire-and-forget task.

## Permission, budget and failures

Before every invocation the dispatcher:

1. demands the Hook's catalog capability from `PluginPermissionManager`;
2. rejects quarantined or disabled plugins;
3. clamps the declared timeout to the Hook's host maximum;
4. creates the six-dimensional execution budget and linked cancellation token;
5. passes only a plugin-scoped `PluginHostApiProxy` to the runtime.

`fail-open` and `ignore` record failure and continue. `fail-closed` records failure
and blocks the core operation. `quarantine` immediately isolates the plugin and
continues the host flow. Runtime timeout/resource failure is treated as a critical
isolation failure. Activity and Meter data record duration, error, plugin ID, Hook
name and request trace ID; trace ID remains on the Activity rather than a metric
dimension.

Auth Hook declarations require the sensitive `user.auth.hook` capability. They
never receive credential secrets, Cookie values, JWTs, Passkey assertions or raw
request headers; a caller must construct a minimal policy DTO.

## Multi-node and worker semantics

`local` and `per-node` execute on the current node. `cluster-once`, `scheduled` and
`leased` require `idempotent=true`; they use the shared `ILeaseManager` and
`IDistributedTaskStateStore` from issue #113. The partition is a SHA-256 identity
of plugin, Hook and operation, the lease carries a fencing token, and the task
record prevents a successful operation from replaying. Contention or an existing
successful record is a deterministic skip, not a second execution. Failures enter
the existing retry/dead-letter state machine.

Callers must supply a stable, non-secret `OperationId`. Worker payload checkpoints
remain owned by the worker and the distributed state-control API; they must not be
embedded in Hook metrics.

## Risk and no-restart rollback

The dispatcher does not itself prove that a JavaScript/Lua engine implements the
Level 1 sandbox; each runtime adapter must refuse registration when it cannot
enforce the profile. Cluster-once is effectively-once only for work whose side
effect also honors the fencing/idempotency boundary.

No restart is required to degrade one plugin: remove it from the in-memory Hook
registry, clear its grants, quarantine or disable it, and allow in-flight linked
cancellation to finish. Multi-node operators repeat the Registry refresh on each
active node or disable the durable plugin lifecycle entry. Anonymous, login,
admin, notification stream and binary routes keep their existing authentication,
PoW, `X-Fsus-*` and AEDS behavior because this change adds no HTTP route.
