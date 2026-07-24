# Plugin permission and sandbox boundary

FsusBlog plugins are denied all host capabilities by default. A verified package
manifest is only a request: it does not grant the plugin access to a service,
database, file, network socket or CLR type.

## Capability approval

`PluginCapability` and `PluginCapabilityCatalog` are the closed runtime vocabulary.
The stable wire names are:

```text
article.read
article.render
article.write.draft
comment.read
comment.create
comment.moderate
search.index.write
search.query.rewrite
media.process
plugin.storage.kv
plugin.storage.object
plugin.log.write
network.http.outbound
scheduler.job.create
admin.ui.extend
theme.asset.read
user.auth.hook
```

Private plugin storage, plugin-scoped logging and theme asset reads are `Safe`. The remaining
capabilities are `Sensitive` because they touch content, shared indexes, scheduled
work, outbound HTTP or administrative UI. Sensitive grants require an explicit
administrator confirmation. A grant must be a subset of the capabilities in the
verified manifest; a later grant cannot add an undeclared capability.

`user.auth.hook` is always Sensitive. It gates the conservative login/registration
Hook family and does not authorize reading credentials, Cookie/JWT contents,
Passkey assertions or raw request headers. Hook names, ordering, distributed scope
and failure handling are specified by the
[Plugin Hook Dispatcher](../architecture/plugin-hook-dispatcher.md).

`database.raw`, `filesystem.raw`, `process.spawn`, `reflection`,
`serviceProvider.access`, `assembly.load`, `environment.read`,
`network.unrestricted` and `clr.unrestricted` are not capabilities. The legacy
manifest `permissions.network=true`, `permissions.filesystem=true` or
`permissions.database!=none` values are displayed as denied raw requests and make
the permission plan ineligible for enablement. They are never translated into a
grant.

The administrative installation surface consumes `PluginPermissionPlan`: it shows
each requested capability, classification and confirmation requirement together
with any denied raw request. Admin UI implementation is separate, but it must use
this server-owned plan rather than reclassifying strings in the browser.

## Host API and CLR boundary

Plugin code calls a plugin-scoped `PluginHostApiProxy`. The proxy invokes
`PluginPermissionManager.Demand` immediately before every real operation. It does
not hand a plugin `IServiceProvider`, repository, `DbContext` or internal service,
and it does not cache a positive permission result across calls. Revoking a grant
therefore prevents the next Host API call.

Level 0 is declarative manifest/theme metadata. Level 1 is the only untrusted
executable profile for v1.3.0 script adapters. Both JavaScript and Lua use
`PluginSandboxPolicy.CreateLevelOne`, whose immutable profile disables CLR import,
assembly loading, reflection, service-provider access, raw filesystem, unrestricted
network and process spawning. The TypeScript/Jint and Lua runtime issues must reject
startup if their engine cannot implement that profile; they must not silently
substitute an unrestricted engine. Level 2 trusted native, Level 3 out-of-process
and Level 4 WASM are reserved and are not enabled by this boundary.

The Lua adapter additionally requires engine support for a standard-library
allow-list and exposes only `string`, `table`, `math` and `utf8`. It requires
positive enforcement support for instruction, memory, call-depth, output and log
budgets plus cancellation before it reads or compiles the entry. Missing support
fails closed before Hook registration. The repository default is an explicitly
unavailable adapter because no concrete Lua engine is currently in the dependency
graph; source is never interpreted by an ad-hoc host parser. The adapter contract,
package load sequence and engine-integration boundary are documented in
[Controlled Lua plugin runtime](../architecture/lua-plugin-runtime.md).

## Resource budgets and isolation

Every execution receives a `PluginExecutionBudgetGuard` with positive limits for
timeout, memory, instruction count, call depth, output and log bytes, plus a linked
`CancellationToken`. Runtime adapters must charge the guard before allocating or
emitting the corresponding resource and check the timeout at safe interruption
points. Unknown hooks have no default budget and fail closed.

Lua Host API calls cross `LuaPluginExecutionContext.InvokeHostAsync`, which checks
the timeout, charges the instruction guard and then calls the plugin-scoped proxy.
The proxy rechecks the capability on every call. A concrete engine binding must
not cache the result, surface the proxy object itself, or turn library names into
arbitrary CLR member access.

Isolation state is `Healthy -> Degraded -> Quarantined`, with `Disabled` as an
operator state. Five failures in one minute degrade a plugin. The next failure
while degraded, or a critical Hook timeout, quarantines it. Quarantined and disabled
plugins cannot execute. Recovery clears the failure window and requires explicit
administrator confirmation.

Isolation state, permission plan and current grants are administrative data only;
they must not be exposed through public routes or notification stream payloads.
`PluginSecurityAdministrativeSnapshotService` is the backend read model for a
future admin-only binary contract: it combines verified runtime/install metadata,
the server-classified request plan, current grants and node isolation state without
exposing a mutable service or raw package data.

## Risk, rollback and no-restart degradation

The Level 1 policy is an application sandbox, not an OS security boundary. It
depends on each future engine adapter correctly disabling CLR interop and charging
the resource guard. Native untrusted C# remains out of scope.

No-restart degradation is fail closed:

1. quarantine or disable the affected plugin so `DemandExecutable` rejects new work;
2. replace its grant set with an empty set so every subsequent Host API call fails;
3. allow already-cancelled invocations to observe their cancellation token;
4. restore only after an administrator reviews the manifest and runtime evidence.

This does not require weakening authentication, admin permissions, PoW, the
`X-Fsus-*` headers, binary response contracts or notification stream admission.
