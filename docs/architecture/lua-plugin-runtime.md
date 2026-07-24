# Controlled Lua plugin runtime

Issue #122 adds the host-side Lua adapter boundary without adding or publishing a
Lua engine package. `ILuaPluginRuntime` owns verified package loading, immutable
Hook registration, invocation and unload. `ILuaScriptEngineAdapter` is the only
extension point at which an embedded engine may compile and execute source.

```text
verified and enabled Registry entry
  -> read the exact manifest runtime.entry from PackageBytes (1 MiB maximum)
  -> require a Level 1 engine capability attestation
  -> compile with only string/table/math/utf8
  -> verify every manifest Hook was registered
  -> atomically publish the compiled program and Hook registrations
  -> Hook Dispatcher -> LuaPluginHookRuntimeInvoker -> compiled program
```

The repository intentionally ships `UnavailableLuaScriptEngineAdapter` as the
default. It fails closed because no embedded Lua engine is present in the current
dependency graph. It is not a parser and does not claim to execute Lua. A future
engine integration must replace that adapter in DI and pass the same conformance
tests; it must not weaken the runtime or package contract.

## Adapter contract

Before source is handed to an engine, `LuaPluginRuntime` requires positive support
for:

- standard-library allow-listing;
- disabling CLR interop, assembly load and reflection;
- disabling raw filesystem, unrestricted network and process spawning;
- instruction, memory, call-depth, output and log accounting;
- cancellation and host timeout interruption.

Disabled, installed-only and quarantined lifecycle entries cannot be loaded.
The engine receives the immutable `PluginSandboxProfile` and the exact allowed
library set. It returns an `ILuaPluginProgram` with the Hook names registered by
`activate(ctx)`. The runtime refuses to publish any registration when a declared
Hook is absent. Replacing a loaded version compiles first and disposes the previous
program only after the replacement is published. Unload removes the Hook snapshot
first, then waits for acquired in-flight calls to release their program lease
before disposing it.

`LuaPluginExecutionContext` exposes only the current payload, non-secret Hook
items, `PluginExecutionBudgetGuard`, and the plugin-scoped `PluginHostApiProxy`.
Each `InvokeHostAsync` performs a fresh capability demand and charges an
instruction before dispatching a real host operation. Engine bindings for
`ctx.log`, `ctx.storage`, `ctx.article`, `ctx.comment`, `ctx.search` and
`ctx.media` must map to that method; they cannot retain repositories, services or
a positive grant result. `ctx.next` and Hook registration remain runtime-local
control operations.

The example at `examples/plugins/lua-comment-filter` declares
`comment.beforeCreate`, rejects a literal keyword and uses no raw permission. It is
source-level integration material for a conforming engine, not proof that the
default unavailable adapter can execute Lua.

## Scope, failure and multi-node semantics

The Lua adapter does not duplicate dispatcher policy. Priority, timeout,
failPolicy, scope and idempotency are declared in the signed Manifest and enforced
by `PluginHookDispatcher`. `cluster-once`, `scheduled` and `leased` continue to use
the fenced lease and durable idempotency state from the common scope coordinator.
Engine exceptions and budget failures return through the dispatcher, which applies
fail-open, fail-closed, ignore or quarantine and updates isolation state.

No-Hook remains the dispatcher fast path and never reaches Lua. Loaded programs
are cached per node. A Hook invocation is awaited and must not block a Kestrel
thread with synchronous long-running work.

## Risk and no-restart rollback

Engine capability reporting is a host assertion, not an OS sandbox. A concrete
adapter needs engine-specific adversarial tests for `io`, `os.execute`,
`package.loadlib`, arbitrary `require`, `dofile`, `loadfile`, CLR import and
resource interruption before it is enabled.

No restart is required to stop one Lua plugin: remove its Hook registrations with
`UnloadAsync`, clear its grants, and quarantine or disable the durable plugin
entry. In-flight calls observe their linked cancellation and new calls fail
closed. Operators may restore the plugin only after reviewing the verified
package, engine evidence and capability plan.

This boundary adds no HTTP route and does not alter anonymous/login/admin
authorization, notification stream admission, binary/AEDS framing, PoW or any
`X-Fsus-*` header.
