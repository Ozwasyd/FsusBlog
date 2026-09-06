# Rendered review

Resolve the [active baseline](baseline-resolution.md), identify the candidate and affected surfaces, and consult the relevant [visual governance](../../../../docs/frontend/layout-visual-governance.md) sections. Read only the applicable profile and domain contracts.

Select the affected entries from the [layout archetypes](../../../../tests/frontend/fixtures/layout-archetype-matrix.json), [viewport matrix](../../../../tests/frontend/fixtures/ux-viewport-matrix.json), and [content boundary corpus](../../../../tests/frontend/fixtures/ux-content-boundary-corpus.json). Preserve the mandatory state/viewport/input matrix frozen for a formal task.

Inspect realistic short, long, empty, loading, error, success, disabled, permission, and partial states where applicable, across relevant themes, locales, widths, keyboard focus, zoom, overflow, and reduced motion. Record what was actually rendered and inspected, what failed, and what remains unverified. Compilation, static checks, a snapshot command, or zero diff do not prove an untested state.

A read-only review reports evidence and findings; it does not acquire write permission or authorize a redesign. Formal UX acceptance additionally requires [orchestrated UI](orchestrated-ui.md): a fresh read-only verifier, distinct implementation/verifier run identities, exact candidate/baseline/authority bindings, behavior green, and a valid acceptance receipt. Rejection grants veto authority only.

Do not weaken fixtures, baselines, thresholds, or acceptance mappings to obtain a pass. Without inspected current rendered evidence, report the missing coverage rather than signing UX accepted. Contract checker self-tests are not application render evidence.
