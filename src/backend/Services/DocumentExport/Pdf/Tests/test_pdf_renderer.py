"""Real PDF render/parse controls; fixtures are canonical-HTML boundary inputs."""

import base64
import importlib.util
import io
import json
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pikepdf
import pymupdf
import pypdfium2
import pytest
from fontTools import subset
from fontTools.ttLib import TTFont
from PIL import Image

tool_path = Path(__file__).parents[1] / "Tools" / "pdf_renderer.py"
spec = importlib.util.spec_from_file_location("pdf_renderer", tool_path)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def font_asset(path, family="DejaVu Sans", font_number=None, characters=None):
    if font_number is None and characters is None:
        data = Path(path).read_bytes()
    else:
        with TTFont(
            path, fontNumber=font_number if font_number is not None else -1
        ) as font:
            if characters is not None:
                subsetter = subset.Subsetter()
                subsetter.populate(text=characters + "0123456789/ ")
                subsetter.subset(font)
            stream = io.BytesIO()
            font.save(stream)
            data = stream.getvalue()
    return {
        "family": family,
        "weight": 400,
        "style": "normal",
        "mediaType": "font/ttf",
        "bytes": base64.b64encode(data).decode(),
        "sha256": tool.digest(data),
    }


def request(fragment="<p>Hello PDF</p>", expected="Hello PDF", links=None, fonts=None):
    fonts = fonts or [font_asset("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    faces = "".join(
        f"@font-face{{font-family:'{font['family']}';src:url(data:{font['mediaType']};base64,{font['bytes']})}}"
        for font in fonts
    )
    css = "@page{size:A4;margin:18mm;@bottom-center{content:counter(page)' / 'counter(pages);font-size:9px}}body{margin:0;font-family:'DejaVu Sans';font-size:12px}pre{direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}table{table-layout:fixed;width:100%}td{overflow-wrap:anywhere}.page-break{break-before:page}"
    return {
        "htmlDocument": f"<!doctype html><html><head><meta charset='utf-8'><style>{faces}{css}</style></head><body>{fragment}</body></html>",
        "fontAssets": fonts,
        "expectedText": expected,
        "expectedLinks": links or [],
        "inputDigest": "sha256:" + "a" * 64,
        "printProfile": "a4-reading-v1",
        "pdfBase64": None,
    }


def render_in_process(value):
    # Fontconfig is process-global, so each render uses a fresh real process.
    completed = subprocess.run(
        [sys.executable, str(tool_path), "render"],
        input=json.dumps(value).encode(),
        capture_output=True,
        timeout=60,
        check=False,
    )
    if completed.returncode:
        raise tool.PdfRejected(completed.stderr.decode().strip())
    return json.loads(completed.stdout)


def test_real_paginated_pdf_preserves_links_breaks_and_embedded_fonts(tmp_path):
    value = request(
        "<h1>First page</h1><p><a href='https://example.org/'>Safe link</a></p><p class='page-break'>Second page</p>",
        "First pageSafe linkSecond page",
        ["https://example.org/"],
    )
    result = render_in_process(value)
    data = base64.b64decode(result["pdfBase64"])
    (tmp_path / "paginated.pdf").write_bytes(data)
    assert result["pageCount"] == 2
    assert result["fontCount"] >= 1
    with pymupdf.open(stream=data) as pdf:
        assert "First page" in pdf[0].get_text()
        assert "Second page" in pdf[1].get_text()
        assert pdf[0].get_links()[0]["uri"] == "https://example.org/"


def test_normalization_ignores_metadata_but_detects_visible_tamper():
    value = request()
    result = render_in_process(value)
    data = base64.b64decode(result["pdfBase64"])
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        pdf.docinfo["/CreationDate"] = "D:20000101000000Z"
        altered = io.BytesIO()
        pdf.save(altered, static_id=True)
    assert (
        tool.verify_pdf(altered.getvalue(), value)["semanticDigest"]
        == result["semanticDigest"]
    )
    with pymupdf.open(stream=data) as pdf:
        pdf[0].draw_rect(pymupdf.Rect(10, 10, 30, 30), fill=(1, 0, 0))
        changed = pdf.tobytes()
    assert tool.verify_pdf(changed, value)["semanticDigest"] != result["semanticDigest"]


def test_normalized_digest_is_stable_across_real_render_attempts():
    value = request()
    first = render_in_process(value)
    second = render_in_process(value)
    assert first["semanticDigest"] == second["semanticDigest"]
    assert first["pageCount"] == second["pageCount"]
    assert first["fontCount"] == second["fontCount"]


@pytest.mark.parametrize("data", [b"", b"%PDF-1.7\n%%EOF", b"<html>not PDF</html>"])
def test_invalid_pdf_is_rejected(data):
    with pytest.raises(tool.PdfRejected):
        tool.verify_pdf(data, request())


def test_zero_page_pdf_is_rejected():
    with pikepdf.Pdf.new() as pdf:
        stream = io.BytesIO()
        pdf.save(stream)
    with pytest.raises(tool.PdfRejected, match="pdf-structure"):
        tool.verify_pdf(stream.getvalue(), request())


def test_truncated_real_pdf_is_rejected():
    result = render_in_process(request())
    with pytest.raises(tool.PdfRejected, match="pdf-header"):
        tool.verify_pdf(base64.b64decode(result["pdfBase64"])[:-40], request())


@pytest.mark.parametrize(
    "fragment",
    [
        "<script>alert(1)</script>",
        "<img src='https://example.org/private.png'>",
        "<p style='display:none'>Hidden</p>",
        "<a href='javascript:alert(1)'>X</a>",
        "<iframe src='file:///etc/passwd'></iframe>",
    ],
)
def test_no_network_user_script_or_css(fragment):
    with pytest.raises(tool.PdfRejected):
        tool.validate_request(request(fragment))


def test_fetcher_cannot_read_network_or_host_files():
    for url in [
        "https://example.org/",
        "file:///etc/passwd",
        "data:text/html;base64,WA==",
    ]:
        with pytest.raises(tool.PdfRejected, match="resource-closure"):
            tool.embedded_fetcher(url)


def test_missing_unicode_font_and_font_digest_drift_fail_closed():
    with pytest.raises(tool.PdfRejected, match="font-coverage"):
        render_in_process(request("<p>中文</p>", "中文"))
    value = request()
    value["fontAssets"][0]["sha256"] = "sha256:" + "0" * 64
    with pytest.raises(tool.PdfRejected, match="font-digest"):
        render_in_process(value)


def test_text_and_link_tamper_are_rejected():
    value = request()
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    value["expectedText"] = "Different text"
    with pytest.raises(tool.PdfRejected, match="text-order-or-content"):
        tool.verify_pdf(data, value)
    value["expectedText"] = "Hello PDF"
    value["expectedLinks"] = ["https://example.org/"]
    with pytest.raises(tool.PdfRejected, match="link-semantics"):
        tool.verify_pdf(data, value)


def test_large_source_real_many_page_output():
    text = "The bounded article preserves every sentence. " * 2500
    value = request(f"<p>{text}</p>", text)
    result = render_in_process(value)
    assert len(text) > 100000
    assert 10 < result["pageCount"] < tool.maximum_pages


def test_verify_mode_returns_actual_bytes_and_same_semantics():
    value = request()
    result = render_in_process(value)
    value["pdfBase64"] = result["pdfBase64"]
    assert render_in_process(value) == result


def test_verify_mode_never_writes_a_replacement_pdf(monkeypatch):
    value = request()
    result = render_in_process(value)
    value["pdfBase64"] = result["pdfBase64"]
    from weasyprint.document import Document

    def forbidden_writer(*args, **kwargs):
        raise AssertionError("Verify mode must not generate PDF bytes")

    monkeypatch.setattr(Document, "write_pdf", forbidden_writer)
    assert tool.execute(value) == result


def test_closed_fields_and_profile():
    value = request()
    value["printProfile"] = "arbitrary-css"
    with pytest.raises(tool.PdfRejected, match="print-profile"):
        tool.validate_request(value)
    with pytest.raises(tool.PdfRejected, match="duplicate-property"):
        tool.closed_object([("a", 1), ("a", 2)])


def test_fixed_cli_arguments_and_private_errors():
    result = subprocess.run(
        [sys.executable, str(tool_path), "--eval", "private title"],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == b""
    assert result.stderr == b"fixed-arguments\n"


def test_cjk_and_emoji_with_registered_frozen_fonts():
    text = "中文 PDF 😀"
    fonts = [
        font_asset("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        font_asset(
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "Noto Sans CJK SC",
            2,
            "中文",
        ),
    ]
    result = render_in_process(request(f"<p>{text}</p>", text, fonts=fonts))
    assert result["pageCount"] == 1
    assert result["fontCount"] >= 2
    data = base64.b64decode(result["pdfBase64"])
    with pymupdf.open(stream=data) as parsed:
        chinese = next(
            span
            for block in parsed[0].get_text("dict")["blocks"]
            for line in block.get("lines", [])
            for span in line["spans"]
            if "中文" in span["text"]
        )
    with (
        closing(pypdfium2.PdfDocument(data)) as visible,
        closing(visible[0]) as page,
        closing(page.render(scale=2)) as bitmap,
    ):
        bounds = [int(value * 2) for value in chinese["bbox"]]
        pixels = bitmap.to_pil().convert("RGB").crop(bounds)
        assert any(low < 200 for low, high in pixels.getextrema())


def test_rtl_with_registered_font_has_actual_extraction():
    text = "مرحبا بالعالم"
    fonts = [
        font_asset("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        font_asset(
            "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
            "Noto Sans Arabic",
        ),
    ]
    result = render_in_process(request(f"<p dir='rtl'>{text}</p>", text, fonts=fonts))
    assert result["fontCount"] >= 1


def test_wide_code_and_table_preserve_every_character():
    code = "very_long_identifier_" * 50
    value = request(
        f"<pre>{code}</pre><table><tr><td>Alpha</td><td>Beta</td></tr></table>",
        code + "AlphaBeta",
    )
    result = render_in_process(value)
    assert result["pageCount"] >= 1


def test_screenshot_only_pdf_is_rejected():
    with pymupdf.open() as pdf:
        pdf.new_page(width=595.2756, height=841.8898)
        data = pdf.tobytes()
    with pytest.raises(tool.PdfRejected, match="screenshot-or-missing-fonts"):
        tool.verify_pdf(data, request())


def test_resource_and_output_budget_refusals(monkeypatch):
    with pytest.raises(tool.PdfRejected, match="resource-budget"):
        tool.decode_bytes(base64.b64encode(b"12345").decode(), 4)
    result = render_in_process(request())
    monkeypatch.setattr(tool, "maximum_output", 4)
    with pytest.raises(tool.PdfRejected, match="pdf-header-or-size"):
        tool.verify_pdf(base64.b64decode(result["pdfBase64"]), request())


def test_generated_list_markers_are_preserved_and_verified():
    result = render_in_process(
        request(
            "<ul><li>First</li><li>Second</li></ul><ol start='3'><li>Third</li><li>Fourth</li></ol>",
            "FirstSecondThirdFourth",
        )
    )
    with pymupdf.open(stream=base64.b64decode(result["pdfBase64"])) as pdf:
        text = pdf[0].get_text()
        assert text.count("•") == 2
        assert "3." in text and "4." in text


def test_table_repeated_headers_preserve_order_without_false_loss():
    rows = "".join(
        f"<tr><td>Row {index}</td><td>Value {index}</td></tr>" for index in range(120)
    )
    expected = "Column AColumn B" + "".join(
        f"Row {index}Value {index}" for index in range(120)
    )
    value = request(
        f"<table><thead><tr><th>Column A</th><th>Column B</th></tr></thead><tbody>{rows}</tbody></table>",
        expected,
    )
    result = render_in_process(value)
    assert result["pageCount"] > 1


def test_inline_image_svg_math_captions_and_footnote_links():
    image = io.BytesIO()
    Image.new("RGB", (20, 10), (100, 150, 200)).save(image, format="PNG")
    encoded = base64.b64encode(image.getvalue()).decode()
    fragment = (
        f"<figure><img src='data:image/png;base64,{encoded}' alt='Figure'/>"
        "<figcaption>Caption</figcaption></figure>"
        "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='30'>"
        "<title>Diagram description</title><text x='0' y='20'>x² + y²</text></svg>"
        "<p>Reference<a href='#note'>1</a></p><p id='note'>Footnote</p>"
    )
    result = render_in_process(request(fragment, "Captionx² + y²Reference1Footnote"))
    with pymupdf.open(stream=base64.b64decode(result["pdfBase64"])) as pdf:
        assert pdf[0].get_images()
        assert pdf[0].get_links()[0]["kind"] in {pymupdf.LINK_GOTO, pymupdf.LINK_NAMED}


def test_unembedded_font_resource_is_rejected_even_alongside_valid_fonts():
    value = request()
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        font = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name("/Font"),
                Subtype=pikepdf.Name("/Type1"),
                BaseFont=pikepdf.Name("/Helvetica"),
            )
        )
        pdf.pages[0].Resources.Font["/UnregisteredFont"] = font
        stream = io.BytesIO()
        pdf.save(stream)
    with pytest.raises(tool.PdfRejected, match="unembedded-font"):
        tool.verify_pdf(stream.getvalue(), value)


