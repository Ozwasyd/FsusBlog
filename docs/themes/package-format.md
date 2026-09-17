# FsusBlog theme package format

`.fstheme` is a ZIP container for declarative CSS, assets and a closed
configuration schema. It is infrastructure input, not an executable plugin
format. Packages cannot request script, network or filesystem access.

## Minimum package

```text
minimal-ink.fstheme
├── manifest.json
├── styles/
│   ├── tokens.css
│   └── theme.css
├── assets/
│   └── preview.png
└── config/
    └── schema.json
```

The five files above are mandatory. Optional package paths include
`styles/prose.css`, `styles/code.css`, additional manifest-declared assets,
`i18n/*.json` and `docs/README.md`. Every entry must use a canonical,
case-unique, relative `/`-separated path. Absolute paths, `..`, `.`, empty
segments, backslashes, drive prefixes, duplicate paths and symbolic links are
rejected.

The compressed package is limited to 16 MiB, expanded content to 8 MiB and the
entry count to 128. These platform ceilings apply in addition to the tighter
budgets declared by the manifest.

## Manifest

`manifest.json` is UTF-8 JSON with this v1.3 shape:

```json
{
    "id": "fsusblog.theme.minimal-ink",
    "name": "Minimal Ink",
    "version": "1.0.0",
    "fsusblog": ">=1.3.0 <1.4.0",
    "author": "example",
    "description": "A minimal reading-focused theme",
    "type": "theme",
    "entry": {
        "tokens": "styles/tokens.css",
        "theme": "styles/theme.css",
        "prose": "styles/prose.css",
        "code": "styles/code.css"
    },
    "modes": [
        "light",
        "dark"
    ],
    "supports": {
        "public": true,
        "admin": false,
        "console": false,
        "highContrast": true,
        "reducedMotion": true,
        "rtl": false
    },
    "assets": {
        "preview": "assets/preview.png"
    },
    "configSchema": "config/schema.json",
    "permissions": {
        "script": false,
        "network": false,
        "filesystem": false
    },
    "budgets": {
        "cssBytes": 65536,
        "assetBytes": 524288,
        "maxSelectors": 512,
        "maxSelectorDepth": 4,
        "maxImportant": 8,
        "maxMotionDurationMs": 1000,
        "previewBytes": 262144
    }
}
```

`id` uses the lowercase `fsusblog.theme.*` namespace. `version` is semantic
version text. `fsusblog` is a whitespace-separated conjunction of numeric
`>=`, `>`, `<=`, `<` or `=` constraints. Package installation rejects a range
that does not include the configured runtime version.

The minimum paths have fixed roles: `entry.tokens` is
`styles/tokens.css`, `entry.theme` is `styles/theme.css`,
`assets.preview` is `assets/preview.png`, and `configSchema` is
`config/schema.json`. All other manifest paths must resolve to entries in the
same archive.

`styles/tokens.css` is generated from the versioned token source contract
described in [Theme token schema and CSS variable runtime](token-schema.md).
It must use stable `--fsus-*` variables and theme-scoped root selectors.
Primitive/package-private names are build input only and are not a component
API. The compiler returns the exact CSS SHA-256 used by the content-addressed
runtime URL; the package does not gain a remote loading permission.

All permission values must remain `false`. CSS and asset bytes are measured
from the expanded entries and must fit both the manifest budgets and the
platform ceilings: CSS 64 KiB, all declared image assets 512 KiB, preview image
256 KiB, 512 selectors, selector depth 4, eight `!important` declarations and
1000 ms motion duration. A manifest cannot raise those ceilings. Installation
and every activation run the fail-closed scanner described in
[Theme CSS safety](css-safety.md); byte counting alone is not acceptance.

## Configuration schema

`config/schema.json` is a closed object schema:

```json
{
    "type": "object",
    "additionalProperties": false,
    "properties": {
        "fontScale": {
            "type": "number"
        },
        "showAuthor": {
            "type": "boolean"
        }
    },
    "required": [
        "showAuthor"
    ]
}
```

The v1.3 infrastructure supports `string`, `number`, `integer`, `boolean`,
`array`, `object` and `null` property types. Unknown properties, mismatched
types and missing required properties fail closed before a new config version
is persisted. This is intentionally a constrained schema subset; it is not a
general JSON Schema evaluator.

## Hashes and persisted state

The validator records a lowercase SHA-256 hash for the exact `.fstheme` bytes,
each expanded entry and every manifest-declared asset. The registry persists
the manifest, config schema, package hash, atomic local package location,
install state and enabled flag. Storage writes into a same-filesystem staging
directory, flushes the exact package as `archive.fstheme`, rechecks every hash
while expanding entries below `content/`, then renames the directory to its
content-addressed final location. Separating archive metadata from `content/`
allows a theme-owned path to use any otherwise-valid name without colliding
with the store. A registry failure removes a newly-created package directory;
it never removes a pre-existing package.
`theme_asset` stores the logical key, canonical path, SHA-256 and byte count.

Lifecycle states are:

```text
Discovered -> Validated -> Installed -> Enabled <-> Disabled
                                |             |
                                +-> Failed    +-> RolledBack
                                |
                                +-> Uninstalled
```

Validation and CSS safety scanning complete before a registry transaction
starts. A malformed, incompatible or unsafe package therefore cannot alter an
existing activation. Activation reopens the exact content-addressed archive,
revalidates its hash and reruns the scanner before changing registry state.
Activations are atomic per `site-wide`, `public`, `admin`, `console` or
`user-preview:{positiveUserId}` scope. An active theme cannot be uninstalled
unless an already-installed replacement is selected in the same transaction.

No package installation publishes a package, contacts a marketplace, executes
theme code or grants database, network or filesystem access.
