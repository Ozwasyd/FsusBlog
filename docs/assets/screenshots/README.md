# Public Preview Screenshots

These screenshots are sanitized public-preview visual assets captured from the live frontend route audit flow. They are intended to help external readers understand the current product surface without exposing production data.

## Gallery

| Surface | File |
| --------- | ------ |
| Public home page | [public-home-light.png](public-home-light.png) |
| Article detail page | [article-detail-light.png](article-detail-light.png) |
| Mobile article page | [article-detail-mobile.png](article-detail-mobile.png) |
| Dark mode public page | [public-dark.png](public-dark.png) |
| Admin dashboard | [admin-dashboard.png](admin-dashboard.png) |
| Article editor | [article-editor.png](article-editor.png) |
| Comment moderation console | [comment-moderation.png](comment-moderation.png) |
| Security / anti-crawler console | [security-console.png](security-console.png) |
| AOT / cache / operations status | [operations-status.png](operations-status.png) |

## Safety Rules

The screenshots come from the Playwright route audit fixtures and manual full-route screenshot capture, using local/demo content only:

- no real production domains
- no real ICP or public security registration numbers
- no real personal emails
- no real IP addresses
- no real usernames from production
- no real logs or audit records
- no tokens or object storage URLs
- no private roadmap or internal-only notes

## Cover Evidence Rules

Public home and article screenshots use the reviewed fixtures registered in
[`cover-art-manifest.json`](../../../src/frontend/public/fixtures/cover-art-manifest.json).
The assets depict route-audit UI, focus traversal, performance measurements,
route structure, or binary-frame output; they do not embed an article title,
category, site name, or CTA. Each concept has a distinct composition rather
than a palette-swapped abstract template.

Capture review must inspect both the 4:3 home crop and 16:9 article crop. The
key evidence stays inside the shared `center-80` safe area, and the renderer
adds only a neutral 1px boundary—no gradient, glow, colored backing surface,
filter, or decorative shadow. Dark captures must be reviewed for large bright
regions instead of applying an automatic darkening filter. A missing or blank
cover URL renders the complete text hierarchy without an empty media box.

