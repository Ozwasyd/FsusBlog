# Layout visual governance

Design intent, ownership and rule precedence come from
[`../design/governance.md`](../design/governance.md). Route-level composition is
classified by [`../design/surface-profiles.md`](../design/surface-profiles.md).
This document owns representative-route evidence and baseline movement only; it
does not establish a second design language.

The canonical representative route set lives in
`tests/frontend/fixtures/layout-archetype-matrix.json`. Public, identity, and
admin Playwright suites consume this registry directly. Adding a business route
does not add a screenshot; add or replace a representative only when it creates
a new page archetype.

Critical representatives own desktop/mobile and light/dark screenshots. Every
registered path still runs structural, theme, focus-visible, hit-target,
reduced-motion, high-contrast, and horizontal-overflow checks through the
focused suites. Public representatives additionally retain the existing
PublicShell AOT/hydration ownership assertions. Dashboard tests keep the
separate 1366x768 first-fold contract for actionable tasks and summary content.

`tests/frontend/fixtures/layout-visual-change-ledger.json` is the only approval
ledger for baseline movement. Each entry links an issue and affected archetype
to exactly one classification:

1. `visual-equivalent-refactor`
2. `expected-harmonization`
3. `required-accessibility-ergonomic-correction`
4. `unintended-regression`

A baseline update requires an issue-linked rationale in that ledger. Snapshot
movement by itself is not approval. The governance checker rejects unknown
archetypes, missing dependency classifications, route-name visual branching,
consumer dependencies on PublicShell internal BEM selectors, misleading local
`FsusUi*` implementations, and retired generic primitives.

`PublicBlogLayoutShell.vue` is the sole Blog integration point for PublicShell,
but it may use only public props, slots, tokens and stable `data-*` hooks. No
consumer file may address `el-public-shell__*` selectors, and there are no
temporary external-selector exceptions. Apple Touch Icon remains a
standards-facing asset label; Apple or Linear design-language names in
production classes, tokens, or route metadata are prohibited.

Public/design documentation follows the single-concern ownership map in
`../design/governance.md`. Shell implementation ownership and geometry live in
`public-shell-ownership.md`; public product composition lives in
`../public-layout-rules.md`; reading typography and page titles live in their
separate design documents. A current document must not cite an issue/handoff file
as its contract, and deleted migration sources are represented only by lifecycle
`pathMigrations`, not by replacement aliases or copied session notes.

## Manage write task and inspector evidence

`ManageWriteArticle` composes a `task` surface around a stable, centered reading
column and a route-owned `overlay` inspector. The editor and its form stay
outside the inspector host and retain one component identity. Opening, closing,
or switching among publish, rights, check, preview, versions, and resources
must change the document content-box width by no more than 8px at 1366px and
1440px, and the representative mixed-language paragraph must keep the same
wrap signature.

`ArticleWriteInspectorShell` is the only inspector host and consumes one active
view registry. Desktop uses a fixed, nonmodal complementary pane with a compact
icon rail; it does not reserve document-grid width, expose modal semantics, trap
focus, or intercept pointer input outside the pane and rail. Viewports below
1024px keep one Drawer-external launcher while closed, then use the public
FsusUI Drawer and its single internal icon rail for modal focus, view switching,
safe-area, and visual viewport behavior. The responsive host switch never mounts
two copies of the panel content or creates a second state or data-loading owner.

Inactive views remain hidden and inert while preserving their local scroll
position, and each view starts its data loader only on first entry. Closing
through the close control, Escape, or Drawer overlay returns focus to the exact
external opener rather than the last internal rail control. A save conflict,
publish blocker, or high-severity check remains discoverable as one low-noise action in the
existing command/status surface and opens its owning view; the rail and command
surface do not expose a persistent per-view count wall.

## Composition contract definitions and identity

Every existing representative in `layout-archetype-matrix.json` owns one
`compositionContract`. The matrix retains its route and screenshot fields for
fixture identity; the composition contract uses semantic region, owner, action,
material and state IDs. It never treats a selector, current CSS, a historical
snapshot or copied token values as design authority. The schema is
`config/schemas/layout-composition-contract.schema.json`; the pure validator and
identity functions are in
`tests/frontend/support/layout/compositionContracts.mjs`.

Contracts reference the current FsusUI design document and the maintained Blog
governance, surface, public-layout, typography, task-geometry and page-title
sources. They bind the existing matrix coverage, viewport corpus and available
fixture sources rather than creating another representative-route or screenshot
registry. State requirements live in the contract itself. A fixture source
reference records provenance only: `pending-current-run` never claims that the
state has been produced or accepted. A missing binding stays explicit with a
null `fixtureRef` and its binding owner; unrelated loading/empty fixtures cannot
stand in for a save, permission or icon-generation state.

