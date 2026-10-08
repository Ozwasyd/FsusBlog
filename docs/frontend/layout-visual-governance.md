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

## Structured visual adjudication contract

`inspectCompositionObservationDiagnostic` from the existing
`@fsusblog/layout-governance/visual-producer-admission` entry consumes the
canonical composition source, route and DOM APIs. It rebuilds the route graph,
binds actual source/worktree/FsusUI/parser identities, and projects the declared
scene state ID from the sole matrix into the analyzer's dimension-to-ID input.
An undeclared state fails; loading or asset states do not default to a selected
Settings tab. Caller loaders, graphs and verifier callbacks are forbidden.

This consumer is diagnostic only. Missing public exports refuse explicitly;
combined source/DOM observations cannot become separate static and DOM receipts.
Unknown conditional and public-surface errors remain blocking, while runtime
state origin, geometry and rendered field adjudication remain independent gates.
Its declaration mapping does not qualify any current-run state fixture.

`config/schemas/layout-visual-adjudication.schema.json` owns the exact ten visual
rubric fields. `tests/frontend/support/layout/visualAdjudication.mjs` independently
checks their states, evidence references, source and scene bindings, content
digests, and the sole visual ledger. It consumes the composition identity from
`compositionContracts.mjs`; it does not define another matrix, contract map,
rubric, score, or baseline approval list.

A field marked `pass` requires screenshot, static, rendered DOM, and geometry
evidence for the same source/worktree, FsusUI baseline, contract, fixture, state,
theme, viewport, and current run. A machine failure cannot be overridden by a
visual pass. `fail` requires a canonical reason, an exact rubric field, a field
from the applicable composition contract, and an atomic production issue
reference. `not-observed` keeps the receipt incomplete. Baseline creation or
movement requires the existing ledger's exact entry digest/classification and
the explicitly supplied old/new screenshot digests. Schema, rubric, and verifier
identities invalidate receipts when their consumed bytes change.

Canonical source/DOM diagnostics can be consumed through the bounded API above.
Qualified static/DOM scene admission and geometry producer adapters remain
pending, so every production `rendered` verification still fails with
`layout-visual-producer-adapter-unavailable`. Callers cannot supply an alternate
verification callback or replace that authority with a status bit. Current-run
state/viewport fixture admission and production-positive verification remain
pending with those producers. Public issue existence and atomic scope also need
independent evidence before a production visual failure can be qualified.

Run the contract self-tests with:

```bash
node --test tests/tools/layout-visual-adjudication.test.mjs
```

Every test artifact is explicitly synthetic. Test-only success returns
`qualificationEligible: false`; it does not adjudicate a real page, qualify local
or published FsusUI, approve a baseline movement, or provide release acceptance.
Local/published parity checks preserve the same rubric/contract/fixture and
verify receipt seals, but never substitute for independent verification of both
actual source modes. Real adjudication and complete evidence aggregation remain
separate owners.

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

## Aggregation preflight and mutation admission

The existing `check:views-constraints` core dependency owns the aggregation
preflight. Set `FSUSBLOG_LAYOUT_AGGREGATION_PREFLIGHT=1` on that command to inspect
its declared coverage. The preflight reports `not-executed`,
`qualificationEligible: false` and exit 1. The default command retains its
existing static checks; a static pass does not qualify full visual acceptance.
There is no second layout runner or selectable verification callback.

`tests/frontend/support/layout/layoutAggregation.mjs` derives demands from every
representative and required state in the sole archetype matrix and its referenced
viewport/theme/media sources, for both local and published modes. It preserves
literal dimension values and their source references. Symbolic desktop/mobile,
high-contrast and zoom descriptors are not silently converted into browser
scenes. Actual viewport, native zoom, forced-colors, state readiness and fixture
admission remain the browser producer's authority. Derived demands are temporary
contract data, not a second maintained matrix or proof of scene execution.

`config/schemas/layout-aggregation-request.schema.json` owns the strict preflight
request, receipt-reference cardinality, 25 mutation observation IDs and ten
success counters. The IDs represent the required 18 controls plus seven extra
runner/matrix/ledger/pixel/mode/lane/job downgrade controls. Each observation
retains not-executed, killed or survived and evidence references. A caller's
claimed kill cannot certify that a product mutation was executed or rejected.
The current self-tests check this interface and downgrade refusal only; product
mutations awaiting source/browser/adjudication producers remain unexecuted.

