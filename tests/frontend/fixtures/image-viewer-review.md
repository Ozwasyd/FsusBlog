# ImageViewer reviewer regression fixtures

These fixtures reproduce reviewer `01a11b43-dfce-7607-812a-b610384e502d`'s
navigation-only caption and sibling Dialog observations, and enabled-toolbar
CSP original-size geometry. They import real public ImageViewer/Dialog and use
Blog's actual Vite configuration and local FsusUI alias. They add no corrective
CSS, focus traps or locks.

From the repository root, with frontend dependencies and a freshly rebuilt
theme in the chosen FsusUI checkout:

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/absolute/path/to/FsusUI \
  node tests/frontend/checks/runtime/probe-image-viewer-review.mjs navigation /tmp/viewer-navigation
FSUSBLOG_LOCAL_FSUSUI_ROOT=/absolute/path/to/FsusUI \
  node tests/frontend/checks/runtime/probe-image-viewer-review.mjs mode /tmp/viewer-mode
```

The original saved runners collected observations and exited 0. This probe
adds actual assertions: caption wheel input must increase scrollTop, the upper
Dialog action must have no inert ancestor and accept focus, and original-size
mode must increase the large image's rendered width. A failed assertion returns
exit 1 and remains in `report.json`; the run also records source SHAs, dirty
state, fixture/runner/theme digests and a rendered screenshot.

The Dialog opens programmatically, matching the supplied reproduction; this
does not test pointer-focus return. The geometry fixture renders CSP-safe mode
only. FsusUI's separate ordinary interaction suite covers normal rendering and
pointer-return composition. These probes do not replace independent review,
full article-route acceptance, published-package or device evidence.
