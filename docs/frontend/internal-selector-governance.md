# Internal selector governance

`tests/frontend/internal-selector-registry.json` is the machine-readable source for production `:deep()` and direct `.el-*` overrides. The local `check:internal-selector-governance` reads source and registry without GitHub, CI, or network access.

## Ownership classification

Every retained selector must register `path`, `kind`, `selector`, `occurrences`, `owner`, `reason`, `expiresOn`, and `replacementIssue`:

- `FsusUI`: Blog depends on component-internal DOM/BEM; migrate to a public prop, slot, token, variant, or stable data hook.
- `FsusBlog`: the rule crosses consumer-owned markup or generated content; move style to the markup owner or a stable business class/data hook.
- `third-party`: only uncontrollable third-party markup; the reason must state the boundary and replacement plan, never disguise an FsusUI/Blog gap.

One path may inherit ownership metadata through `selectors`, but each selector's kind, text, and occurrence count remains separate. Expired, duplicate, or missing-but-not-removed entries fail closed.

## Monotonic budget

`maximumDeepOccurrences` and `maximumDirectElOccurrences` may only decrease as debt is migrated. An unregistered new selector fails even below budget; removing one without lowering the budget or deleting its stale entry also fails. PublicShell and ThemeModeToggle internals can never receive an exemption.

Do not reduce debt by rewriting `:deep()` as global `.el-*`, copying FsusUI SCSS, using `!important`/negative margin/absolute-position compensation, or deleting styles while accepting clipped focus rings, arbitrary control heights, or unexplained pixel fallbacks.

## Migration evidence

For each migration, first pin selector counts and business states with a failing test. Visible geometry must cover Light/Dark and desktop/mobile with key bounding boxes; a non-redesign change may differ by at most `1px`, and a focus-visible ring by at most `2px`. Allowed values are control heights `40/44/48px`, spacing `4/8/12/16/20/24/32px`, and opt-in radii `4/6/10/12/24px`.

Record this baseline, per-surface reduction, and real-browser evidence status in `tests/frontend/internal-selector-migration-evidence.json`; `null` or `pending` is not passed and must not be reported as green in issue or release evidence. `check:fsusui-boundary` also rejects FsusUI internal-DOM queries in scripts. Form-error focus and similar behavior must use `aria-invalid` or a consumer-owned stable data hook.

No-restart rollback is per static-asset slot: restore the last verified frontend asset. A rollback may temporarily restore an unexpired registry entry, but never PublicShell internals, a wider budget, or a disabled fail-closed gate.
