# PDF provider implementation boundary

This directory owns PDF only for [#2429](https://github.com/Ozwasyd/FsusBlog/issues/2429).
The shared frozen input, canonical renderer, sandbox, provider registry and receipts
remain their existing authorities. The job API remains the #2434 authority at
`6c1c5ac56173d9fe90262733cc87687677e4589e`; PDF does not store outputs, authorize
downloads, define task states, or register itself.

## Implemented behavior

`PdfPrintDocumentLayout` validates the frozen input and canonical renderer response,
sanitizes through the existing HTML sanitizer, embeds the existing registered
reading fonts, and builds an offline A4 print document. The closed profile is
`a4-reading-v1`, with 20 mm vertical and 18 mm horizontal margins, page counters,
heading keep-with-next, three-line widows/orphans, repeating table headings,
wrapped code, bounded figures, and explicit page-break classes. Paper uses the
existing light reading palette for both registered input themes. User CSS, print
arguments, scripts and remote resource reads are not accepted.
The document direction uses the admitted locale's .NET culture data, including
Persian `fa-IR` and Urdu `ur-PK`, instead of an Arabic/Hebrew prefix list.
Program code uses LTR direction and left alignment within either document direction
so leading indentation and tab columns are preserved in RTL articles as well.

`PdfDocumentExportProvider.ExportAsync` returns `PdfDocumentExportResult`, containing
the shared provider result plus actual canonical-renderer evidence and observed
page/font counts. `ValidateResultAsync` binds the input, task, build, both actual
sandbox receipts, original output bytes and receipt fields, then independently
parses the exact PDF through the same registered broker. Verification is a
separate operation; it does not retry PDF rendering after a failure.

`Tools/pdf_renderer.py render` accepts the internal camelCase `PdfPrintRenderRequest`
and returns `PdfPrintRenderResponse`. A null `pdfBase64` renders and verifies;
a non-null value verifies those exact PDF bytes. This is a private format-tool
adapter, not a second job or receipt protocol. Stdout contains only a bounded
result; errors contain stable codes without article text, URLs or private paths.
Both operations lay out the same closed HTML with the frozen fonts. This produces
expected page geometry, every link rectangle and internal destination, each
raster-image placement and decoded pixel/alpha signature, and preserved code-line
whitespace. The independent PDF parsers must match those expectations, including
repeated targets and images. Wrapped links retain all their annotation rectangles.
Verify mode never calls the PDF writer or replaces the supplied PDF. Code checks
preserve logical ligature order; tabs are checked through their rendered space
and line geometry rather than discarded with other whitespace.
RTL text, including Latin/digit and inline-font mixtures, is checked against the
existing frozen-font Pango layout's glyph-cluster positions and UTF-8 logical
indices. Actual PDF ToUnicode clusters must have the declared letters at those
positions. Logical output is rebuilt from those verified actual clusters, including
lam-alef, rather than reversing a mixed line or supplying expected source letters.
A changed letter or digit order remains a hard failure. This uses the existing
print-engine/native dependencies and adds no new parser or package authority.
Raster images also undergo a PDFium visibility check. Frozen source image pixels
are painted at canonical layout positions on a separate in-memory native page.
No candidate image object, clipping, transform or blend state enters this expected
painting. Its image-region pixels must agree with the actual original full page,
rejecting full/partial overlays and clipping or rotation that changes appearance.
The native scratch page is never serialized and never changes the returned bytes.
Source-paint comparison uses matching native nearest sampling at two pixels per
point; the actual image's interpolation declaration is checked against the
canonical style separately. This avoids different PDF-image/bitmap interpolation
heuristics without adding a pixel tolerance. The existing normal-render occlusion
and visible-ink checks remain, and the full-page normalization still uses normal
PDFium rendering.
Image placements that cannot be proven this way, including nested image forms or
regions with no complete verification pixel, fail with `unverifiable-image-paint`.

The renderer uses WeasyPrint 66.0, pikepdf 9.11.0, PyMuPDF 1.26.4, pypdfium2
4.30.0 and fontTools 4.59.2. `Tools/dependencies.lock.json` pins the complete Python dependency set used in the
real output checks. Packaging must also freeze the interpreter and native
Pango/HarfBuzz/fontconfig/qpdf/MuPDF/PDFium dependencies under the shared tool runtime
digest; package version checks alone do not prove native identity. Review upstream
package licenses, including PyMuPDF's AGPL/commercial licensing, when packaging.
The tool verifies that complete version set as well as its fixed engine identities.
During packaging, translate the manifest's exact name/version pairs into pip
requirements and install them with the official package manager. Include the
unchanged manifest at `/tool/dependencies.lock.json` in the frozen runtime.
Dependencies are installed during development/build, never by a provider run.

Fontconfig is configured before importing the print engine and can enumerate only
the supplied frozen fonts in a run-owned temporary directory. Font digests,
embedding restrictions and glyph coverage are checked. The URL fetcher accepts
only bounded inline registered font/raster-image data; network and host-file
fetches are denied. Print-engine resource/layout warnings fail closed. Actual
PDF structure, EOF, page geometry/count, embedded fonts, glyph-zero/tofu, ordered
extracted body text, link annotations and prohibited actions/resources are checked
with independent parsers. Layout overflow fails rather than clipping silently.

## Normalization

The proposed policy is `normalized-pdf-visible-v1`. The digest binds the frozen
input digest and every page's rendered pixels, extracted ordered body text, and
link targets/rectangles. Object numbers, timestamps, document/instance IDs and font
subset names are excluded by this semantic projection. PDFium supplies the visible
page projection; qpdf structure and MuPDF text/links are separate checks. Visible content is never
rewritten. Page images here are independent verification evidence; the PDF itself
contains real font/text and link objects. A screenshot-only PDF is rejected.

Budgets are closed: 32 MiB tool message input, 16 MiB PDF output, 8 MiB per inline
resource, 16,777,216 decoded pixels per raster image, 32 fonts and 512 pages. The shared sandbox must additionally enforce its
existing CPU, wall, RSS, disk, process and cancellation budgets. The effective
limit is the stricter shared/tool bound; no sandbox budget is widened here.

## Integration handoff to #3653

The shared catalog intentionally remains inactive. Source availability does not
activate PDF. Exact integration requirements:

1. Consume shared canonical-phase API commit
   `a0538e235888076afd0463606d3650138fc6b18d` and its registry prerequisite
   `f0d4d7990139ed9db432a28c8ec11575f5f908d3`. The canonical adapter calls
   `ExecuteCanonicalRendererAsync` with the original frozen PDF task. PDF now
   validates that phase through `ValidateCanonicalRendererReceipt`, then uses
   ordinary provider receipt validation for the final PDF phase. Both preserve
   the original task digest and the sandbox's trusted host build digest. Do not
   forge an HTML task or use a canonical receipt to qualify final PDF bytes.
   These exact shared commits must be integrated before compiling this adapter;
   their source availability does not imply native/runtime qualification.
2. Register the sole PDF provider owner
   `FsusBlog.Server.Services.DocumentExport.PdfDocumentExportProvider`, tool ID
   `document-export-pdf-toolchain`, version
   `weasyprint-66.0-pikepdf-9.11.0-mupdf-1.26.4-pdfium-4.30.0-v4`, arguments exactly `["render"]`,
   and proposed normalization `normalized-pdf-visible-v1`. The normalization
   catalog must explicitly list object IDs/timestamps/document IDs/font subset
   labels as excluded metadata. The registry constructs the internal provider
   with the existing canonical adapter and sandbox.
3. Package the executable script with its fixed `/tool/bin/python3` interpreter
   and all native dependencies inside the existing read-only `/tool` runtime
   mount. Freeze executable/runtime digests through the existing broker. The
   local developer virtualenv is not a production tool contract and is not
   auto-discovered by the provider. A compatible frozen runtime is still required.
4. Keep catalog feature claims truthful. Features whose text extraction or
   pagination cannot meet the verifier contract fail explicitly. Repeated table
   headers and ordinary list markers are validated as generated furniture; marker
   values/counts are preserved. Nondecimal/reversed ordered lists fail explicitly.
   A canonical `tfoot` followed by `tbody` or more body rows is outside the PDF
   ordering contract: it fails before rendering with
   `unsupported-table-footer-order`. Put the footer after all body rows; that
   order is supported and verified. This format restriction does not change the
   shared sanitizer's accepted input vocabulary.
   Unusually complex SVG/math/footnote ordering still needs complete canonical
   renderer fixtures; no silent fallback is implemented.
5. The shared job adapter consumes #2434's `IDocumentExportJobProvider` through
   #3653's exact `IDocumentExportAttemptJobProvider` port from
   `a94243f85cf9747741c02278d5c5123cccc0a584`; no extra
   task/store/permission implementation belongs here. Canonical evidence and
   verification must remain available without creating a provider-owned store.
   `PdfDocumentExportJobProvider` implements that exact interface. The job owner
   creates one resource owner after claim and passes that same object to Export
   and Verify. Export forwards it through the canonical renderer and PDF provider
   stages; Verify forwards it to the sole sandbox's `ExecuteVerificationAsync`
   and calls `RequireCompleted(task, input)` after actual verification succeeds.
   Canonical evidence from Export is retained only as a weak, in-memory reference
   keyed by the original resource owner and consumed once by Verify. This
   carries the actual canonical bytes, plan and receipt across the current call
   pair, without rerunning the canonical renderer or adding persistent custody.
   The job owner can privately copy output bytes before Verify; the copy must
   match the original output bytes, sandbox output and phase identity digests,
   and the actual copied bytes and all receipts are then revalidated. An unknown
   attempt, changed output, another resource owner or repeated Verify fails closed;
   the job owner must admit a new attempt rather than reset a resource budget.
   Legacy calls retain the resource owner for the original result object; copied
   results use the explicit attempt port. The composition
   root supplies the trusted host build digest; callers cannot choose it per job.

## Focused checks

From the repository root, using a development environment with the locked PDF
dependencies and the repository's Ruff 0.16.10:

```sh
python -m pytest -q src/backend/Services/DocumentExport/Pdf/Tests/test_pdf_renderer.py
ruff check src/backend/Services/DocumentExport/Pdf/Tools/pdf_renderer.py src/backend/Services/DocumentExport/Pdf/Tests/test_pdf_renderer.py
ruff format --check src/backend/Services/DocumentExport/Pdf/Tools/pdf_renderer.py src/backend/Services/DocumentExport/Pdf/Tests/test_pdf_renderer.py
```

Python tests use explicitly named local font fixtures at the canonical-HTML tool
boundary. They generate and inspect real PDFs; they do not claim a real canonical
Markdown renderer or sandbox receipt. The C# `DocumentExportPdfProviderTests`
exercise actual frozen-input validation, print composition and closed response
rejections, including inactive-provider and frozen-input-drift refusals at the
canonical-phase boundary. Source-include compilation consumes the exact shared
canonical-phase and job APIs listed above; it is narrower than the original
backend project or full local equivalent CI.

Until PDF registration, frozen native runtime packaging and original
sandbox qualification are complete, end-to-end provider/job execution remains
unrun and #2429 remains OPEN.
