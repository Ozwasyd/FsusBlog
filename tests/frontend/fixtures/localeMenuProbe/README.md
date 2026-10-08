# Locale menu public API and consumer probe

This disposable fixture exercises the public FsusUI primitives and the actual
`LocaleSelector.vue` composition for [#1891](https://github.com/Ozwasyd/FsusBlog/issues/1891).
It imports public component exports, uses the canonical local-source resolver,
and delegates menu interactions to Dropdown. Consumer settlement controls model
pending/failure/retry/commit; they are not a browser-backed preference service.

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/checks/runtime/probe-locale-menu.mjs local /workspace/FsusUI /tmp/locale-menu-local
PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/checks/runtime/probe-locale-menu.mjs published /workspace/FsusBlog/src/frontend /tmp/locale-menu-published
FSUSBLOG_LOCALE_PROBE_REAL_ZOOM=1 PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/checks/runtime/probe-locale-menu.mjs local /workspace/FsusUI /tmp/locale-menu-browser-zoom
```

Use Node 24 and installed Vite, its Vue plugin, Vue and Playwright from the
specified dependency root. Published mode requires the installed locked
`@ozwasyd/element-plus@1.5.1`; it never substitutes local source. Exit 0 means the
covered checks passed, 2 means an observed capability gap, and 3 means the probe
could not complete. Every report keeps `qualification=false`, exact source/tree
identities, dirty status, harness/authority hashes, runtime, browser and run ID.
DOM/focus conditions and animation completion establish results; cold module
navigation has a bounded timeout. Browser/server resources close in `finally`.

The initial clean FsusUI main probe found invalid single-selection semantics.
[FsusUI #830](https://github.com/Ozwasyd/FsusUI/issues/830) and its
[draft #836](https://github.com/Ozwasyd/FsusUI/pull/836) now supply the public
`checked` contract, checked-item keyboard entry and Escape restoration, including
Escape on a pointer-opened trigger. The narrow implementation remains on
`task/830-dropdown-radio-items`; shared Menu and option-row geometry were not
modified. Original raw pre-capability reports remain in the artifact directory.

The Blog source now composes Dropdown/Menu/Item/Button, has no local document
pointerdown, item refs, roving keyboard or popup surface CSS, maps selection from
the committed locale, and preserves product URL commands and async status.
The runtime projection supplies the failed retry target and ignores superseded
success/failure callbacks. Current component/runtime/coordinator unit tests cover
33 cases. Export and isolated LocaleSelector local typechecks pass. Tests mount
real teleported primitives; browser evidence covers the actual composition.

Current migration reports and command logs are archived under
`artifacts/frontend/locale-menu-probe/migration/`; inspect their exact bindings
rather than treating older observations as current acceptance. The probe records
ten locale names, checked state, pending/failure/retry/commit, URL activation,
keyboard, repeated dismissal, disabled/compact and touch observations, accessibility
snapshot, light/dark, RTL-direction projection, forced colors and reduced motion.
RTL here changes item/container direction without inventing a supported locale.
The default 2x cases use CSS zoom. Setting `FSUSBLOG_LOCALE_PROBE_REAL_ZOOM=1`
also runs the actual consumer at browser 200% zoom through
[`chrome.tabs.setZoom/getZoom`](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom)
in a task-scoped extension, using the official
[Playwright Chromium extension setup](https://playwright.dev/docs/chrome-extensions).
It requires getZoom=2, doubled DPR, a reduced CSS viewport and root CSS zoom=1,
then checks ten radio items, one checked item, keyboard entry/Home/End/Escape,
labels, both popup bounds and document overflow in narrow/light, wide/dark/RTL
and narrow/dark/RTL/forced-colors states. Extension/profile resources are removed
in `finally`. A missing capability fails the requested probe; it does not silently
substitute CSS zoom. This remains component evidence, not the #2228 live-backend
viewport acceptance workflow or independent UX qualification.

#1891 remains **WIP / blocked**, not complete:

- Original multiline clipping and CSS 2x overflow are repaired in the local
  FsusUI candidate by the public opt-in `multiline` description/suffix and
  `viewport-bounded` contracts. Default 34px rows remain. Bound local evidence is
  in `artifacts/frontend/locale-menu-probe/multiline/`; current source and actual
  run identity must be checked before using any receipt.
- Locked published package installation returned GitHub Packages HTTP 401;
  public npm lookup returned 404 and authorized package metadata access returned
  403. Published probing is blocked. No credentials or package identity were
  fabricated; package publishing is not authorized.
- Full production build is blocked by the incomplete dependency installation
  (`@tailwindcss/vite` missing). Broader consumer typecheck reaches unrelated app
  sources and missing dependencies and fails; it is not a successful full check.
- Production-route preference integration, independent screen-reader review and
  complete qualified viewport/theme/input coverage remain open. An accessibility
  snapshot is not screen-reader acceptance; the optional zoom probe alone does
  not qualify the full product workflow.

The coordinator needs exact current upstream/runtime evidence and an accessible
published package identity with the checked/multiline APIs before release
qualification. Canonical icon/theme source belongs to FsusUI #842 / original
Blog #1805 and is consumed only through the parent's exact handoff. No issue
closure, merge, deployment, fallback or UX acceptance receipt is performed by
this task.
