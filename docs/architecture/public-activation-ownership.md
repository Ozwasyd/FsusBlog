# Public activation ownership

After `entry.ts` starts on a Public AOT document,
`PublicActivationCoordinator` is the only authority for activation phase,
generation, intent, and owner. The coordinator is pure TypeScript with injected
ports; `publicActivationRuntime.ts` is the sole browser composition root for
those ports.

## Phases and owners

The complete activation phase set and its owner mapping are:

| Phase | Owner | Contract |
| --- | --- | --- |
| `static-visible` | AOT DOM | The static document remains readable and interactive before work begins. |
| `silent-warming` | AOT DOM | Route resources may prepare without foreground feedback. |
| `foreground-wait` | AOT DOM | An activation intent is pending; frame-gated global-loader feedback may appear. |
| `prepared` | AOT DOM | Route preparation succeeded, but document ownership has not transferred. |
| `committing` | FullApp | FullApp ownership transfer has started and is no longer abortable. |
| `interactive` | FullApp | FullApp owns subsequent public route navigation. |
| `fallback` | Document navigation | The current generation may perform one document navigation and cannot restart SPA commit. |

The coordinator state contains only the monotonic generation, normalized
target/source/kind intent, phase, owner, foreground-feedback visibility,
failure reason, and replaceability. Vue applications, Router and Pinia
instances, DOM nodes, component instances, and backend DTOs are not coordinator
state.

Every legal transition is explicit. An illegal transition leaves phase and
owner unchanged and records a stable telemetry reason. Each generation records
at most one terminal `interactive` or `fallback` outcome.

## Intent and fallback rules

Before `committing`, a different target increments the generation and aborts
replaceable preparation; the latest intent wins. Repeated intents for the same
target share active preparation instead of starting another route prepare.
Once commit begins, the ownership transfer continues to completion and a later
intent is queued for the interactive Router.

Route-preparation, FullApp preparation, and FullApp commit failures converge on
`fallback` for the current generation. Entering `fallback` clears foreground
feedback, records the terminal reason, invokes the fallback port once, and
rejects further activation for that generation. A superseded generation may
record its terminal replacement outcome, but it cannot perform document
navigation.

The BootKernel handoff is adopted at most once and normalized into a
coordinator intent. After `interactive`, Router navigation failures are
explicitly rejected; they do not start a competing document-navigation
fallback.

## Port and composition boundaries

`PublicActivationCoordinator` calls external behavior only through these
injected ports:

- `routePreparationPort` prepares the target component, seed, and SEO head for a
  concrete navigation intent; it never creates or mounts a Vue app and never
  imports the FullApp composition root;
- `fullAppPort.warm` / `fullAppPort.prepare` load and construct FullApp core,
  Router composition, and required plugins only; they never accept a route URL
  for navigation-snapshot fetch and never write route seed/head stores;
- `fullAppPort.commit` / `navigate` transfer ownership and own interactive
  Router navigation after commit;
- `feedbackPort` owns foreground waiting feedback only:
  `markBusy` immediately, `show` after one animation frame while the generation
  is still non-terminal, and `hide` on clear. The port drives `#global-loader`
  with `aria-hidden` / shell `aria-busy` / status live semantics; it does not
  create `#nprogress`;
- `fallbackPort` performs document navigation;
- `telemetryPort` records phase transitions, durations, illegal transitions,
  terminal outcomes, and prepare timings
  (`core_prepare_ms`, `route_component_ms`, `route_snapshot_ms`,
  `activation_prepare_wall_ms`);
- `clock` supplies microtask, frame, timer, and time operations for deterministic
  tests.

Silent warming never arms feedback. Same-frame completions cancel the pending
frame so the loader never flashes. `prepared` / `committing` keep a loader that
already became visible; they must not be the first moment feedback is scheduled.
Takeover visual snapshots stay outside this port: they only preserve DOM
ownership transfer continuity at commit time and never act as loading UI.

Router `#nprogress` is independent SPA navigation feedback. The composition root
injects `shouldSuppressNavigationProgress` so coordinator-owned AOT takeover
never schedules nprogress; ordinary interactive SPA navigations may still use it.
The Router must not import the coordinator or browser composition root.

### Core warming vs intent route preparation

These are independent concepts and must not be recombined into a single
composite FullApp+route prewarm(currentPath) API:

| Concept | Trigger | Port | May fetch current-page navigation snapshot? |
| --- | --- | --- | --- |
| FullApp **core warming** | idle public boot | `fullAppPort.warm()` | No |
| Intent **route preparation** | pointerenter / focus / activation intent | `routePreparationPort.prepare(intent)` | Only for the **target** intent URL |
| Foreground activation | click / boot handoff | both ports in parallel, then one commit | Target only |

Idle public boot may warm SPA entry/core modules so the browser can cache them.
It must not request `/api/public/navigation-snapshot.aeds` for the already AOT
hydrated current URL, must not create a one-shot seed for that current route,
and must not prepare admin/auth/editor resources.

On a foreground intent of one generation the coordinator starts:

```text
fullAppPrepared = fullAppPort.prepare(intent)
routePrepared   = routePreparationPort.prepare(intent, signal)
await Promise.all([fullAppPrepared, routePrepared])
commit only when both belong to the same generation
```

