# TypeScript plugin SDK and Jint runtime

FsusBlog treats TypeScript as an authoring language, not a server-side runtime.
Plugin authors import the repository-local `@fsusblog/plugin-sdk` type/source
asset, compile or bundle outside the server, and package an import-free ESM entry
such as `dist/main.js` in the verified `.fspkg`.

```text
plugin.ts
  -> local @fsusblog/plugin-sdk alias
  -> author-owned tsc/esbuild/Vite build
  -> dist/main.js
  -> verified .fspkg
  -> JavaScriptPluginRuntime / Jint
  -> PluginHookDispatcher / PluginHostApiProxy
```

The server does not run `.ts`, invoke `npm install`, emulate Node.js APIs or
publish the SDK. `src/plugin-sdk/package.json` is `private`; the SDK and the
comment-guard example are repository assets. The sibling FsusUI TypeScript
toolchain may type-check the alias fixture locally, but no FsusBlog or FsusUI
package publication is part of this chain.

## SDK contract

`src/plugin-sdk/index.ts` provides:

- `definePlugin`, `PluginDefinition`, `PluginContext`, `HookContext` and
  `HookResult`;
- the closed Hook and capability string unions;
- typed `log`, `storage`, `article`, `comment`, `search`, `media`, `network`,
  `scheduler` and `theme` Host API surfaces;
- lightweight Article, Comment, Search and Media DTO shapes plus config helpers.

The SDK is compile-time guidance. It is not an authorization token. The signed
Manifest still owns the requested Hook/capability set, and the server-owned
catalog and grant store remain authoritative.

`examples/plugins/comment-guard/plugin.ts` demonstrates the authoring source.
Its checked-in `dist/main.js` is an import-free ESM fixture with a default export:

```js
export default {
  id: 'fsusblog.plugin.comment-guard',
  async activate(ctx) {
    ctx.hooks.on('comment.beforeCreate', async event => {
      return event.payload.content.includes('spam')
        ? event.comment.reject('spam_detected')
        : event.next()
    })
  }
}
```

The runtime rejects a missing/invalid default export, an ID that differs from the
verified Manifest, a duplicate Hook registration or a Hook absent from that
Manifest.

## Engine pool and execution

`LoadAsync` reads only the already verified JavaScript entry from package bytes.
It preloads one bounded engine bucket for every declared Hook and runs
`activate()` before the plugin can receive traffic. Each bucket has a bounded
capacity (`Plugins:JavaScript:EnginePoolSize`, default `2`, range `1..8`).

An engine lease is exclusive. Jint's cancellation constraint is rebound to the
current invocation token at rent time; the same engine is never used
concurrently. Completion, JavaScript error, Host API failure, cancellation or
resource exhaustion all discard that engine and create a freshly preloaded
replacement. This deliberately trades some throughput for removal of captured
payload, Host API delegates and plugin globals between requests.

Jint runs in strict mode with string compilation disabled. The runtime never
calls `AllowClr`; CLR interop, `GetType`, reflection and CLR object writes remain
disabled. Jint directly enforces memory, statement, recursion, timeout, regex and
cancellation limits. The existing `PluginExecutionBudgetGuard` additionally
charges serialized input, Host API call depth, output and log bytes. A Host API
operation is resolved through a closed operation-to-capability catalog, then
`PluginHostApiProxy` demands that capability immediately before the real host
operation.

The default host implementation provides bounded, structured `log.write`. The
remaining typed operation names are reserved in the closed catalog but fail
closed until their domain owners provide an implementation; the SDK must not be
read as a claim that storage, article, search, media, network or scheduler access
has already been granted or wired.

## Supported and unsupported workloads

TypeScript plugins fit bounded comment/article filters, render transforms,
search-field extensions, theme/admin configuration logic, lightweight media
coordination and scheduled integrations. They do not fit extremely hot request
paths, CPU-heavy work, bulk migrations, strong-consistency database writes or an
unrestricted network proxy.

There is no Node.js, Deno or Bun sidecar; no `process`, `fs`, `net`, package
resolution, `DbContext`, repository, `IServiceProvider` or unrestricted CLR
surface. The runtime accepts built ESM only and does not compile TypeScript.

## Failure policy and no-restart rollback

Runtime failures return to `PluginHookDispatcher`, which applies the signed
Hook's `fail-open`, `fail-closed`, `ignore` or `quarantine` policy and updates
isolation state. Timeout/resource failures are critical and poison the engine
lease.

No restart is required to stop one JavaScript plugin:

1. remove its Hook registrations;
2. clear its capability grants;
3. quarantine or disable it;
4. call `UnloadAsync`, which cancels in-flight pool work and removes all buckets.

Anonymous, login, admin, notification stream and binary request behavior is
unchanged because this runtime adds no HTTP route, AEDS frame, Cookie, JWT,
Passkey, PoW or `X-Fsus-*` header contract.
