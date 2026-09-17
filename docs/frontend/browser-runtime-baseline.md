# Browser Runtime Baseline

FsusBlog browser code uses **ES2022** as its stable ECMAScript baseline. This
is a release contract, not a claim that ES2022 defines every browser feature
used by the application.

## ECMAScript baseline

`src/frontend/tsconfig.app.json` fixes both emitted syntax and built-in object
types to ES2022. `src/frontend/vite.config.ts` fixes the shared production build
target to `es2022`. The normal SPA, Public AOT hydration entries, browser
workers, and Wasm TypeScript bridges all pass through those two boundaries.

The Node/Vite configuration remains on ES2023, but its `include` scope is only
`vite.config.ts`. Node build-tool capabilities must not leak into browser
source code through a shared tsconfig or helper.

An ECMAScript baseline does not provide polyfills. Browser code that needs an
ES2023-or-newer built-in must use an audited compatibility implementation or a
central adapter with feature detection and a documented fallback. An isolated
runtime may use a newer baseline only through its own tsconfig, compatibility
evidence, and rollback path.

## Browser support and Web Platform capabilities

Browser version support is demonstrated by the release smoke matrix for
Chromium, Firefox, and WebKit; it is not inferred from the `ES2022` label.
Public AOT pages must remain readable when JavaScript is disabled or hydration
cannot start. FsusBlog does not ship a legacy bundle for browsers that lack the
project's ESM, Wasm, or CSP security baseline.

DOM, CSS, Service Worker, Cache Storage, IndexedDB, WebAuthn, Trusted Types,
WebAssembly extensions, View Transitions, and scheduling APIs are Web Platform
capabilities rather than ECMAScript editions. Each remains governed by its own
feature detection, browser evidence, and safe fallback or explicit rejection.

## Executable guard

Run the baseline guard from the frontend directory:

```bash
npm run check:modern-standards
```

The guard checks the browser and Node tsconfig scopes, the shared Vite build
target, Worker participation, and an intentional `Array.prototype.toSorted()`
negative fixture. The fixture must produce an ES2022 TypeScript diagnostic;
passing it would reveal an accidental expansion to ES2023 built-ins.

To roll back an incompatible enhancement without restarting the backend,
disable that enhancement through its existing feature flag or capability
adapter and continue serving the ES2022 bundle and static Public AOT content.
Do not relax the global target as an incident workaround.
