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
| `foreground-wait` | AOT DOM | An activation intent is pending and delayed foreground feedback may appear. |
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
- `feedbackPort` enters and leaves foreground waiting feedback;
- `fallbackPort` performs document navigation;
- `telemetryPort` records phase transitions, durations, illegal transitions,
  terminal outcomes, and prepare timings
  (`core_prepare_ms`, `route_component_ms`, `route_snapshot_ms`,
  `activation_prepare_wall_ms`);
- `clock` supplies microtask, frame, timer, and time operations for deterministic
  tests.

### Core warming vs intent route preparation

These are independent concepts and must not be recombined into a single
`prewarmFullAppRoute(currentPath)` style API:

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
