# Locale menu public API probe

This disposable browser fixture probes the prerequisite public API for [#1891](https://github.com/Ozwasyd/FsusBlog/issues/1891). It imports public root components and delegates every menu interaction to FsusUI. It is not a second product selector or a compatibility fallback.

Use Node 24 and installed Vite, the Vue Vite plugin, Vue, and Playwright from `DEPENDENCY_ROOT`. Local mode uses the repository's canonical FsusUI resolver and aliases, including its built-asset checks. Published mode requires the actually installed, locked `@ozwasyd/element-plus@1.5.1`; an unavailable package is a blocker, never substituted with local source.

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/probes/locale-menu/run.mjs local /workspace/FsusUI /tmp/chain-1891-local-final
PLAYWRIGHT_BROWSERS_PATH=/tmp/chain-1891-browsers node tests/frontend/probes/locale-menu/run.mjs published /workspace/FsusBlog/src/frontend /tmp/chain-1891-published-final
```

The runner writes `probe.json` and screenshots, records the tested Blog commit, local source commit/tree/status, harness and authority digests, runtime and browser identity, and closes its browser/server in `finally`. It waits for DOM/focus conditions and animation completion; no fixed sleep establishes an async or focus result. Exit 0 means the tested Dropdown capability checks passed, 2 means an observed capability gap, and 3 means the probe could not complete. None of these statuses establishes product UX acceptance.

## Current source-bound result

- Blog baseline: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`; fetch succeeded and remote master, origin/master, and initial HEAD matched.
- Tested probe commit: `646d8c1a2293fa0b35eb76f8343b7f2711bbf97d`.
- Local FsusUI: clean `main@f2b3bb89ffe5f749da26c388f058efdbb6aee864`, tree `2adf025d6874fe626b95d03538f3148cfd71a911`.
- Run: `locale-menu-local-2026-10-08T02:42:27.120Z`, Node `v24.19.0`, Chromium `147.0.7727.15`, 1440×900 light viewport.
- Local probe: exit 2, `capability-gap`, no page errors. The actual DropdownItem role is `menuitem` despite the supplied `menuitemradio`; its `aria-checked=true` therefore has incompatible semantics. [FsusUI #830](https://github.com/Ozwasyd/FsusUI/issues/830) owns the missing public capability.
- Passed observations: public open/close and visibility events; trigger association; ArrowUp/Down/Home/End; Enter/Space command activation; pending remains open; error/retry stays reachable; disabled activation is rejected; Escape returns focus to the trigger; outside dismissal preserves focus on the outside target; custom compact trigger content renders.
- Alternatives: Dropdown + Menu preserves a passed radio role, but keyboard entry fails and ArrowDown closes the popup; ArrowDown on its focused first item fails to advance. Single Select closes while active `en` remains uncommitted and pending becomes `ja`; its retry footer is then inaccessible.
- Mixed items: a nested anchor navigates by pointer, but Enter on its DropdownItem emits a command without navigation. An explicit product activation adapter is allowed by #1891 and remains to be validated; this observation is not promoted to a separate upstream capability gap.
- Published probe: exit 3, `blocked`, because the locked package could not be installed. `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/chain-1891-npm-cache` returned 401 for the GitHub Packages tarball. A query from `/tmp` against `https://registry.npmjs.org` returned 404. No credentials were invented or persisted.

Raw current reports, screenshots, and the failed locked-install log are under `artifacts/frontend/locale-menu-probe/`. The screenshots were inspected for pending, visible error/retry, and the alternate Menu composition; they are minimal primitive fixtures rather than production-route evidence. The evidence-only follow-up commit does not change the tested harness bytes.

## Remaining acceptance gates

#1891 is **waiting**, not complete. Its existing implementation was not migrated because the mandatory probe found a public API gap. No issue body or dependency definition was rewritten in this phase; the coordinator must account for #830 as the newly discovered prerequisite.

Resume only after the coordinator supplies the exact upstream capability commit, its dynamic acceptance evidence, and an accessible published package identity. Then rerun both modes and perform the one-way LocaleSelector migration, preserving locale transactions, latest-wins, URLs, pending/error/retry and compact presentation.

Product unit, i18n lifecycle, a11y, viewport, negative-control, full build/type checks and independent UX acceptance are still pending. The 10-locale, CJK/Latin/Cyrillic/RTL, 375/1440, 200% zoom, Light/Dark, keyboard/touch/screen-reader, forced-colors, reduced-motion, cleanup and interruption/repetition acceptance matrix has not been executed for a migrated product. Published product checks are additionally blocked by the locked-package install failure. No acceptance receipt, fallback, private selector/import, or new Blog-local menu owner was added.
