# Document export HTML boundary

The HTML owner consumes the canonical renderer's closed XHTML fragment and frozen
assets. It does not introduce a Markdown parser, a renderer fallback, a new provider
registration, or a path around sandbox admission and result receipt verification.

Empty non-void HTML elements are serialized with explicit closing tags. This
preserves their empty-node meaning when the packaged document is parsed as HTML5;
XML-valid `<em />` or `<a ... />` alone would not preserve that meaning. The independent
artifact verifier rejects these non-void abbreviations. HTML void elements retain
their existing serialization, and the original closed SVG namespace policy remains.

Root direction is derived from the actual locale's `CultureInfo.TextInfo` in the
composer and independently in the verifier. Persian and Urdu locales therefore
produce `rtl` alongside Arabic and Hebrew. Direction mutations are refused; the
verifier does not take the composed document's direction as its authority.

HTML ids and local references preserve exact Unicode letters, numbers and combining
marks plus the existing `-`, `_`, `:` and `.` characters, within the original
160 UTF-16-unit ceiling. No normalization, id renaming or deduplication occurs.
Whitespace, controls, formatting characters and markup punctuation remain refused.
Ids remain unique and all local references must resolve. SVG ids, marker/paint
references and their document ownership keep the original ASCII grammar.

The full canonical renderer is not qualified by these corrections. The current
closed fragment boundary still rejects these shapes instead of silently changing
or dropping their content:

| Renderer shape | Current result |
| --- | --- |
| Table alignment encoded as inline `style` | Refused by the active-attribute guard |
| KaTeX MathML namespace/elements | Refused by the closed element/namespace allowlist |
| Repeated footnote references with the same emitted `id` | Refused by the unique-id guard |

Canonical owner output, projection identity and full feature compatibility must be
proved before claiming support for these shapes. The export owner does not rewrite
the original footnote ids or permit arbitrary inline styles or foreign markup.

Ordinary controls call the production sanitizer, composer and independent verifier,
using the existing AngleSharp HTML5 parser as a DOM-semantics oracle. They establish
neither browser visual/offline acceptance nor native renderer, font, CPU, cancellation
or physical cleanup qualification. `ComposeDocument` is an internal composition
seam; the public export entry retains its original sandbox and receipt requirements.
