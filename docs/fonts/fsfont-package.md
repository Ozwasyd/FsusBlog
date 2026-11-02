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
files, font assets outside `fonts/`, non-WOFF2 font assets, and executable
entries (`.exe`, `.dll`, `.so`, scripts, and command files) fail closed before
anything is written.

`license/source.json` must exactly match the manifest `source` object:

```json
{
  "kind": "npm-fontsource",
  "package": "@fontsource/noto-sans-sc",
  "version": "5.2.9",
  "upstream": "Google Fonts"
}
```

`kind` is the package-origin identity and is restricted to the reviewed
`npm-fontsource` and `local-vendored` classes. `package` and `upstream` are
identifiers, not URLs. The validator never downloads a source document,
license, CSS file, or font as a fallback.

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
`oblique`, and `loading.display` uses a browser `font-display` value. Every
face declares a lowercase SHA-256 `contentHash`; the reader compares it with
the exact uncompressed WOFF2 bytes before installation. The accepted declared
license identifiers are `OFL-1.1`, `Apache-2.0`, and `MIT`; an unknown value,
empty license file, missing/mismatched source document, or remote origin is a
hard failure rather than a warning.

The package declares `criticalBytes`, `totalBytes`, and `maxFaces`. The reader
enforces these values against the uncompressed WOFF2 payloads and rejects
invalid WOFF2 signatures. Archive entry count and metadata size also have
implementation-owned ceilings so a manifest cannot turn its own budget into
an unbounded allocation. v1.3 accepts at most 32 faces, 16 MiB of critical
WOFF2 data, and 64 MiB of total WOFF2 data; cumulative remaining budget is
checked before each face is allocated.

## Registry lifecycle

`IFontRegistry` exposes install, preview, enable, disable, activate, and delete
operations. Installation writes each verified WOFF2 payload once as
`assets/<sha256>.woff2`, then atomically replaces `registry.json`. Registry
entries preserve:

- manifest JSON, font ID, family, category, and package version;
- license text and `source.json`;
- install/enabled/built-in state and timestamps;
- face weight, style, Unicode range, SHA-256, byte size, critical flag, and
  `font-display`.

Activation is scoped and stores the selected UI, prose, code, CJK, and emoji
font IDs with a monotonically increasing `configVersion`. Only installed and
enabled entries can be activated. Enable and activation reopen each selected
local asset and verify byte size plus SHA-256, so post-install tampering cannot
become active. Persisted non-built-in manifest/license/source metadata is also
revalidated whenever the registry is loaded. Disabling an active font fails closed.
Deleting an active font requires a complete enabled replacement selection;
built-in entries provide the local fallback and cannot be deleted. Unreferenced
content-addressed assets are removed only after the registry replacement has
been committed.

The built-in registry entries represent the existing hardcoded UI, prose,
code, CJK, and emoji stacks. They do not claim ownership of local WOFF2 files.
Activation is compiled into stable, locale-aware theme variables by the
[font token schema and stack runtime](font-token-schema.md); themes reference
those tokens instead of font IDs, asset paths, or raw `font-family` strings.

## Frozen installed byte reads

The same `LocalFontRegistry` instance also implements `IFontByteSource` through
its `LocalFontRegistry.FontBytes.cs` partial. Consumers retain the registered
`IFontRegistry` singleton and use its byte-source interface; they must not create
a second registry instance for export. The byte source reads explicitly frozen
font ID, package version, family, weight, style and content hash identities. It
does not choose fonts, require activation, or derive a selection from a default
stack. A disabled but installed package remains readable; deleted or replaced
identities fail closed.

The entire batch holds the original registry `_gate`, including registry load,
identity checks, file reads and final mutation checks. Paths are derived only
from validated installed SHA-256 names under `assets/`; no caller file path is
accepted. Reads use the existing `NativeRegularFileGuard` descriptor and directory
identity owner on Linux x64/Arm64, reject links and non-regular files, check length
before allocation, read exactly that length plus an EOF probe, verify SHA-256 and
recheck native identity and registry state before returning immutable owned bytes.
Other platforms fail closed. The caller's batch limit may reduce, but cannot
increase, the existing 64 MiB / 32-face ceilings.

`DocumentExportFontMapper` accepts a caller's frozen selection and requires exactly
the seven tuples in the read-only `DocumentExportReadingStyleAuthority.RequiredFonts`.
It delegates the entire batch to the registry and maps the verified identities and
bytes to the existing export asset contract. It supplies no alias, download, system
font, built-in fallback, or alternative selection authority. Missing real installed
faces remain an export prerequisite failure.

The package reader's existing WOFF2 magic check, byte hash checks and mapper tuple
closure are not font decoding or rendering qualification. The short magic payloads
in `FontByteProducerTests` exercise real package installation, byte I/O, lifecycle
races and tuple mapping only. Real fonts, glyph coverage and offline HTML rendering
must be independently verified with authorized real packages; the repository's
empty built-in faces cannot supply that evidence.

## Failure and rollback

A failed package validation leaves the registry and asset store unchanged. A
failed registry write retains the previous `registry.json`. To roll back
without restarting, activate the built-in selection in the affected scope;
this increments `configVersion` and leaves the installed package available for
inspection or later reactivation. Delete remains a separate explicit action.

`FontLicenseEvidenceWriter` writes the bounded
`.tmp/release-evidence/font-license-summary.json` contract with schema
`fsusblog.font.license.v1`. It reports each installed `.fsfont` package's
license, `package@version`, and `hashVerified`; violations make status
`blocked`. Built-in fallback stacks are not `.fsfont` packages and therefore
are not falsely represented as owned face assets. The evidence consumer
rejects symlinks, unknown licenses, remote sources, duplicate IDs, failed
hashes, non-empty violations, and missing/non-`ok` evidence. The release
collector and `release-final` both fail closed on that result.

This infrastructure does not add an HTTP endpoint, public font
marketplace, remote fetch, or license approval engine. Enabled faces and
activation state are consumed by the
[Font loading planner](font-loading-planner.md).
