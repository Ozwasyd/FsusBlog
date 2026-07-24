# `.fsfont` package and registry

`.fsfont` is the local, offline package format for FsusBlog fonts. It is a ZIP
container with a fixed `manifest.json` contract. Installation never fetches a
remote font and does not publish a NuGet, npm, or marketplace package.

## Minimum package

```text
my-font.fsfont
├── manifest.json
├── fonts/
│   └── body-regular.woff2
└── license/
    ├── LICENSE.txt
    └── source.json
```

`css/`, `preview/`, and `docs/` are optional metadata directories. Every entry
under `fonts/` must be a WOFF2 file declared by `faces[].file`. Absolute paths,
backslashes, empty segments, `.` / `..`, duplicate entries, undeclared font
files, and non-WOFF2 font assets fail closed before anything is written.

`license/source.json` must be a JSON object. It records provenance for later
license policy work; its presence does not authorize a network request.

## Manifest contract

The machine-readable schema is
[`font-manifest.schema.json`](font-manifest.schema.json). The initial
categories are:

```text
ui-sans
prose-sans
code-mono
cjk-sans
emoji
```

`fsusblog` is a whitespace-separated comparator range such as
`>=1.3.0 <1.4.0`. The installer compares it with the running FsusBlog version
before reading font payloads. Each face identity is unique by
`weight + style`; weight is `1..1000`, style is `normal`, `italic`, or
`oblique`, and `loading.display` uses a browser `font-display` value.

The package declares `criticalBytes`, `totalBytes`, and `maxFaces`. The reader
enforces these values against the uncompressed WOFF2 payloads and rejects
invalid WOFF2 signatures. Archive entry count and metadata size also have
implementation-owned ceilings so a manifest cannot turn its own budget into
an unbounded allocation. v1.3 accepts at most 32 faces, 16 MiB of critical
WOFF2 data, and 64 MiB of total WOFF2 data; cumulative remaining budget is
checked before each face is allocated.

## Registry lifecycle

`IFontRegistry` exposes install, preview, enable, disable, activate, and delete
operations. Installation writes each WOFF2 payload once as
`assets/<sha256>.woff2`, then atomically replaces `registry.json`. Registry
entries preserve:

- manifest JSON, font ID, family, category, and package version;
- license text and `source.json`;
- install/enabled/built-in state and timestamps;
- face weight, style, Unicode range, SHA-256, byte size, critical flag, and
  `font-display`.

Activation is scoped and stores the selected UI, prose, code, CJK, and emoji
font IDs with a monotonically increasing `configVersion`. Only installed and
enabled entries can be activated. Disabling an active font fails closed.
Deleting an active font requires a complete enabled replacement selection;
built-in entries provide the local fallback and cannot be deleted. Unreferenced
content-addressed assets are removed only after the registry replacement has
been committed.

The built-in registry entries represent the existing hardcoded UI, prose,
code, CJK, and emoji stacks. They do not claim ownership of local WOFF2 files.
Activation is compiled into stable, locale-aware theme variables by the
[font token schema and stack runtime](font-token-schema.md); themes reference
those tokens instead of font IDs, asset paths, or raw `font-family` strings.

## Failure and rollback

A failed package validation leaves the registry and asset store unchanged. A
failed registry write retains the previous `registry.json`. To roll back
without restarting, activate the built-in selection in the affected scope;
this increments `configVersion` and leaves the installed package available for
inspection or later reactivation. Delete remains a separate explicit action.

This base infrastructure does not add an HTTP endpoint, public font
marketplace, remote fetch, license approval engine, or loading planner.