`inspectLayoutReceiptCoverage` checks exact-one references per declared demand
and evidence kind. `inspectLayoutAggregation` additionally checks current
source/worktree/run/attempt, local/published composition identities freshly
derived from the supplied current baseline/source and consumed inputs, exact artifact bytes and mutation-reference
shape. Every diagnostic remains ineligible for qualification. Reference deficits
are reported separately and cannot prove archetype coverage
or evidence freshness. Only the current contract validation counter can be
zero; all nine remaining success counters stay `null` until canonical producers
independently verify them. Unknown is never zero.

`requireFullLayoutAggregate` rejects focused/static-only/not-executed requests,
incomplete coverage and finally unavailable canonical producer adapters. Even
complete references, opaque bytes and all claimed kills cannot issue a full
receipt. The current implementation has no release-final authority or CI
transport registration; those integrations must consume actual producer APIs
and the existing current-run locator, transport and required-evidence owners.
Job success, artifact names, URLs, old receipts and published fallback to local
cannot replace that authority.

Run the non-qualifying interface tests with the locked packages installed:

```bash
node --test tests/tools/layout-aggregation.test.mjs
FSUSBLOG_LAYOUT_AGGREGATION_PREFLIGHT=1 npm --prefix src/frontend run check:views-constraints
```

The second command is deliberately blocked before subsequent static dependencies
run. It does not weaken their normal execution or overwrite any prior failure
artifacts. Keep each failed attempt and subsequent rerun under distinct run-bound
artifact paths; this preflight is not an attempt/failure evidence producer.

## Canonical origin and browser consumer admission

`visualProducerAdmission.mjs` consumes the existing current-run evidence locator,
publication payload resolver, transport mapping and managed browser identity
APIs. It registers no producer or authority. `inspectVisualProducerAdmission`
requires visual and browser origin inputs, both verified against the
same scheduler context. Each origin supplies a registered `consumerId`, exactly
one explicit path or content-addressed reference, and, for transported evidence,
an explicit manifest path/digest. The consumer reads the sole canonical registry;
caller registries, callbacks, directory scans, filenames and mtime cannot replace
it. Production calls use this repository; temporary repositories are limited to
explicit synthetic contract tests and never qualify acceptance.

The consumer resolves actual payload bytes, verifies their seals and exact
source/worktree/run/attempt binding, and checks every explicit screenshot,
static, DOM and geometry artifact plus opaque producer bytes against the visual
receipt. Locator digests retain the canonical `sha256:` prefix, while visual
artifact digests remain bare SHA-256 hex. That conversion is explicit at this
boundary; it does not reinterpret opaque producer schemas.

`inspectVisualBrowserBinding` verifies the actual browser seal and rendering
observation, then recreates the current managed browser plan from the real
policy, SDK package/catalog, executable, fonts and locale sources. It has no
caller filesystem, package resolver, policy or verification callback override.
By itself it proves identity consistency only: a browser payload has no
source/run identity until its separate canonical origin is admitted. Browser
identity and an envelope do not prove that a particular product scene ran.

`visualProducerAdmissionIdentity` binds the consumer and consumed canonical
source/authority bytes. Its `producerAdmissionDigest` is a required visual
receipt field returned by `visualVerifierIdentity`; old receipts or loaded
consumers are rejected when that closure changes. Downstream producers consume
these exported identities instead of independently deriving their own hashes.

For rendered receipts, `verifyVisualAdjudication` invokes admission when its
context supplies `producerAdmission`. Foundation admission still returns
`qualificationEligible: false`, and the rendered path always refuses the
unavailable static/DOM and geometry producer adapters. Missing registered visual
and browser origins, opaque-producer-to-artifact mapping, current fixture/state
admission and scene execution remain explicit pending capabilities. No current
helper signs a visual pass, real mutation kill, source-mode qualification or full
aggregate.

Run the consumer contract negatives with:

```bash
node --test tests/tools/layout-visual-producer-admission.test.mjs
```

These tests use labelled synthetic publication payloads and existing registry
entries without creating visual authorities. Actual managed-browser probes and
local/transport packet probes must retain their narrower identity/transport
scope; they are not product-scene or visual adjudication receipts.

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