Inside `routePreparationPort`, component preload and snapshot fetch also start
in parallel. SEO/seed commit happens only after both producers succeed and the
generation/signal is still current. A later intent aborts the previous
generation before a late snapshot can write seed/head.

### Route prewarm Promise cache vs seed/head artifact lifecycle

These are deliberately separate:

| Mechanism | Owner | Lifetime | Responsibility |
| --- | --- | --- | --- |
| In-flight task map (`createPublicRoutePrewarmer` `tasks`) | `publicRoutePreload.ts` | Only while the producer is unsettled | Deduplicate concurrent prepare for the same target (pointerenter/focus/click) |
| Route seed store | `publicRouteSeedStore.ts` | Default TTL (5 minutes) **and** one-shot `consume` | Consumable navigation seed for the next Router render |
| Prepared SEO head store | `publicSeoHead.ts` | Default TTL (5 minutes) until committed/expired | Staged head for the next public navigation |

Rules:

- Settled prewarm outcomes (`ready`, `miss`, `cancelled`, `timeout`, `failure`)
  always leave the in-flight map. A historical resolved Promise is never kept as
  readiness evidence.
- Returning `ready` requires **currently usable** artifacts: loadable route
  component (browser/ESM module cache), unconsumed and unexpired route seed with
  matching renderer identity, and a prepared SEO head. A prior call that once
  returned `ready` is not enough.
- After Router `consumePublicRouteSeed`, the next prepare for the same path must
  re-run the snapshot producer (or another path that writes a fresh seed). It
  must not revive the consumed seed object or skip freshness/renderer checks.
- Telemetry distinguishes `public_route_prewarm_inflight_hit` (join unsettled
  producer) from `public_route_prewarm_artifact_ready` (reuse still-valid
  seed/head without starting producers). Do not collapse both into a single
  `prewarm-hit`.

The coordinator does not import DOM APIs, Vue, Router, Pinia, FsusUI,
`fullApp.ts`, `publicShell.ts`, or their implementations.
`publicActivationRuntime.ts` binds route preparation to
`publicRoutePreload.ts`, loads the FullApp implementation, connects feedback
and telemetry, and implements document fallback.

`publicShell.ts` may idle-warm FullApp core, warm a concrete route intent, or
submit a typed activation intent; it does not own a cross-phase promise,
generation token, or abort controller.
`fullApp.ts` owns application and Router construction plus prepare/commit
mechanics, but it does not select the top-level activation phase. The Router
receives an activation-owner getter and does not import the browser activation
composition root.

## Intent capture ownership

At any moment, one navigation-decision owner owns each intent class:

| Lifecycle | Owner | Allowed intent surface |
| --- | --- | --- |
| Entry not loaded | BootKernel | Minimal `pointerdown` / `touchstart` / `keydown` / `scroll` listeners that inject the entry and write a one-shot handoff. |
| Entry adopted handoff | BootKernel → destroy | BootKernel unbinds intent listeners and destroys handoff carriers; entry consumes the one-shot intent. |
| Entry loaded, AOT owner | PublicActivation runtime via `publicShell.ts` capture | Single capture `click` for public AOT actions/links, plus pointerenter/focus route prewarm. Activation/navigation submits typed intents only. |
| Committing | Coordinator | Freezes ownership transfer; later intents queue for interactive Router. |
| Interactive | Vue Router / component handlers | SPA navigation, search submit, and component-local handlers. |
| Fallback | Document navigation | Native/document navigation only; no retired JS takeover path. |

Search focus is a typed UI intent: producers call
`requestPublicSearchFocusIntent()` on `publicActivationRuntime`. Window
CustomEvent bridges, dual root AOT click handlers, and parallel pointer/key
activation listeners are forbidden. Progressive enhancement keeps native
`<a href>`, modified clicks, downloads, external links, and document navigation
when JavaScript fails; those are not compatibility layers and must not be
implemented through a micro-router.

## Causal regression evidence

Public bootstrap interaction preemption, feedback timing, and single-navigation
determinism are gated by a three-layer causal matrix:

| Layer | Entry | Contract |
| --- | --- | --- |
| Fake-scheduler unit | `tests/frontend/unit/bootstrap/publicActivationCausalMatrix.test.ts` | Idle preemption, frame-gated feedback, parallel prepare, latest-wins, terminal cleanup |
| Producer barrier unit | `tests/frontend/unit/router/publicRoutePreload.test.ts` | Component + snapshot start before either settles; seed re-run after consume |
| Browser matrix | `tests/frontend/e2e/acceptance/public-bootstrap-causal-matrix.spec.ts` | Silent path, intent-before-entry, delayed prepare, competition, failure, seed lifecycle, hydration counterexample |
| Static zero-residue | `npm run check:public-bootstrap-causal-zero-residue` | Retired files/symbols/events/flags/suppression helpers are zero across production, tests, fixtures, docs, and bundles |

Browser and unit receipts use schema
`fsusblog.public-bootstrap-causal-evidence.v1` (see
`tests/frontend/support/publicBootstrapCausalEvidence.mjs`). Correctness is
causal order, not absolute millisecond budgets:

```text
intent <= producer start
intent < feedback visible       (only when feedback crossed a frame)
feedback visible < interactive  (if feedback was shown)
commit start <= interactive
interactive <= feedback hidden  (if feedback was shown)
interactive < any forbidden late-visible event
```
