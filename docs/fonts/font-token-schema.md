# Font token schema and stack runtime

FsusBlog font tokens use schema version `1.0.0`. The token names are public,
stable inputs to themes and components; installed font IDs and file paths are
runtime values and must not be embedded in theme CSS.

## Token hierarchy

| Layer | Tokens |
| --- | --- |
| family | `font.family.ui`, `font.family.prose`, `font.family.code`, `font.family.cjk`, `font.family.emoji` |
| weight | `font.weight.regular`, `font.weight.medium`, `font.weight.bold` |
| size | `font.size.body`, `font.size.article`, `font.size.code`, `font.size.caption` |
| line height | `font.lineHeight.body`, `font.lineHeight.article`, `font.lineHeight.code` |
| letter spacing | `font.letterSpacing.ui`, `font.letterSpacing.prose`, `font.letterSpacing.code` |
| semantic | `typography.body.*`, `typography.article.*`, `typography.heading.*`, `typography.code.*`, `typography.admin.table.family` |

The machine authority is `FontTokenSchema` in
`src/shared/Contracts/Fonts/FontTokenSchema.cs`. Adding, removing, or renaming a
token requires a schema version change and coordinated theme/component
migration.

Semantic family tokens reference a `font.family.*` token. A theme cannot place
an arbitrary `font-family` string in a semantic token. The runtime rejects that
input with `font_theme_reference_invalid`, which keeps theme selection separate
from package identity and prevents CSS injection.

## CSS variables

`IFontStackRuntime` resolves one registry activation and emits:

```css
:root {
  --fsus-font-ui: "Google Sans", "Noto Sans SC", system-ui, sans-serif;
  --fsus-font-prose: "Noto Sans SC", "Noto Sans TC", system-ui, sans-serif;
  --fsus-font-code: "JetBrains Mono", ui-monospace, monospace;
  --fsus-font-cjk: "Noto Sans SC", "Noto Sans TC", system-ui, sans-serif;
  --fsus-font-emoji: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  --fsus-typography-body-family: var(--fsus-font-ui);
}
```

The checked-in critical/full frontend foundations declare the same built-in
fallback variables. This prevents a blank or unreadable shell before a runtime
selection is available. Components consume semantic variables; Tailwind's
`--font-sans` and `--font-mono` are compatibility aliases to the stable family
variables.

## Locale and script fallback

Explicit content script metadata wins over locale. Unknown scripts use the
Latin/system fallback.

| script / locale | ordered CJK fallback |
| --- | --- |
| Latin / other | `Noto Sans SC` -> `Noto Sans TC` -> `Noto Sans JP` |
| `Hans`, `zh-CN`, other Simplified Chinese | `Noto Sans SC` -> `Noto Sans TC` -> `Noto Sans JP` |
| `Hant`, `zh-Hant`, `zh-HK`, `zh-MO` | `Noto Sans TC` -> `Noto Sans SC` -> `Noto Sans JP` |
| `Jpan`, `ja-*` | `Noto Sans JP` -> `Noto Sans SC` -> `Noto Sans TC` |
| code | selected code font -> `ui-monospace` -> platform monospace |
| emoji | platform emoji fonts -> optional selected emoji family -> `sans-serif` |

Every resolved UI/prose/CJK stack ends in a system sans family, every code
stack ends in `monospace`, and every emoji stack ends in `sans-serif`.

## Failure and rollback

Missing scopes fall back to the default activation. Missing, disabled,
category-mismatched, or CSS-unsafe role selections fall back to the matching
built-in role and set `UsedSafeFallback=true`; a failed active font therefore
never removes the default stack. Invalid theme references fail closed rather
than becoming CSS.

Operational rollback does not require a restart: activate the five built-in
font IDs for the affected scope. The next resolution observes the incremented
registry `configVersion`. Asset selection is compiled by the
[Font loading planner](font-loading-planner.md); token resolution itself never
downloads or probes a font.
