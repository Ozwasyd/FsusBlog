# Rendered review

Resolve the [active baseline](baseline-resolution.md), identify the candidate and affected surfaces, and consult [`docs/web-validation.md`](../../../../docs/web-validation.md) and [`../FsusUI/docs/design.md`](../../../../../FsusUI/docs/design.md). Read only the applicable product contracts under `docs/product/`.

Inspect real rendered output (built `src/Web/dist` served by the current `FsusBlog.V2.Server` against an isolated PostgreSQL database in headless Chromium/Playwright) across realistic short, long, empty, loading, error, success, disabled, and partial states where applicable. Cover desktop and mobile widths, light and dark themes, locales (`zh-CN` / `en`), keyboard focus, horizontal overflow, console/page errors, and reduced motion as relevant to the change.

Record what was actually rendered and inspected, what failed, and what remains unverified. Compilation, `vue-tsc`, static checks, mocks, historical screenshots, or zero diff do not prove an untested rendered state.

A read-only review reports evidence and findings; it does not acquire write permission or authorize a redesign. Formal UX acceptance additionally requires [orchestrated UI](orchestrated-ui.md): independent verification evidence, exact candidate/baseline/authority/domain-policy bindings, behavior green, and a valid acceptance receipt. Rejection grants veto authority only.

Do not weaken fixtures, baselines, thresholds, or acceptance mappings to obtain a pass. Without inspected current rendered evidence, report the missing coverage rather than signing UX accepted. Contract checker self-tests are not application render evidence.
