# Public-preview screenshot governance

The nine images in `docs/assets/screenshots/` are release-derived documentation
assets. Two artifacts jointly govern them:

- `docs/assets/screenshots/manifest.json` owns PNG provenance, freshness and
  content hashes;
- `docs/assets/visual-evidence/public-preview-quality.json` owns geometry, locale
  and deterministic design-review decisions.

`config/docs/public-preview-screenshots.json` is the fixed registry for route,
viewport, theme, scope, visual-input ownership and references to the quality
policy/scenario registries. Neither manifest may be synthesized from the other.

## Local authority

The fast provenance path is browserless and networkless:

```bash
npm --prefix src/frontend run check:public-preview-screenshot-manifest
npm --prefix src/frontend run check:public-preview-screenshot-sync
```

The first command validates the existing screenshot manifest and complete PNG
set. The second recalculates classified Git-tree inputs and the resolved local
FsusUI identity. Quality policy and shared audit source belong to those inputs,
so changing the detector or thresholds makes the checked-in gallery stale.

The quick browser-backed quality path reuses the formal isolated runtime but
skips PNG and manifest publication:

```bash
bash tools/docs/run-public-preview-capture.sh quality-smoke
```

It executes only scenarios marked `quick`; formal capture and release
verification execute the complete matrix.

## Quality contract

`tools/docs/public-preview-quality.mjs` is the single facade used by the docs
writer and Browser Contract. Every managed screenshot receives a machine report
and a deterministic reviewer classification. Machine checks cover:

- horizontal page overflow;
- unexpected overlap between visible interactive controls;
- clipped readable UI/task text, including `overflow: clip`;
- mobile 40×40px controls and 44px PublicShell/category/tag/primary actions;
- focus-ring clipping against the viewport and overflow ancestors;
- fixture-locale coherence, excluding explicitly marked user content;
- PublicShell geometry movement across lifecycle samples, with all samples
  measured at the scenario's declared zoom;
- first-viewport task/result/complete-empty-state visibility on task surfaces.

The reviewer layer records panel/card density, nested panels, badge and primary
action counts, gradients, backdrop filters and unscoped large radii. Its result
is exactly `pass`, `fail` or `needs-design-review`. This is not an AI aesthetic
score: every decision is derived from a named rule, threshold, selector and
geometry record. Both `fail` and `needs-design-review` block publication.

The release matrix covers public home at 375×812 and 1440×900 in light/dark,
article detail at 375×812, 768×1024 and 1440×900 in zh-CN/en-US, the five managed
task surfaces at 1366×768, 1440×900 and 375×812, plus 150% layout-zoom smoke.
These scenarios reuse the same runtime allocation and do not create a second
capture service or visual-input digest.

`tests/frontend/e2e/acceptance/public-preview-quality-gate.spec.ts` contains real
negative DOM fixtures. It proves mixed UI locale, horizontal overflow, clipped
text, overlapping controls, undersized mobile actions and a missing first-view
task produce `fail`, while nested panels produce `needs-design-review`. Marked
user content is excluded from UI-locale scanning. Tool tests separately validate
report/matrix schema, publication, tamper detection and release-evidence binding.

## Capture and release verification

```bash
npm --prefix src/frontend run capture:public-preview-docs
npm --prefix src/frontend run verify:public-preview-docs
```

Both commands allocate an isolated acceptance namespace and ports, build the
current checkout, create local fixtures, target the immutable Release-built
frontend runtime, fix locale/timezone, wait for fonts, reduce motion and retain
runtime/layout/quality audits. The capture sequence is:

1. capture all nine PNGs into staging;
2. write nine temporary quality sidecars and the complete matrix;
3. validate and create the separate quality manifest, removing temporary
   sidecars from PNG staging;
4. create and validate the existing screenshot provenance manifest;
5. under one writer lock, publish the PNG gallery and quality manifest only
   after both validations pass.

The verify command repeats the same work in temporary storage, compares PNG
provenance and quality manifests independently, and augments
`.tmp/release-evidence/public-preview-screenshots.json` with `qualityAudit`,
`qualityPolicyDigest` and the validated quality document. Browser Contract uses
the same implementation and the same committed quality manifest. GitHub Actions
may invoke these commands but is not an authority.

No quality JSON is checked in until a real formal capture produces it. Updating
PNG bytes, copying an old report or manually writing a `pass` document cannot
satisfy publication.

## Failure and rollback

A manual viewport/theme/scope shard can only write temporary review artifacts.
The single-writer lock prevents concurrent publication. Any runtime, capture, provenance or quality validation failure occurs before
the first publication step and leaves both committed authorities unchanged.
The PNG directory and quality file then use their own atomic replacement rules
under the same writer lock; an operating-system replacement failure is reported
for explicit recovery rather than being rewritten as a successful baseline.
Runtime cleanup owns only its generated namespace.

On failure, inspect the named screenshot/scenario and linked issues, fix the UI
or fixture, then run the explicit capture command. Do not update PNG files, hide
text, apply global `overflow-x:hidden`, shrink fonts or weaken thresholds merely
to manufacture a baseline. Reverting the gallery/quality commit restores the
previous validated pair without restarting the server.
