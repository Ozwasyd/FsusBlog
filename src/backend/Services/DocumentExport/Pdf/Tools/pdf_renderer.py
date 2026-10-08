#!/tool/bin/python3
"""PDF-only tool; launch exclusively through the document-export sandbox broker.

This consumes the canonical renderer's closed print document, never Markdown.
The CLI writes one bounded JSON result to stdout; diagnostics contain no content.
"""

import base64
import hashlib
import importlib.metadata
import io
import json
import logging
import math
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter
from contextlib import closing, contextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

tool_version = "weasyprint-66.0-pikepdf-9.11.0-mupdf-1.26.4-pdfium-4.30.0-v4"
maximum_input = 32 * 1024 * 1024
maximum_output = 16 * 1024 * 1024
maximum_resource = 8 * 1024 * 1024
maximum_pages = 512
maximum_image_pixels = 16 * 1024 * 1024
request_fields = {
    "htmlDocument",
    "fontAssets",
    "expectedText",
    "expectedLinks",
    "inputDigest",
    "printProfile",
    "pdfBase64",
}


class PdfRejected(ValueError):
    """A stable rejection code, without article, URL, or filesystem disclosure."""


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def compact_text(value):
    return "".join(
        character
        for character in unicodedata.normalize("NFC", value)
        if not character.isspace()
    )