def image_fragment(mode="RGB", image_format="PNG"):
    image = io.BytesIO()
    color = (100, 150, 200, 128) if mode == "RGBA" else (100, 150, 200)
    Image.new(mode, (20, 10), color).save(image, format=image_format)
    media_type = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}[image_format]
    return f"<img src='data:image/{media_type};base64,{base64.b64encode(image.getvalue()).decode()}'/>"


def patterned_image_fragment(mode="RGB", image_format="PNG"):
    picture = Image.new(mode, (40, 20), (40, 100, 200))
    for x in range(40):
        for y in range(20):
            color = (200, 50, 30) if x < 10 else (40, 100 + y, 200)
            if mode == "RGBA":
                color += ((0, 64, 128, 255)[x // 10],)
            picture.putpixel((x, y), color)
    raster = io.BytesIO()
    picture.save(raster, format=image_format)
    media_type = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}[image_format]
    return f"<img src='data:image/{media_type};base64,{base64.b64encode(raster.getvalue()).decode()}'/>"


@pytest.mark.parametrize("paint_prefix", ["q 0 0 0.5 1 re W n", "q -1 0 0 -1 1 1 cm"])
def test_verifier_rejects_changed_image_clip_or_rotation(paint_prefix):
    value = request("<p>Caption</p>" + patterned_image_fragment(), "Caption")
    original = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pikepdf.Pdf.open(io.BytesIO(original)) as pdf:
        page = pdf.pages[0]
        instructions = []
        for item in pikepdf.parse_content_stream(page):
            is_image = str(item.operator) == "Do" and page.Resources.XObject[
                item.operands[0]
            ].get("/Subtype") == pikepdf.Name("/Image")
            if is_image:
                instructions.extend(
                    pikepdf.parse_content_stream(
                        pikepdf.Stream(pdf, paint_prefix.encode())
                    )
                )
                instructions.append(item)
                instructions.extend(
                    pikepdf.parse_content_stream(pikepdf.Stream(pdf, b"Q"))
                )
            else:
                instructions.append(item)
        page.Contents = pikepdf.Stream(
            pdf, pikepdf.unparse_content_stream(instructions)
        )
        output = io.BytesIO()
        pdf.save(output)
    with pytest.raises(tool.PdfRejected, match="changed-image-paint-semantics"):
        render_in_process(
            value | {"pdfBase64": base64.b64encode(output.getvalue()).decode()}
        )


@pytest.mark.parametrize(
    "mode,image_format",
    [
        ("RGB", "PNG"),
        ("RGB", "JPEG"),
        ("RGB", "WEBP"),
        ("RGBA", "PNG"),
        ("RGBA", "WEBP"),
    ],
)
def test_frozen_patterned_images_keep_pixels_orientation_and_alpha(mode, image_format):
    image = patterned_image_fragment(mode, image_format)
    scaled = image.replace("<img ", "<img width='160' height='80' ")
    value = request(f"<p>Caption</p>{scaled}{image}", "Caption")
    result = render_in_process(value)
    assert tool.execute(value | {"pdfBase64": result["pdfBase64"]}) == result


def test_unexpected_cli_failure_keeps_exception_value_and_traceback_private():
    result = subprocess.run(
        [sys.executable, str(tool_path), "render"],
        input=b'{"private title /private/path https://private.test":',
        capture_output=True,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == b""
    assert result.stderr == b"pdf-tool-failed\n"


def test_verifier_rejects_missing_frozen_image():
    value = request("<p>Hello PDF</p>" + image_fragment())
    render_in_process(value)
    missing_image = base64.b64decode(render_in_process(request())["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="image-semantics"):
        tool.verify_pdf(missing_image, value)


@pytest.mark.parametrize("partial", [False, True])
def test_verifier_rejects_fully_or_partly_occluded_frozen_image(partial):
    value = request("<p>Hello PDF</p>" + image_fragment())
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pymupdf.open(stream=data) as pdf:
        box = pymupdf.Rect(pdf[0].get_image_info()[0]["bbox"])
        if partial:
            box.x1 = (box.x0 + box.x1) / 2
        pdf[0].draw_rect(box, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)
        changed = pdf.tobytes()
    with pytest.raises(tool.PdfRejected, match="occluded-image-semantics"):
        render_in_process(value | {"pdfBase64": base64.b64encode(changed).decode()})


def test_image_visibility_verification_never_serializes_pdf(monkeypatch):
    value = request("<p>Hello PDF</p>" + image_fragment("RGBA"))
    result = render_in_process(value)
    value["pdfBase64"] = result["pdfBase64"]
    from weasyprint.document import Document

    def forbidden_writer(*args, **kwargs):
        raise AssertionError("Verify mode must not serialize a PDF")

    monkeypatch.setattr(Document, "write_pdf", forbidden_writer)
    monkeypatch.setattr(pikepdf.Pdf, "save", forbidden_writer)
    monkeypatch.setattr(pypdfium2.PdfDocument, "save", forbidden_writer)
    assert tool.execute(value) == result


def remove_annotation(data, index):
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        annotations = pdf.pages[0].Annots
        pdf.pages[0].Annots = pikepdf.Array(
            annotation
            for offset, annotation in enumerate(annotations)
            if offset != index
        )
        output = io.BytesIO()
        pdf.save(output)
    return output.getvalue()


def test_verifier_rejects_missing_internal_link():
    value = request(
        "<p><a href='#note'>Reference</a></p><p id='note'>Note</p>", "ReferenceNote"
    )
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="link-semantics"):
        tool.verify_pdf(remove_annotation(data, 0), value)


def test_verifier_rejects_one_missing_repeated_external_link():
    target = "https://example.org/"
    value = request(
        f"<p><a href='{target}'>First</a> <a href='{target}'>Second</a></p>",
        "FirstSecond",
        [target, target],
    )
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="link-semantics"):
        tool.verify_pdf(remove_annotation(data, 1), value)


def test_verifier_rejects_changed_code_whitespace():
    value = request(
        "<pre><code>    value  =  1\n  next = 2</code></pre>", "value = 1 next = 2"
    )
    render_in_process(value)
    changed = request(
        "<pre><code>value = 1\nnext = 2</code></pre>", "value = 1 next = 2"
    )
    data = base64.b64decode(render_in_process(changed)["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="code-whitespace-semantics"):
        tool.verify_pdf(data, value)


@pytest.mark.parametrize(
    "mode,image_format", [("RGBA", "PNG"), ("RGB", "JPEG"), ("RGBA", "WEBP")]
)
def test_frozen_image_pixels_alpha_and_repeated_placements_are_verified(
    mode, image_format
):
    image = image_fragment(mode, image_format)
    value = request(f"<p>Hello PDF</p>{image}{image}")
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pymupdf.open(stream=data) as pdf:
        assert len(pdf[0].get_image_info()) == 2
    assert tool.verify_pdf(data, value)["pageCount"] == 1


def test_wrapped_and_repeated_external_links_are_all_verified():
    target = "https://example.org/"
    label = "Wrapped link words " * 40
    value = request(
        f"<p><a href='{target}'>{label}</a></p><p><a href='{target}'>Again</a></p>",
        label + "Again",
        [target],
    )
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pymupdf.open(stream=data) as pdf:
        assert len(pdf[0].get_links()) > 2
    assert tool.verify_pdf(data, value)["pageCount"] == 1


@pytest.mark.parametrize(
    "code", ["  a  b\n    c\td  ", "identifier ffi fi ligatures", "  مرحبا  عالم"]
)
def test_code_whitespace_tabs_and_logical_ligatures_are_preserved(code):
    value = request(f"<pre>{code}</pre>", code)
    result = render_in_process(value)
    assert (
        tool.verify_pdf(base64.b64decode(result["pdfBase64"]), value)["pageCount"] == 1
    )


@pytest.mark.parametrize(
    "locale,text", [("fa-IR", "سلام جهان"), ("ur-PK", "السلام علیکم")]
)
def test_rtl_document_keeps_program_code_indentation(locale, text):
    value = request(f"<p>{text}</p><pre>  a  b\n    c\td  </pre>", text + "a b c d")
    value["htmlDocument"] = value["htmlDocument"].replace(
        "<html>", f'<html lang="{locale}" dir="rtl">'
    )
    data = base64.b64decode(render_in_process(value)["pdfBase64"])
    with pymupdf.open(stream=data) as pdf:
        assert "  a  b\n" in pdf[0].get_text()
    assert tool.verify_pdf(data, value)["pageCount"] == 1


def test_rtl_ligature_order_cannot_hide_letter_substitution():
    value = request("<p dir='rtl'>سلام</p>", "سلام")
    render_in_process(value)
    substituted = request("<p dir='rtl'>سالم</p>", "سالم")
    data = base64.b64decode(render_in_process(substituted)["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="text-order-or-content"):
        tool.verify_pdf(data, value)


@pytest.mark.parametrize(
    "text,direction",
    [
        ("سلام PDF", "rtl"),
        ("سلام 123", "rtl"),
        ("سلام PDF 123 مرحبا", "rtl"),
        ("PDF سلام 123", "ltr"),
    ],
)
def test_rtl_latin_and_digits_preserve_native_logical_cluster_order(text, direction):
    value = request(f"<p dir='{direction}'>{text}</p>", text)
    result = render_in_process(value)
    assert (
        tool.verify_pdf(base64.b64decode(result["pdfBase64"]), value)["pageCount"] == 1
    )


def test_rtl_mixed_inline_fonts_preserve_logical_order():
    value = request("<p dir='rtl'>سلام <strong>PDF</strong> 123</p>", "سلام PDF 123")
    result = render_in_process(value)
    assert (
        tool.verify_pdf(base64.b64decode(result["pdfBase64"]), value)["pageCount"] == 1
    )


def test_rtl_mixed_order_rejects_changed_digits_without_replacing_source_letters():
    value = request("<p dir='rtl'>سلام 123</p>", "سلام 123")
    render_in_process(value)
    changed = request("<p dir='rtl'>سلام 321</p>", "سلام 321")
    data = base64.b64decode(render_in_process(changed)["pdfBase64"])
    with pytest.raises(tool.PdfRejected, match="text-order-or-content"):
        tool.verify_pdf(data, value)


def test_table_footer_before_body_is_explicitly_rejected():
    fragment = (
        "<table><thead><tr><th>A</th><th>B</th></tr></thead>"
        "<tfoot><tr><td>C</td><td>D</td></tr></tfoot>"
        "<tbody><tr><td>Row</td><td>Value</td></tr></tbody></table>"
    )
    value = request(fragment, "ABCDRowValue")
    with pytest.raises(tool.PdfRejected, match="unsupported-table-footer-order"):
        tool.validate_request(value)
    with pytest.raises(tool.PdfRejected, match="unsupported-table-footer-order"):
        render_in_process(value)


def test_table_footer_after_body_is_preserved():
    fragment = (
        "<table><thead><tr><th>A</th><th>B</th></tr></thead>"
        "<tbody><tr><td>Row</td><td>Value</td></tr></tbody>"
        "<tfoot><tr><td>C</td><td>D</td></tr></tfoot></table>"
    )
    assert render_in_process(request(fragment, "ABRowValueCD"))["pageCount"] == 1