Action rules are exact-one or partitioned by one semantic state dimension.
Exclusive cases cover all values of that dimension once. An explicitly passive
case declares zero primary submit actions and retains only its named secondary
actions; it does not manufacture a save button. Settings site, compliance and
page publishing share the header authority, while media preferences have no
submit action. Data previews and genuine status/risk regions retain their own
roles and required boundaries; ordinary fields and repeated items remain flat.

`createCompositionIdentity` binds the exact supplied source commit and existing
FsusUI baseline receipt to the schema, validator content/version, semantic
contracts, current design-document bytes, fixture sources, complete archetype
matrix and sole visual ledger. Local and published baseline identities may
differ; the semantic contract and schema do not branch by mode. Callers must
resolve and verify their actual effective design source and baseline, including
published provenance; merely finding a local checkout does not qualify a
published package. `verifyCompositionIdentity` rejects stale or tampered
bindings. Changing a route or screenshot target changes fixture identity without
redefining the semantic contract.

The current contract-definition result is `contract-defined`, with explicit
pending capability and state bindings. `requireCompositionRuntimeBindings`
rejects these pending bindings. These functions perform no SFC/DOM analysis,
browser execution, rendered visual adjudication or full acceptance. Exact
external capability commits and current-run state producer contracts remain
required before any runtime qualification. Their integration must retain the
canonical governance and visual lanes; this pure contract module is not an
alternate release runner.

The private repository package exposes the existing resolver, schema validator
and layout helpers through `@fsusblog/layout-governance` exports. Both test
packages consume its local file dependency; source files retain their canonical
owners. Install the locked tools and test-package links before running the schema
and identity negative controls:

```bash
npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator
npm ci --ignore-scripts --prefix tests/frontend
npm ci --ignore-scripts --prefix tests/tools
node --test tests/tools/layout-composition-contracts.test.mjs
```

These are synthetic contract mutations against the actual loaded definitions;
they are not product-source mutations or evidence that a page renders correctly.

## Composition source and DOM diagnostics

The existing `check:views-constraints` core command consumes the same matrix
through `check-layout-composition.mjs`. Its source graph uses the canonical
`@fsusblog/control-legality/source` parser/resolver and the actual `createRouter`
imports. A restricted AST interpreter follows constant objects, spreads, pure
path helpers, route maps and lazy component imports; unknown expressions fail
closed. It creates no route/file allowlist or alternate composition contract.
SFC nodes retain slots, branch directives, teleports, exact public/local import
origins and original source locations/digests. Public aliases follow their actual
export factories and unambiguous named/star reexports. Upstream module aliases
come from the actual FsusUI source path configuration, whose bytes are included
in the resolver identity and drift checks; a generated declaration bundle cannot
stand in for the active Vue source. Finite native alternatives retain every
resolved tag and reject an unresolved alternative. Unsupported dynamic components and state bindings remain
errors rather than a source-only acceptance result.

