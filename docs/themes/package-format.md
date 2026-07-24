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
        "maxSelectors": 512
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

All permission values must remain `false`. CSS and asset bytes are measured
from the expanded entries and must fit the manifest budgets. The platform also
caps CSS at 1 MiB, assets at 4 MiB and declared selectors at 4096. CSS safety
analysis and selector counting belong to the later theme validation layer; the
package layer only establishes the budget contract.

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

Validation completes before a registry transaction starts. A malformed or
incompatible package therefore cannot alter an existing activation.
Activations are atomic per `site-wide`, `public`, `admin`, `console` or
`user-preview:{positiveUserId}` scope. An active theme cannot be uninstalled
unless an already-installed replacement is selected in the same transaction.

No package installation publishes a package, contacts a marketplace, executes
theme code or grants database, network or filesystem access.