The Do/Don't examples and full review checklist live in
[`public-layout-rules.md`](../../public-layout-rules.md#12-内容驱动的封面规范).

## Brand And Asset Rights

The screenshots do not include a separate logo file, trademark artwork, generated bitmap illustration, or production brand asset. The visible `FsusBlog` wordmark is rendered as plain text for documentation context. Code is covered by the repository license; screenshots and brand usage should be treated as documentation examples unless a later brand policy says otherwise.

## Provenance, Freshness And Quality

[`manifest.json`](manifest.json) remains the machine-readable authority for the
nine managed PNG files. It records source commit and canonical ReleaseId, build
identities, fixture/capture digests, local FsusUI identity, the visual-input
digest and every PNG SHA-256. `sourceCommit` answers where an image was
captured; `visualInputDigest` independently decides whether it is fresh for the
current checkout.

Visual quality is deliberately stored in a separate governed artifact:
`docs/assets/visual-evidence/public-preview-quality.json`. That manifest binds
the same source commit to the quality-policy digest, one report for every
managed screenshot and the complete viewport/locale/zoom matrix. Keeping this
separate preserves the existing screenshot provenance schema while preventing
a stable but defective PNG from being accepted as a valid baseline. A quality
manifest may only be produced by the same formal capture runtime; it must not be
written by hand or inferred from PNG hashes.

The reviewed input registry hashes full route, view, component, style, fixture,
localization, capture-support, lockfile, Vite and local FsusUI inputs. For
`package.json`, only dependency-bearing keys participate, so changing an
unrelated npm script does not invalidate pixels while a resolved dependency
change does. Quality policy, scenario registries and the shared audit source are
part of the visual-input set.

The offline provenance checks do not start an application, browser, database,
network service or GitHub API:

```bash
npm --prefix src/frontend run check:public-preview-screenshot-manifest
npm --prefix src/frontend run check:public-preview-screenshot-sync
```

The lightweight browser-backed quality path uses the same isolated runtime and
audit implementation but skips PNG publication and runs only scenarios marked
`quick`:

```bash
bash tools/docs/run-public-preview-capture.sh quality-smoke
```

It checks overflow, clipping, overlap, target geometry, focus clipping, locale
coherence, header lifecycle stability, first-viewport task visibility and the
deterministic reviewer rules. It does not replace the complete release matrix.

## Regeneration And Verification

The formal writer owns a unique runtime namespace, allocates isolated ports,
builds the current checkout, seeds fictional fixtures, keeps runtime and layout
audits enabled, captures the complete registry into staging, validates it, and
atomically replaces the gallery only after every check passes. Success and
failure both clean processes, containers, ports, and fixture data:

```bash
npm --prefix src/frontend run capture:public-preview-docs
npm --prefix src/frontend run verify:public-preview-docs
```

The writer requires a clean checkout and derives its source fingerprint from
the same Git worktree snapshot authority as the test matrix. Before any docs
asset is written, it verifies both the backend and debug-frontend PID/identity
sidecars against the live process group and requires their inherited source
commit and fingerprint to match that checkout. A mismatch reports expected and
actual identities and fails while output is still isolated in staging.
The single-writer lock records the owning namespace and PID; a concurrent
writer fails with that owner identity, and a different process cannot release
the lock. The staging path must match the lock-owning namespace exactly. The PNG publisher accepts only the complete registry, `manifest.json`, and this
README, then performs one same-filesystem directory transaction. The quality
publisher accepts only a complete `pass` quality manifest. All quality checks
and both staged manifests are validated before the first publication step; the
PNG transaction retains its existing byte-for-byte rollback behavior. Both
publication steps remain under the same single-writer lock. The command also
fails before taking that lock when the checked-out frontend
toolchain is incomplete; install the lockfile-resolved dependencies locally
before retrying. The explicit capture command receives a cold-build budget,
while ordinary dedicated browser-contract runs retain their shorter default.

`verify:public-preview-docs` is read-only: it recaptures into a temporary
directory against the immutable Release-built frontend runtime, compares every
screenshot ID, writes deterministic release evidence
under `.tmp/release-evidence/`, and requests the explicit capture command when
an update is required. Local `release-final` runs this same matrix tier. CI,
when available, is only another caller and is not the authority.

The manual audit derives broader human-review coverage from the frontend router
table and writes only below `FSUSBLOG_MANUAL_SCREENSHOT_DIR` or
`.tmp/manual-layout-screenshots/current`. A filtered viewport/theme/scope shard
cannot write or prune documentation assets. The retired
`FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS=1` setting fails explicitly.

For targeted local review or CI matrix jobs, the command below enters the same
matrix-owned bootstrap and sealed fixture profile as the formal documentation
capture. It does not start a second fixture orchestrator. Keep each Playwright
shard at `--workers=1` and split the route matrix with deterministic filters:

```bash
FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS=desktop \
FSUSBLOG_MANUAL_SCREENSHOT_THEMES=light \
FSUSBLOG_MANUAL_SCREENSHOT_SCOPES=anonymous,admin \
FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME=desktop-light-main \
npm --prefix src/frontend run capture:manual-layout-screenshots
```

Supported `FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS` values are `desktop`,
`mobile`, and `narrow-mobile`; supported `FSUSBLOG_MANUAL_SCREENSHOT_THEMES`
values are `light` and `dark`; supported `FSUSBLOG_MANUAL_SCREENSHOT_SCOPES`
values are `anonymous`, `user`, `admin`, and `edge`. When
`FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME` is set and
`FSUSBLOG_MANUAL_SCREENSHOT_DIR` is not set, output defaults to a shard-local
folder under `.tmp/manual-layout-screenshots/current/<shard>`. Shard names must
match `^[a-z0-9][a-z0-9_-]*$`; invalid names fail instead of being silently
rewritten to another output directory.

All shards keep PNGs in shard-local temporary folders. Only the unfiltered,
single-writer `capture:public-preview-docs` command can publish the complete
documentation gallery.