`compositionProbePlugin` adds test-only source markers before the actual Vue
compiler. It checks the original source bytes and rejects authored marker
attributes. It never writes product files. The browser probe retains hidden
nodes, joins native/component markers to parsed sources, and checks heading,
action, region, material, nesting, chrome and content-order observations.
Structural conditions inside a public component may be resolved only from that
exact call's literal props/defaults and statically provided slots, through the
actual parsed `computed`/`Boolean` expressions. The source graph binds all parsed
resolver inputs, including prop declarations. The DOM join checks each rendered
call's conditional element count; dynamic props, conditional/dynamic slots,
ancestor-dependent branches, loops and arbitrary functions remain unbound.
This bounded structural proof neither supplies product state bindings nor
qualifies a source-only result. A missing public surface/material emission stays
an upstream capability error even when the component's structural conditions
are proven.
An unbounded native `tag` prop can be proven only for an actual call whose
literal/default input resolves to a native tag. `nativePropBindings` bind that
call and its inputs; every rendered native prop node is checked against the
nearest matching call. A dynamic input or unknown component name remains an
`unbound-native-prop-source` error, and an actual mismatched tag is rejected.
The same binding follows `withDefaults(defineProps<...>(), ...)` only when the
inline type actually declares the prop and its default is an exact literal.
Shadowed macros, unknown defaults, object spreads and computed default keys
cannot establish proof. Referenced types remain unsupported and fail closed.
Call-level `v-bind` is bounded only for an object with literal keys and primitive
literal values. Unknown spreads, computed keys, prototype inputs and collisions
with another source of the same prop remain unbound; attribute precedence is
never guessed from separate inventories.
A native component selector may also have a finite tag union proven from an
actual top-level constant arrow function. Every return must be a native literal
or a conditional of native literals, and every path must return. The supported
flow is limited to blocks, conditionals and ordinary variable/expression
statements; unknown returns, fallthrough, async functions, loops, mutable or
template-shadowed bindings are rejected. Return type annotations establish no
proof. All rendered native union nodes are checked against the complete union,
including nodes without semantic ownership attributes. This proves possible
tags only; the selector's business state and branch visibility remain unbound.
Component-valued props remain deferred input edges in the canonical source
resolver. The standalone legality scan still refuses an unbound dynamic prop.
The composition graph resolves only actual declared props, supplied immutable
component imports, or zero-argument expression defaults that reach an actual
component source. A string name cannot borrow an imported component identity. It binds each result to the exact call chain and input digests;
unknown overrides, mutable aliases, template shadows, dynamic keys and ambiguous
spreads remain errors. An absent input is allowed only behind its actual prop
condition and cannot authorize a rendered component. The absence proof also
recognizes a prop required by a conjunction in an actual `v-if` or
`v-else-if`; negation, disjunction, aliases and shadowed bindings cannot prove
that an absent prop prevents rendering. The absence proof records that exact
guard. This supplies no product branch state or runtime acceptance. Vue setup prop forwarding
may exclude attrs only for a prop declared by that same component; arbitrary
spreads and arbitrary function results remain unknown. The DOM join checks the
proven call chain, declaration and inputs before accepting its rendered source.
A local supplied component retains local ownership even inside a public control.
These ordinary source controls do not issue semantic adapter receipts or qualify
runtime/product acceptance. Run them with the actual upstream source:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/path/to/FsusUI node --test tests/tools/layout-component-props-source.test.mjs
```

An object-destructured factory component can establish a bounded slot render
source only through its actual immutable function, literal arguments, straight
constant construction and unique returned field. The selected actual Vue
`defineComponent` must disable attrs fallthrough and return only its unchanged
default slot. The proof records the construction, factory, selected component
and render offsets/digests, evaluated arguments and complete source file digests.
Unknown callees, dynamic arguments, return branches, spreads, computed or duplicate
keys, mutations, async construction and altered slot render sources stay errors.
This describes the render source only; it does not register a wrapper, authorize
lifecycle behavior or grant public ownership to local components or slot children.
Source changes during the scan remain graph errors. Ordinary factory controls:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/path/to/FsusUI node --test tests/tools/layout-factory-source.test.mjs
```

An actual Vue `defineComponent` export in TS/TSX may bind a finite render
source through its exact setup and returned arrow function. Direct default
exports and immutable named exports follow the actual import graph. JSX and Vue
`h`/`createVNode` preserve native/component targets, attributes, branches and
unchanged slots with original source locations and digests. Instrumentation
inserts markers into the original opening tag or vnode props object. Unknown
children, constructors, props spreads, slot substitution/escape, mutation,
shadowing, setup return alternatives, async rendering and fallthrough remain
errors. A proven native target does not authorize opaque children. Route-name
visual branches remain errors in script render sources as well. This source
proof supplies no product state, receipt or runtime qualification.

Caller-provided classes or surface attributes cannot establish public provenance.
A missing upstream surface/material capability and unbound conditional state
remain failed observations. Receipt verification recomputes the joined verdict;
changing its errors, current source, worktree, design, contract, fixture, FsusUI
skill closure, analyzer closure or run identity invalidates it.

Run the executable analyzer tests with the actual local public API:

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/path/to/FsusUI node --test tests/tools/layout-composition-source.test.mjs tests/tools/layout-composition-contracts.test.mjs
FSUSBLOG_LOCAL_FSUSUI_ROOT=/path/to/FsusUI node tests/frontend/checks/runtime/check-layout-composition-probe.mjs
```

The probe generates isolated diagnostic fixtures from the existing contract and
records actual Chromium observations and targeted negative controls. Its baseline
keeps unresolved capabilities/state bindings visible. These fixtures are not
production routes or independent UX evidence. Static scans mark DOM `not-run`;
browser observations remain `diagnostic-only` and `fullVisualVerified: false`.
Authenticated production fixture binding, control admission and the separate
geometry/state and visual owners remain required. This analyzer neither runs the
complete geometry/state matrix nor issues visual adjudication.