def decode_bytes(value, limit):
    if not isinstance(value, str) or len(value) > ((limit + 2) // 3) * 4:
        raise PdfRejected("resource-budget")
    try:
        result = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise PdfRejected("invalid-base64") from error
    if len(result) > limit:
        raise PdfRejected("resource-budget")
    return result


def safe_link(value):
    return isinstance(value, str) and urlsplit(value).scheme in {
        "http",
        "https",
        "mailto",
    }


class ClosureParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lists = []
        self.markers = Counter()
        self.table_furniture = {"thead": [], "tfoot": []}
        self.current_furniture = None
        self.furniture_text = []
        self.external_links = []
        self.table_order = []

    def handle_starttag(self, tag, attributes):
        attributes_map = dict(attributes)
        if tag == "table":
            self.table_order.append(False)
        if self.table_order:
            if tag == "tfoot":
                self.table_order[-1] = True
            elif self.table_order[-1] and (
                tag == "tbody" or tag == "tr" and self.current_furniture != "tfoot"
            ):
                raise PdfRejected("unsupported-table-footer-order")
        if tag == "a" and safe_link(attributes_map.get("href")):
            self.external_links.append(attributes_map["href"])
        if tag in {"ul", "ol"}:
            if "reversed" in attributes_map or attributes_map.get("type", "1") != "1":
                raise PdfRejected("unsupported-list-numbering")
            self.lists.append([tag, int(attributes_map.get("start", "1"))])
        if tag == "li" and self.lists:
            kind, number = self.lists[-1]
            self.markers["•" if kind == "ul" else f"{number}."] += 1
            self.lists[-1][1] += 1
        if tag in self.table_furniture:
            self.current_furniture = tag
            self.furniture_text = []
        if tag in {"script", "iframe", "object", "embed", "link", "base", "form"}:
            raise PdfRejected("active-or-remote-resource")
        for name, value in attributes:
            if name.startswith("on") or name == "style":
                raise PdfRejected("user-script-or-css")
            if name in {"src", "poster"} and not (value or "").startswith("data:"):
                raise PdfRejected("remote-resource")
            if name == "href" and not (
                (value or "").startswith("#") or safe_link(value)
            ):
                raise PdfRejected("unsafe-link")

    def handle_data(self, data):
        if self.current_furniture is not None:
            self.furniture_text.append(data)

    def handle_endtag(self, tag):
        if tag == "table" and self.table_order:
            self.table_order.pop()
        if tag in {"ul", "ol"} and self.lists:
            self.lists.pop()
        if tag == self.current_furniture:
            self.table_furniture[tag].append(compact_text("".join(self.furniture_text)))
            self.current_furniture = None


def validate_text_order(page_texts, request):
    parser = ClosureParser()
    parser.feed(request["htmlDocument"])
    markers = parser.markers.copy()
    cleaned_pages = []
    for text in page_texts:
        lines = []
        for line in text.splitlines():
            marker = line.strip()
            if markers[marker] > 0:
                markers[marker] -= 1
            else:
                lines.append(line)
        cleaned_pages.append(compact_text("".join(lines)))
    if any(markers.values()):
        raise PdfRejected("list-marker-semantics")
    expected = compact_text(request["expectedText"])
    cursor = 0
    for text in cleaned_pages:
        candidates = [text]
        for header in parser.table_furniture["thead"]:
            if header and text.startswith(header):
                candidates.append(text[len(header) :])
        for footer in parser.table_furniture["tfoot"]:
            for candidate in candidates[:]:
                if footer and candidate.endswith(footer):
                    candidates.append(candidate[: -len(footer)])
        matched = next(
            (
                candidate
                for candidate in candidates
                if expected.startswith(candidate, cursor)
            ),
            None,
        )
        if matched is None:
            raise PdfRejected("text-order-or-content")
        cursor += len(matched)
    if cursor != len(expected):
        raise PdfRejected("text-order-or-content")


def validate_request(request):
    if not isinstance(request, dict) or set(request) != request_fields:
        raise PdfRejected("request-schema")
    if request["printProfile"] != "a4-reading-v1":
        raise PdfRejected("print-profile")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", request["inputDigest"]):
        raise PdfRejected("input-digest")
    if not isinstance(request["htmlDocument"], str) or not request["htmlDocument"]:
        raise PdfRejected("empty-document")
    if not isinstance(request["expectedText"], str) or not compact_text(
        request["expectedText"]
    ):
        raise PdfRejected("empty-semantics")
    if not isinstance(request["expectedLinks"], list) or not all(
        safe_link(link) for link in request["expectedLinks"]
    ):
        raise PdfRejected("unsafe-link")
    if (
        not isinstance(request["fontAssets"], list)
        or not request["fontAssets"]
        or len(request["fontAssets"]) > 32
    ):
        raise PdfRejected("font-manifest")
    ClosureParser().feed(request["htmlDocument"])
    if re.search(r"@import\b", request["htmlDocument"], re.IGNORECASE):
        raise PdfRejected("remote-stylesheet")


def embedded_fetcher(url, *args, **kwargs):
    match = re.fullmatch(
        r"data:(image/(?:png|jpeg|webp)|font/(?:woff2|woff|ttf|otf));base64,([A-Za-z0-9+/=]+)",
        url,
    )
    if not match:
        raise PdfRejected("resource-closure")
    return {"string": decode_bytes(match[2], maximum_resource), "mime_type": match[1]}


def check_versions():
    # The broker mounts the digest-bound runtime at /tool. Development checks
    # use the adjacent source manifest; neither path comes from a request.
    lock_path = (
        Path("/tool/dependencies.lock.json")
        if __file__ == "/broker/tool"
        else Path(__file__).with_name("dependencies.lock.json")
    )
    dependencies = json.loads(
        lock_path.read_text(encoding="utf-8"), object_pairs_hook=closed_object
    )
    if not isinstance(dependencies, dict) or not 1 <= len(dependencies) <= 64:
        raise PdfRejected("dependency-lock")
    for name, version in dependencies.items():
        if importlib.metadata.version(name) != version:
            raise PdfRejected("dependency-version")
    for name, version in {
        "weasyprint": "66.0",
        "pikepdf": "9.11.0",
        "PyMuPDF": "1.26.4",
        "fonttools": "4.59.2",
        "pypdfium2": "4.30.0",
    }.items():
        if importlib.metadata.version(name) != version:
            raise PdfRejected("tool-version")


def prepare_fonts(request, root):
    from fontTools.ttLib import TTFont

    codepoints = set()
    for index, asset in enumerate(request["fontAssets"]):
        if set(asset) != {"family", "weight", "style", "mediaType", "bytes", "sha256"}:
            raise PdfRejected("font-schema")
        data = decode_bytes(asset["bytes"], maximum_resource)
        if digest(data) != asset["sha256"]:
            raise PdfRejected("font-digest")
        with TTFont(io.BytesIO(data), lazy=False) as font:
            if "OS/2" in font and font["OS/2"].fsType & 2:
                raise PdfRejected("font-embedding-prohibited")
            codepoints.update(font.getBestCmap() or {})
            # Fontconfig sees only frozen registered bytes, expanded from WOFF2.
            font.flavor = None
            font.save(root / f"font-{index}.ttf")
    parser = ClosureParser()
    parser.feed(request["htmlDocument"])
    furniture = "".join(parser.markers)
    for character in request["expectedText"] + "0123456789/" + furniture:
        if (
            not character.isspace()
            and unicodedata.category(character) != "Cf"
            and ord(character) not in codepoints
        ):
            raise PdfRejected("font-coverage")


@contextmanager
def print_layout(request):
    # The enclosing sandbox owns TMPDIR and enforces CPU/RSS/disk/wall/cancel.
    with tempfile.TemporaryDirectory(prefix="pdf-fonts-") as directory:
        root = Path(directory)
        prepare_fonts(request, root)
        config = root / "fonts.conf"
        config.write_text(
            f"<fontconfig><dir>{root}</dir><cachedir>{root}/cache</cachedir></fontconfig>",
            encoding="utf-8",
        )
        os.environ["FONTCONFIG_FILE"] = str(config)
        os.environ["FONTCONFIG_PATH"] = str(root)
        from weasyprint import HTML
        from weasyprint.text.fonts import FontConfiguration

        failures = []

        class RejectingLog(logging.Handler):
            def emit(self, record):
                if record.levelno >= logging.WARNING:
                    failures.append(record.levelno)

        handler = RejectingLog()
        logger = logging.getLogger("weasyprint")
        previous_handlers = logger.handlers[:]
        previous_propagation = logger.propagate
        logger.handlers = [handler]
        logger.propagate = False
        try:
            document = HTML(
                string=request["htmlDocument"], url_fetcher=embedded_fetcher
            ).render(font_config=FontConfiguration(), presentational_hints=True)
            if not 1 <= len(document.pages) <= maximum_pages:
                raise PdfRejected("page-budget")
            for page in document.pages:
                for box in page._page_box.descendants():
                    if (
                        getattr(box, "text", None)
                        or type(box).__name__.endswith("ReplacedBox")
                    ) and (
                        box.position_x < -1
                        or box.position_y < -1
                        or box.position_x + box.width > page.width + 1
                        or box.position_y + box.height > page.height + 1
                    ):
                        raise PdfRejected("layout-overflow")
            if failures:
                raise PdfRejected("print-layout-or-resource-warning")
            yield document
            if failures:
                raise PdfRejected("print-layout-or-resource-warning")
        finally:
            logger.handlers = previous_handlers
            logger.propagate = previous_propagation


def image_signature(image):
    from PIL import ImageChops

    if image.width * image.height > maximum_image_pixels:
        raise PdfRejected("image-pixel-budget")
    rgba = image.convert("RGBA")
    red, green, blue, alpha = rgba.split()
    # Hidden RGB under fully transparent pixels is not visible semantics.
    color = b"".join(
        ImageChops.multiply(channel, alpha).tobytes() for channel in (red, green, blue)
    )
    return (image.width, image.height, digest(color + alpha.tobytes()))


def rtl_layout_lines(page):
    from weasyprint.text.ffi import ffi, pango

    result = []
    for line_box in page._page_box.descendants():
        if type(line_box).__name__ != "LineBox":
            continue
        text_boxes = [
            box
            for box in line_box.descendants()
            if type(box).__name__ == "TextBox" and box.text
        ]
        if not any(
            unicodedata.bidirectional(character) in {"R", "AL"}
            for box in text_boxes
            for character in box.text
        ):
            continue
        glyphs = []
        for box_index, box in enumerate(text_boxes):
            layout = box.pango_layout
            layout.reactivate(box.style)
            try:
                pango.pango_layout_set_single_paragraph_mode(layout.layout, True)
                line, _ = layout.get_first_line()
                text = layout.text.encode("utf-8")
                run = line.runs[0]
                advance = 0
                while run != ffi.NULL:
                    item = run.data
                    run = run.next
                    shaped = item.glyphs
                    offset = item.item.offset
                    positions = [
                        offset + shaped.log_clusters[i]
                        for i in range(shaped.num_glyphs)
                    ]
                    if item.item.analysis.level % 2:
                        positions.insert(0, offset + item.item.length)
                    else:
                        positions.append(offset + item.item.length)
                    for index in range(shaped.num_glyphs):
                        glyph = shaped.glyphs[index]
                        start, end = sorted(positions[index : index + 2])
                        characters = text[start:end].decode("utf-8")
                        if glyph.glyph != pango.PANGO_GLYPH_EMPTY and compact_text(
                            characters
                        ):
                            glyphs.append(
                                {
                                    "text": compact_text(characters),
                                    "x": (
                                        box.position_x
                                        + (advance + glyph.geometry.x_offset) / 1024
                                    )
                                    * 0.75,
                                    "y": (
                                        box.position_y
                                        + box.baseline
                                        + glyph.geometry.y_offset / 1024
                                    )
                                    * 0.75,
                                    "order": (box_index, start),
                                }
                            )
                        advance += glyph.geometry.width
            finally:
                layout.deactivate()
        result.append(
            {
                "glyphs": glyphs,
                "left": min(box.position_x for box in text_boxes) * 0.75,
                "right": max(box.position_x + box.width for box in text_boxes) * 0.75,
            }
        )
    return result


def layout_witnesses(document, request):
    from PIL import Image, ImageChops

    parser = ClosureParser()
    parser.feed(request["htmlDocument"])
    # The wire field admits external targets. Occurrences, wrapped rectangles
    # and internal destinations are checked against every actual layout link.
    if set(parser.external_links) != set(request["expectedLinks"]):
        raise PdfRejected("link-semantics")
    anchors = {}
    for index, page in enumerate(document.pages):
        for name, rectangle in page.anchors.items():
            anchors[name] = (index, rectangle[0] * 0.75, rectangle[1] * 0.75)
    pages = []

    def boxes(box, in_pre=False):
        in_pre = in_pre or box.element_tag == "pre"
        yield box, in_pre
        for child in box.all_children():
            yield from boxes(child, in_pre)

    for page in document.pages:
        links = []
        for kind, target, rectangle, box in page.links:
            if kind not in {"external", "internal"}:
                raise PdfRejected("unsupported-print-link")
            if kind == "internal" and target not in anchors:
                raise PdfRejected("unresolved-print-link")
            links.append(
                {
                    "kind": kind,
                    "target": target,
                    "rectangle": tuple(value * 0.75 for value in rectangle),
                    "destination": anchors.get(target) if kind == "internal" else None,
                }
            )
        images = []
        code_lines = []
        for box, in_pre in boxes(page._page_box):
            if in_pre and getattr(box, "text", None):
                code_lines.append(
                    {
                        "text": unicodedata.normalize(
                            "NFC", box.text.replace("\t", " ")
                        ),
                        "x": box.position_x * 0.75,
                        "baseline": (box.position_y + box.baseline) * 0.75,
                        "width": box.width * 0.75,
                    }
                )
            if (
                type(box).__name__.endswith("ReplacedBox")
                and type(box.replacement).__name__ == "RasterImage"
            ):
                with Image.open(io.BytesIO(box.replacement.image_data.data)) as image:
                    signature = (
                        image_signature(image),
                        box.style["image_rendering"] == "auto",
                    )
                    rgba = image.convert("RGBA")
                    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                    appearance = Image.alpha_composite(white, rgba).convert("RGB")
                    visible_ink = (
                        ImageChops.difference(
                            appearance, white.convert("RGB")
                        ).getbbox()
                        is not None
                    )
                x, y = box.content_box_x() * 0.75, box.content_box_y() * 0.75
                images.append(
                    {
                        "rectangle": (
                            x,
                            y,
                            x + box.width * 0.75,
                            y + box.height * 0.75,
                        ),
                        "signature": signature,
                        "imageData": bytes(box.replacement.image_data.data),
                        "visibleInk": visible_ink,
                    }
                )
        pages.append(
            {
                "links": links,
                "images": images,
                "codeLines": code_lines,
                "rtlLines": rtl_layout_lines(page),
            }
        )
    return pages


def same_rectangle(left, right):
    return len(left) == len(right) == 4 and all(
        abs(a - b) <= 0.25 for a, b in zip(left, right)
    )


def validate_layout_links(page, pdf, expected):
    import pymupdf

    remaining = expected[:]
    names = pdf.resolve_names()
    for actual in page.get_links():
        match = None
        for index, link in enumerate(remaining):
            if not same_rectangle(actual["from"], link["rectangle"]):
                continue
            if link["kind"] == "external":
                if actual.get("uri") != link["target"]:
                    continue
            else:
                target_page, x, y = link["destination"]
                if actual.get("page") != target_page:
                    continue
                if actual["kind"] == pymupdf.LINK_NAMED:
                    if actual.get("nameddest") != link["target"]:
                        continue
                    named = names.get(link["target"])
                    if named is None or named.get("page") != target_page:
                        continue
                    target = named.get("to")
                    y = pdf[target_page].rect.height - y
                elif actual["kind"] == pymupdf.LINK_GOTO:
                    target = actual.get("to")
                else:
                    continue
                if (
                    target is None
                    or abs(target[0] - x) > 0.25
                    or abs(target[1] - y) > 0.25
                ):
                    continue
            match = index
            break
        if match is None:
            raise PdfRejected("link-semantics")
        remaining.pop(match)
    if remaining:
        raise PdfRejected("link-semantics")


def validate_layout_images(page, signatures, expected):
    remaining = expected[:]
    for image in page.get_image_info(xrefs=True):
        match = next(
            (
                index
                for index, reference in enumerate(remaining)
                if same_rectangle(image["bbox"], reference["rectangle"])
                and signatures.get(image["xref"]) == reference["signature"]
            ),
            None,
        )
        if match is None:
            raise PdfRejected("image-semantics")
        remaining.pop(match)
    if remaining:
        raise PdfRejected("image-semantics")


def frozen_image_paint(page_size, expected):
    import pypdfium2
    from PIL import Image

    # A fresh, never-serialized native page contains only frozen source pixels
    # at their canonical layout positions. No candidate clip, transform, blend
    # state or image object is copied into this independent appearance oracle.
    with (
        closing(pypdfium2.PdfDocument.new()) as oracle,
        closing(oracle.new_page(*page_size)) as page,
    ):
        for reference in expected:
            image_object = pypdfium2.PdfImage.new(oracle)
            with Image.open(io.BytesIO(reference["imageData"])) as image:
                if image.format == "JPEG":
                    image_object.load_jpeg(
                        io.BytesIO(reference["imageData"]), inline=True
                    )
                else:
                    with closing(
                        pypdfium2.PdfBitmap.from_pil(image.convert("RGBA"))
                    ) as bitmap:
                        image_object.set_bitmap(bitmap)
            x0, y0, x1, y1 = reference["rectangle"]
            image_object.set_matrix(
                pypdfium2.PdfMatrix(x1 - x0, 0, 0, y1 - y0, x0, page_size[1] - y1)
            )
            page.insert_obj(image_object)
        with closing(
            page.render(scale=2, draw_annots=False, no_smoothimage=True)
        ) as bitmap:
            return bitmap.to_pil().convert("RGB").copy()


def validate_visible_images(data, page_number, expected):
    import pypdfium2
    import pypdfium2.raw as pdfium
    from PIL import Image, ImageChops

    if not expected:
        return
    with (
        closing(pypdfium2.PdfDocument(data)) as pdf,
        closing(pdf[page_number]) as page,
    ):
        objects = list(page.get_objects(max_depth=1))
        images = [obj for obj in objects if obj.type == pdfium.FPDF_PAGEOBJ_IMAGE]
        if len(images) != len(expected):
            raise PdfRejected("unverifiable-image-paint")
        with closing(page.render(scale=2)) as bitmap:
            actual = bitmap.to_pil().convert("RGB").copy()
        # Native nearest sampling compares source paint without inheriting the
        # candidate's clipping/transform. Declared interpolation is bound to
        # the canonical style separately; normal rendering below is retained.
        with closing(page.render(scale=2, no_smoothimage=True)) as bitmap:
            actual_source_paint = bitmap.to_pil().convert("RGB").copy()
        canonical = frozen_image_paint(page.get_size(), expected)
        # Preserve the existing normal-render occlusion check. This candidate
        # isolation is only an extra overlay check, not the source-paint oracle.
        for obj in objects:
            if obj.type != pdfium.FPDF_PAGEOBJ_IMAGE:
                page.remove_obj(obj)
                obj.close()
        with closing(page.render(scale=2, draw_annots=False)) as bitmap:
            isolated = bitmap.to_pil().convert("RGB").copy()
        for reference in expected:
            x0, y0, x1, y1 = (value * 2 for value in reference["rectangle"])
            bounds = (math.ceil(x0), math.ceil(y0), math.floor(x1), math.floor(y1))
            if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
                raise PdfRejected("unverifiable-image-paint")
            unoccluded = isolated.crop(bounds)
            if (
                ImageChops.difference(actual.crop(bounds), unoccluded).getbbox()
                is not None
            ):
                raise PdfRejected("occluded-image-semantics")
            white = Image.new("RGB", unoccluded.size, (255, 255, 255))
            if (
                reference["visibleInk"]
                and ImageChops.difference(unoccluded, white).getbbox() is None
            ):
                raise PdfRejected("invisible-image-semantics")
            if (
                ImageChops.difference(
                    actual_source_paint.crop(bounds), canonical.crop(bounds)
                ).getbbox()
                is not None
            ):
                raise PdfRejected("changed-image-paint-semantics")


def validate_code_lines(page, expected):
    characters = [
        character
        for block in page.get_text("rawdict", sort=True)["blocks"]
        for line in block.get("lines", [])
        for span in line["spans"]
        for character in span["chars"]
    ]
    for line in expected:
        # Keep the parser's logical glyph order: a decomposed ligature can put
        # its zero-width second character at the next glyph's x coordinate.
        actual = [
            character
            for character in characters
            if abs(character["origin"][1] - line["baseline"]) <= 0.25
            and line["x"] - 0.1 <= character["origin"][0]
            and (
                character["origin"][0] < line["x"] + line["width"] - 0.01
                or abs(character["bbox"][2] - character["bbox"][0]) <= 0.01
                and character["origin"][0] <= line["x"] + line["width"] + 0.25
            )
        ]
        text = unicodedata.normalize(
            "NFC", "".join(character["c"] for character in actual)
        )
        if text != line["text"]:
            raise PdfRejected("code-whitespace-semantics")
        if actual and (
            abs(min(character["origin"][0] for character in actual) - line["x"]) > 0.25
            or abs(
                max(character["bbox"][2] for character in actual)
                - line["x"]
                - line["width"]
            )
            > 0.5
        ):
            raise PdfRejected("code-whitespace-semantics")


def read_body_text(page, body, rtl_lines):
    # Pango's frozen-font layout supplies cluster positions and logical indices.
    # The letters below always come from actual PDF ToUnicode clusters: matching
    # source letters at those positions prevents arbitrary BiDi reordering from
    # accepting a changed letter sequence.
    clusters = []
    buckets = {}
    for span in page.get_texttrace():
        previous = None
        for codepoint, glyph, origin, rectangle in span["chars"]:
            if glyph == -1 and previous is not None:
                previous["text"] += chr(codepoint)
            else:
                previous = {"text": chr(codepoint), "x": origin[0], "y": origin[1]}
                index = len(clusters)
                clusters.append(previous)
                key = (round(origin[0] * 4), round(origin[1] * 4))
                buckets.setdefault(key, []).append(index)
    corrected = []
    for reference in rtl_lines:
        used = set()
        pieces = []
        for expected in reference["glyphs"]:
            key = (round(expected["x"] * 4), round(expected["y"] * 4))
            candidates = [
                index
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                for index in buckets.get((key[0] + dx, key[1] + dy), [])
                if index not in used
                and abs(clusters[index]["x"] - expected["x"]) <= 0.25
                and abs(clusters[index]["y"] - expected["y"]) <= 0.25
                and compact_text(clusters[index]["text"]) == expected["text"]
            ]
            if not candidates:
                raise PdfRejected("text-order-or-content")
            index = min(
                candidates,
                key=lambda index: (
                    abs(clusters[index]["x"] - expected["x"])
                    + abs(clusters[index]["y"] - expected["y"])
                ),
            )
            used.add(index)
            pieces.append((expected["order"], clusters[index]["text"]))
        baselines = {glyph["y"] for glyph in reference["glyphs"]}
        for index, cluster in enumerate(clusters):
            if (
                index not in used
                and compact_text(cluster["text"])
                and reference["left"] - 0.25
                <= cluster["x"]
                <= reference["right"] + 0.25
                and any(abs(cluster["y"] - y) <= 0.25 for y in baselines)
            ):
                raise PdfRejected("text-order-or-content")
        corrected.append(
            {
                "reference": reference,
                "baselines": baselines,
                "text": "".join(text for order, text in sorted(pieces)),
                "seen": False,
            }
        )
    lines = []
    for block in page.get_text("rawdict", clip=body, sort=True)["blocks"]:
        for line in block.get("lines", []):
            characters = [
                character for span in line["spans"] for character in span["chars"]
            ]
            text = "".join(character["c"] for character in characters)
            for candidate in corrected:
                reference = candidate["reference"]
                if not any(
                    abs(character["origin"][1] - y) <= 0.25
                    for character in characters
                    for y in candidate["baselines"]
                ):
                    continue
                if not any(
                    reference["left"] - 0.25
                    <= character["origin"][0]
                    <= reference["right"] + 0.25
                    for character in characters
                ):
                    continue
                if any(
                    not character["c"].isspace()
                    and not reference["left"] - 0.25
                    <= character["origin"][0]
                    <= reference["right"] + 0.25
                    for character in characters
                ):
                    raise PdfRejected("text-order-or-content")
                # MuPDF can split one HTML line at an inline font/BiDi run.
                # Every glyph was checked above, including unexpected extras.
                text = "" if candidate["seen"] else candidate["text"]
                candidate["seen"] = True
                break
            lines.append(text)
    if any(not candidate["seen"] for candidate in corrected):
        raise PdfRejected("text-order-or-content")
    return "\n".join(lines) + "\n"


def verify_pdf(data, request, witnesses=None):
    """Independent qpdf structure and MuPDF semantics/visible-page validation.

    Normalization v1 ignores object numbers, timestamps, document IDs and font
    subset labels. It hashes rendered pages, ordered extracted text and actual
    link rectangles/targets. Visible content is never rewritten for normalization.
    """
    import pikepdf
    import pymupdf
    import pypdfium2

    validate_request(request)
    if (
        not data.startswith(b"%PDF-")
        or not data.rstrip().endswith(b"%%EOF")
        or len(data) > maximum_output
    ):
        raise PdfRejected("pdf-header-or-size")
    font_count = 0
    image_signatures = {}
    try:
        structure = pikepdf.Pdf.open(io.BytesIO(data), attempt_recovery=False)
    except pikepdf.PdfError as error:
        raise PdfRejected("pdf-structure") from error
    with structure as pdf:
        if (
            pdf.is_encrypted
            or pdf.check_pdf_syntax()
            or not 1 <= len(pdf.pages) <= maximum_pages
        ):
            raise PdfRejected("pdf-structure")
        for obj in pdf.objects:
            if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                if any(
                    key in obj
                    for key in (
                        "/JS",
                        "/JavaScript",
                        "/AA",
                        "/OpenAction",
                        "/AcroForm",
                        "/EmbeddedFiles",
                        "/EF",
                        "/XFA",
                        "/RichMedia",
                    )
                ):
                    raise PdfRejected("pdf-active-content")
                if isinstance(obj, pikepdf.Stream) and "/F" in obj:
                    raise PdfRejected("pdf-external-stream")
                if obj.get("/Subtype") == pikepdf.Name("/Image"):
                    if int(obj["/Width"]) * int(obj["/Height"]) > maximum_image_pixels:
                        raise PdfRejected("image-pixel-budget")
                    image = pikepdf.PdfImage(obj).as_pil_image().convert("RGBA")
                    if "/SMask" in obj:
                        alpha = (
                            pikepdf.PdfImage(obj["/SMask"]).as_pil_image().convert("L")
                        )
                        image.putalpha(alpha)
                    image_signatures[obj.objgen[0]] = (
                        image_signature(image),
                        bool(obj.get("/Interpolate", False)),
                    )
                if "/S" in obj and str(obj["/S"]) not in {
                    "/URI",
                    "/GoTo",
                    "/Transparency",
                }:
                    raise PdfRejected("pdf-action")
                if obj.get("/Type") == pikepdf.Name("/Font"):
                    if obj.get("/Subtype") == pikepdf.Name("/Type0"):
                        if not obj.get("/DescendantFonts") or "/ToUnicode" not in obj:
                            raise PdfRejected("font-resource-closure")
                        continue
                    if "/FontDescriptor" not in obj:
                        raise PdfRejected("unembedded-font")
                    descriptor = obj["/FontDescriptor"]
                    if not any(
                        key in descriptor
                        for key in ("/FontFile", "/FontFile2", "/FontFile3")
                    ):
                        raise PdfRejected("unembedded-font")
                    font_count += 1
        if font_count == 0:
            raise PdfRejected("screenshot-or-missing-fonts")
    if witnesses is None:
        with print_layout(request) as document:
            witnesses = layout_witnesses(document, request)
    projection = {
        "policy": "normalized-pdf-visible-v1",
        "inputDigest": request["inputDigest"],
        "pages": [],
    }
    extracted = []
    with (
        pymupdf.open(stream=data, filetype="pdf") as pdf,
        closing(pypdfium2.PdfDocument(data)) as visible_pdf,
    ):
        if len(visible_pdf) != len(pdf):
            raise PdfRejected("independent-page-count")
        if len(pdf) != len(witnesses):
            raise PdfRejected("print-page-semantics")
        for page in pdf:
            if (
                abs(page.rect.width - 595.2756) > 1
                or abs(page.rect.height - 841.8898) > 1
            ):
                raise PdfRejected("page-geometry")
            # Closed print profile reserves 18 mm top and bottom for furniture.
            body = pymupdf.Rect(
                0, 18 * 72 / 25.4, page.rect.width, page.rect.height - 18 * 72 / 25.4
            )
            # SVG text is a separate PDF XObject and can occur later in object
            # order than its visible position. Sort text blocks by reading
            # position while retaining each block's logical Unicode order.
            reference = witnesses[page.number]
            text = read_body_text(page, body, reference["rtlLines"])
            if "\ufffd" in text or "\x00" in text:
                raise PdfRejected("text-tofu")
            extracted.append(text)
            validate_layout_images(page, image_signatures, reference["images"])
            validate_visible_images(data, page.number, reference["images"])
            validate_layout_links(page, pdf, reference["links"])
            validate_code_lines(page, reference["codeLines"])
            for span in page.get_texttrace():
                if span["type"] == 3 or span["opacity"] == 0:
                    raise PdfRejected("invisible-text")
                for codepoint, glyph, origin, rectangle in span["chars"]:
                    if glyph == 0 and not chr(codepoint).isspace():
                        raise PdfRejected("text-tofu")
            links = []
            for link in page.get_links():
                target = link.get("uri")
                if target is not None:
                    if not safe_link(target):
                        raise PdfRejected("unsafe-pdf-link")
                elif link["kind"] not in {
                    pymupdf.LINK_GOTO,
                    pymupdf.LINK_NAMED,
                } or not 0 <= link.get("page", -1) < len(pdf):
                    raise PdfRejected("unresolved-pdf-link")
                if link["kind"] == pymupdf.LINK_NAMED:
                    named = pdf.resolve_names().get(link.get("nameddest"))
                    if named is None or named.get("page") != link.get("page"):
                        raise PdfRejected("unresolved-pdf-link")
                links.append(
                    {
                        "target": target,
                        "page": link.get("page"),
                        "namedDestination": link.get("nameddest"),
                        "rectangle": [round(value, 3) for value in link["from"]],
                    }
                )
            # PDFium is the visible-page authority. MuPDF remains a distinct
            # text/link parser; its CFF rendering behavior is not used as a
            # proxy for the actual visible glyphs.
            with (
                closing(visible_pdf[page.number]) as visible_page,
                closing(visible_page.render(scale=1)) as bitmap,
            ):
                pixel_bytes = bitmap.to_pil().convert("RGB").tobytes()
            projection["pages"].append(
                {
                    "pixels": digest(pixel_bytes),
                    "text": compact_text(text),
                    "links": links,
                }
            )
        validate_text_order(extracted, request)
        semantic_digest = digest(
            json.dumps(
                projection, sort_keys=True, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        )
        return {
            "pdfBase64": base64.b64encode(data).decode("ascii"),
            "semanticDigest": semantic_digest,
            "pageCount": len(pdf),
            "fontCount": font_count,
            "warnings": [],
        }


def execute(request):
    validate_request(request)
    check_versions()
    with print_layout(request) as document:
        witnesses = layout_witnesses(document, request)
        # Verify mode lays out the same closed HTML for semantic expectations,
        # then parses the original bytes. It never writes a replacement PDF.
        data = (
            document.write_pdf()
            if request["pdfBase64"] is None
            else decode_bytes(request["pdfBase64"], maximum_output)
        )
        if len(data) > maximum_output:
            raise PdfRejected("output-budget")
    return verify_pdf(data, request, witnesses)


def closed_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PdfRejected("duplicate-property")
        result[key] = value
    return result


def main():
    try:
        if sys.argv[1:] != ["render"]:
            raise PdfRejected("fixed-arguments")
        raw = sys.stdin.buffer.read(maximum_input + 1)
        if len(raw) > maximum_input:
            raise PdfRejected("input-budget")
        request = json.loads(raw, object_pairs_hook=closed_object)
        output = json.dumps(
            execute(request), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(output) > maximum_input:
            raise PdfRejected("message-budget")
        sys.stdout.buffer.write(output)
        return 0
    except PdfRejected as error:
        sys.stderr.write(str(error) + "\n")
        return 1


def private_exception_hook(_exception_type, _exception_value, _traceback):
    # Unexpected failures retain Python's nonzero exit without disclosing their
    # exception value or traceback (which may contain source text or paths).
    sys.stderr.write("pdf-tool-failed\n")


if __name__ == "__main__":
    sys.excepthook = private_exception_hook
    sys.exit(main())
