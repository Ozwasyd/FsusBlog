# Theme token schema and CSS variable runtime

FsusBlog theme tokens use versioned `fsusblog.theme.tokens.v1`. The source document is build input; generated `styles/tokens.css` is the `.fstheme` artifact. Runtime components never read the source document or package-private token names.

## Document shape

```json
{
  "schema": "fsusblog.theme.tokens.v1",
  "defaultMode": "light",
  "modes": {
    "light": {
      "primitive": {
        "color.gray.50": "#ffffff",
        "motion.fast": "120ms"
      },
      "semantic": {
        "surface.page": "{color.gray.50}",
        "text.primary": "#111827"
      },
      "component": {
        "card.bg": "{surface.page}"
      },
      "context": {
        "public.home.hero.bg": "{surface.page}"
      }
    },
    "dark": {}
  },
  "variants": {
    "reducedMotion": {
      "primitive": {
        "motion.fast": "0ms",
        "motion.panel": "0ms"
      }
    },
    "highContrast": {
      "semantic": {
        "surface.page": "Canvas",
        "text.primary": "CanvasText",
        "border.default": "CanvasText",
        "border.subtle": "CanvasText"
      }
    }
  }
}
```

`light` and `dark` are required, each with non-empty `primitive`, `semantic`, `component`, and `context` layers. Variants are partial overlays: `reducedMotion` must override `motion.fast` and `motion.panel`; `highContrast` must override page surface, primary text, and both baseline borders.

References use an exact `{token.path}` value and resolve only in the current mode or variant; missing references and cycles fail closed. Unknown properties, unsupported schema versions, unsafe CSS delimiters, and duplicate names also fail validation.

## Required semantic contract

Every light and dark mode defines:

```text
surface.page
surface.panel
surface.elevated
surface.overlay
text.primary
text.secondary
text.muted
text.inverse
border.default
border.subtle
action.primary.bg
action.primary.text
status.success.bg
status.warning.bg
status.error.bg
```

`ThemeTokenCompiler` deterministically converts names to stable `--fsus-*` variables: `surface.page` → `--fsus-color-page-bg`, `text.primary` → `--fsus-color-text-primary`, `motion.fast` → `--fsus-motion-fast`, and `table.row.hoverBg` → `--fsus-table-row-hover-bg` (including camel-case segments).

## Scoped output

Generated CSS is deterministic UTF-8; its lowercase SHA-256 is returned beside the CSS and embedded in the served URL.

```css
:root[data-theme="fsusblog.theme.minimal-ink"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-color-scheme="dark"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-reduced-motion="true"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-high-contrast="true"] { ... }
```

The frontend accepts only same-origin `.css` URLs whose path contains the declared 64-character SHA-256. It loads a candidate with `media="not all"`, commits root attributes after `load`, then removes the previous sheet, keeping the last valid theme visible and reducing unthemed flash.

Theme selection is per-user preview → site/scope active → default. Color mode is explicit user mode → system `prefers-color-scheme` → theme default. Reduced-motion and high-contrast follow media preferences and update root attributes when preferences change.

The runtime exposes a frozen snapshot. Callers may request a declared selection but cannot mutate current state or make a preview the active site theme; persistence and atomic activation belong to the activation lifecycle.

## Migration rules

- Public UI consumes semantic + `public.*`/`article.*` context/component tokens.
- Admin UI consumes semantic + `admin.*`, table, form, and action component tokens.
- Console UI consumes semantic + `console.*`, log, code, and panel component tokens.
- Business components must not reference primitive palette variables or theme-private names such as `--minimal-ink-*`. Compatibility aliases belong in platform-owned foundation CSS and must resolve to stable `--fsus-*` variables.

## Risk and no-restart fallback

Risks are an invalid token graph, unavailable content-hashed asset, or contrast/ motion regression. Validation rejects bad graphs before CSS emission. A candidate stylesheet failure leaves the current sheet in place and retries the default descriptor. Operations can disable/replace the active scope through the registry without restart; preview never changes the active scope.
