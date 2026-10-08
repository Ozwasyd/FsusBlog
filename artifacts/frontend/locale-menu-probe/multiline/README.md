# LocaleSelector multiline continuation — OPEN/WIP

Related to #1891 and Ozwasyd/FsusUI#830. This evidence does not close either issue.

The source repair and current local API/DOM verification passed at Blog
`e863c6fec58dab2de3029e759eb3c4c1f082f7d6` with FsusUI
`2f3707e6453abebcfd6579683e5685f97a17c9ac`. See `binding.json` for exact
commands, exit codes, run IDs, source trees, prerequisite identity and artifact
hashes. The source checkouts were clean when the browser run began.

The initial Blog baseline was verified origin/master
`3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`. Final fetch found master
`8b1c739cacef47995f441f096835863d377dc347`; only `.github/actionlint.yaml`
changed between these revisions. The CI-only movement was inspected, does not
change this implementation scope and was not incorporated into the task branch.

## Change and evidence

FsusUI now provides explicit DropdownItem `multiline`, `description` and `suffix`
content contracts. Natural height retains the canonical minimum and flat
selected/disabled/focus states. Dropdown `viewportBounded` delegates geometry to
existing Popper modifiers with consistent root CSS zoom coordinates. Default
single-line rows remain 34px. Shared Menu and shared usePopper were not changed.
Blog uses those public contracts and keeps only locale transaction/content/URL
semantics; it has no new private selector override or local menu owner.

The exact supplied #1892 commit `384112ac023a49a8a4fb605f31c05fbd25dd09f5` was
verified on `fix/interaction-trace-fixture-types-1892` and consumed without
conflict as `a19fe53018d1561b1e3bd6bdc2e678ce87ef34e7`. Its only file is the
InteractionTraceFixture public typing/attribute binding. This is not a claim
that every separate #1892 gate has completed.

Passed checks include 33 Blog selector/adapter/coordinator tests, 63 FsusUI
Dropdown/Popper/usePopper/CheckTag tests (CheckTag 3/3), FsusUI web typecheck,
local public export and isolated selector typing, targeted source lint,
interaction artifact conformance, test layout, documentation architecture,
design-domain checker and canonical theme build. Rebuilding theme CSS at the
exact FsusUI SHA reproduced the hashes used by the browser and production
fixture build (`built-css.json`). The consumer fixture production bundle passed
using the repository's ES worker format; this is not the complete application
production build.

The browser run retains ten locales and covers five viewport/theme/input
compositions: 375 light LTR; 1440 dark RTL; 375 dark RTL with forced colors and
reduced motion at CSS 2x; 375 light LTR CSS 2x; 320 light LTR CSS 2x with expanded
English descriptions. Every variant checks complete label presence, row
containment, document overflow and both axes of the panel viewport bounds. A
34px default-row assertion and removal-of-multiline clipping negative control
remain enforced. Keyboard, active/pending/retry, URL command adapter, compact,
disabled, outside focus and touch checks pass; browser errors are empty.
Screenshots were inspected for the changed labels, wrapping and focus surface.
The full-page images include a scrollable menu: rows above the viewport remain
in the DOM rather than being removed to pass dimensions.

`before-probe.json` retains real clipping/overflow before the repair. Other
negative files retain the newly introduced type errors before correction, the
premature unit focus assertion, outside-close sampling during a fade frame, and
the first production fixture build with omitted ES worker configuration. They
are failures, not environment exemptions. Current focus tests wait for actual
focus; outside close requires the public false visibility notification and DOM
cleanup. No fixed sleeps or weakened expected values were added.

## Remaining acceptance gates

The current published probe exits 3 because locked `@ozwasyd/element-plus@1.5.1`
is not installed. A fresh registry request exits 1 with E401. The local source
pass cannot qualify the inaccessible published package or establish identical
published/local semantics. Complete locked application install/build/typecheck
also remains blocked; prior full application build evidence remains in the
historical migration folder. No package was published and no pin was changed.

Qualified production-route preference/resource-service browser integration,
real browser 200% page zoom, and independent screen-reader/UX acceptance remain
not run. CSS zoom and an accessibility snapshot are separate limited evidence.
Nested or custom independently zoomed append contexts are not qualified.
Classification receipts record pre-change scope; no accepted UX receipt was
created. The smallest next action is to provide an accessible exact package
identity containing these public APIs with qualification evidence, then perform
published parity and independent product acceptance.

The original frozen branches retain their remote heads: Blog
`task/1891-locale-menu-probe` at `fbb90a21d029ea795060c7a5e6266b55e2eb067f`, and
FsusUI `task/830-dropdown-radio-items` at
`d4c9162e34ff002a0a34b491d4aea86d46ec2e4c`. This continuation is on separate
branches. FsusUI draft PR: https://github.com/Ozwasyd/FsusUI/pull/845.
No merge, deployment, issue closure or dependency-definition rewrite occurred.

Reproduce the production fixture build with:

```sh
node artifacts/frontend/locale-menu-probe/multiline/fixture-build.mjs /workspace/FsusBlog /workspace/FsusUI /tmp/chain-1891-production-fixture
```

Rollback requires a coordinated consumer rollback if reverting its required
public API; do not silently restore a second menu owner or fallback.

## Additional canonical visual and remote observations

At FsusUI `2f3707e6453abebcfd6579683e5685f97a17c9ac`, `pnpm visual:check`
passed its static conformance comparisons. A real `test:visual:affected
--base=origin/main` attempt built official icons, reused qualified WASM artifacts
and completed the official demo production build, then exited 1 before browser
suites: readiness rejected changed icons/demo source fingerprints. The official
icon producer introduced five tracked alias exports, recorded in
`canonical-generated-icons.patch`; only those task-generated changes were
restored afterwards. No gate, receipt, fingerprint or snapshot was bypassed or
fabricated. The generated setup change means this attempt is not an accepted
exact-source visual runtime receipt. The affected plan also flags the consumed
InteractionTraceFixture change as requiring the full profile; no full-profile
pass is claimed. The smallest next action is for the upstream artifact owner to
provide a qualified canonical preparation with stable source fingerprints, then
rerun the affected/full visual gates.

Remote FsusUI visual and macOS platform jobs reported FAILURE while other jobs
were queued/in progress. Job metadata identifies `Run visual suites` and `Run
platform-owned restore, build, tests, and smoke`; annotations give exit 1 without
a precise cause. Attempts to read redirected logs returned Forbidden. These are
unresolved remote failures, not classified as pre-existing or waived as an
environment exemption. Local applicable evidence may replace remote CI under
the user's instruction, but it does not establish these missing rendered/native
qualifications. No all-green CI claim is made.
