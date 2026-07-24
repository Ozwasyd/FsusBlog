# Theme token schema and CSS variable runtime

FsusBlog theme tokens use the versioned
`fsusblog.theme.tokens.v1` schema. The source document is build input; the
generated `styles/tokens.css` is the artifact included in `.fstheme`. Runtime
components never read the source document or package-private token names.

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

Both `light` and `dark` are required. Each contains non-empty `primitive`,
`semantic`, `component`, and `context` layers. Variants are partial overlays:
`reducedMotion` must override `motion.fast` and `motion.panel`;
`highContrast` must override page surface, primary text, and both baseline
borders.

Token references use an exact `{token.path}` value. They resolve only inside
the current mode or variant, and a missing reference or cycle fails closed.
Unknown schema properties, unsupported schema versions, unsafe CSS delimiters,
and duplicate names also fail validation.

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

`ThemeTokenCompiler` converts these names to stable `--fsus-*` variables.
For example, `surface.page` becomes `--fsus-color-page-bg`,
`text.primary` becomes `--fsus-color-text-primary`, and `motion.fast`
becomes `--fsus-motion-fast`. Component and context names are converted
deterministically, including camel-case segments such as
`table.row.hoverBg` -> `--fsus-table-row-hover-bg`.

## Scoped output

Generated CSS is deterministic UTF-8. Its lowercase SHA-256 is returned beside
the CSS and becomes part of the served URL.

```css
:root[data-theme="fsusblog.theme.minimal-ink"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-color-scheme="dark"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-reduced-motion="true"] { ... }
:root[data-theme="fsusblog.theme.minimal-ink"][data-high-contrast="true"] { ... }
```

The frontend accepts only same-origin `.css` URLs whose path contains the
declared 64-character SHA-256. It loads a candidate with `media="not all"`,
commits root attributes only after `load`, then removes the previous sheet.
This keeps the last valid theme visible during a switch and reduces unthemed
flash.

Theme selection order is per-user preview, site/scope active theme, then the
default theme. Color mode selection is explicit user mode, system
`prefers-color-scheme`, then the theme default. Reduced-motion and
high-contrast follow their media preferences and update root attributes when
the preferences change.

The runtime exposes a frozen snapshot. Callers can request a declared
selection but cannot mutate current state or turn a preview into the active
site theme. Persistence and atomic activation remain the responsibility of
the activation lifecycle.

## Migration rules

- Public UI consumes semantic tokens plus `public.*` and
  `article.*` context/component tokens.
- Admin UI consumes semantic tokens plus `admin.*`, table, form, and action
  component tokens.
- Console UI consumes semantic tokens plus `console.*`, log, code, and panel
  component tokens.
- Business components must not reference primitive palette variables or names
  private to a theme, such as `--minimal-ink-*`.
- Compatibility aliases, when needed, belong in platform-owned foundation CSS
  and must resolve to stable `--fsus-*` variables.

## Risk and no-restart fallback

The main risks are an invalid token graph, an unavailable content-hashed asset,
and contrast or motion regressions. Validation rejects invalid graphs before
CSS is emitted. A candidate stylesheet load failure leaves the current sheet
in place and retries the default descriptor. Operations can disable or replace
the active scope through the registry without restarting the service; preview
state never changes the active scope.
