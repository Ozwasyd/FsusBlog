import errno
import hashlib
from html.parser import HTMLParser
import os
from pathlib import Path
import resource
import socket
import sys
from xml.etree import ElementTree


MAX_INPUT = 384 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_PAGES = 48
MAX_FONT = 32 * 1024 * 1024
FONT_FAMILY = 'Noto Sans CJK SC'
STYLESHEET = '''
@page {
    size: A4;
    margin: 20mm 18mm;
    @bottom-center { content: counter(page); font: 9pt "Noto Sans CJK SC"; }
}
body { font: 11pt/1.55 "Noto Sans CJK SC"; color: #1c2330; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; line-height: 1.3; }
h1 { font-size: 21pt; }
p, li, blockquote { orphans: 2; widows: 2; overflow-wrap: break-word; }
blockquote { border-left: 2pt solid #adb5bf; margin: 0; padding: 0 0 0 12pt; }
code, pre { font: 10pt/1.45 "Noto Sans CJK SC"; }
pre { white-space: pre-wrap; overflow-wrap: break-word; background: #eef1f4; padding: 6pt; }
'''


class InputRejected(Exception):
    pass


def require_denied(attempt):
    try:
        with attempt():
            pass
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM):
            return
        raise
    raise RuntimeError('sandbox probe was allowed')


def connect_loopback():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
        stream.settimeout(1)
        stream.connect(('127.0.0.1', 9))


def load_font(font_source, expected_font_digest, scratch):
    font_dir = scratch / 'fonts'
    font_dir.mkdir()
    with open(font_source, 'rb') as stream:
        data = stream.read(MAX_FONT + 1)
    if len(data) > MAX_FONT or hashlib.sha256(data).hexdigest() != expected_font_digest:
        raise RuntimeError('font verification failed')
    font = font_dir / 'NotoSansCJKsc-Regular.otf'
    font.write_bytes(data)

    config = ElementTree.Element('fontconfig')
    ElementTree.SubElement(config, 'dir').text = str(font_dir)
    ElementTree.SubElement(config, 'cachedir').text = str(scratch / 'fontcache')
    config_file = scratch / 'fonts.conf'
    ElementTree.ElementTree(config).write(config_file, encoding='utf-8', xml_declaration=True)
    os.environ['FONTCONFIG_FILE'] = str(config_file)
    return font


class FontCoverage(HTMLParser):
    def __init__(self, codepoints):
        super().__init__(convert_charrefs=True)
        self.codepoints = codepoints

    def handle_data(self, text):
        if any(not character.isspace() and ord(character) not in self.codepoints for character in text):
            raise InputRejected('pdf-glyphs')


def render(payload, font):
    from fontTools.ttLib import TTFont
    from weasyprint import CSS, HTML, __version__
    from weasyprint.text.fonts import FontConfiguration

    if __version__ != '66.0':
        raise RuntimeError('renderer verification failed')
    html = payload.decode('utf-8', errors='strict')
    with TTFont(font, lazy=True) as selected:
        if selected['name'].getBestFamilyName() != FONT_FAMILY:
            raise RuntimeError('font family verification failed')
        coverage = FontCoverage(selected.getBestCmap())
        coverage.feed(html)
        coverage.close()

    fetched = False

    def deny_resource(*args, **kwargs):
        nonlocal fetched
        fetched = True
        raise ValueError('resource denied')

    font_config = FontConfiguration()
    stylesheet = CSS(string=STYLESHEET, font_config=font_config, url_fetcher=deny_resource)
    document = HTML(string=html, url_fetcher=deny_resource).render(stylesheets=[stylesheet], font_config=font_config)
    if not 1 <= len(document.pages) <= MAX_PAGES:
        raise InputRejected('pdf-budget')
    result = document.write_pdf()
    if fetched:
        raise InputRejected('pdf-resources')
    if len(result) > MAX_OUTPUT:
        raise InputRejected('pdf-budget')
    if not result.startswith(b'%PDF-') or not result.rstrip().endswith(b'%%EOF'):
        raise RuntimeError('renderer output invalid')
    return result


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024,) * 2)
    require_denied(connect_loopback)
    require_denied(lambda: open('/private/etc/hosts', 'rb'))
    font = load_font(sys.argv[1], sys.argv[2], Path(sys.argv[3]))

    sys.stdout.buffer.write(b'FSUS-PDF-1\n')
    sys.stdout.buffer.flush()
    payload = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not payload or len(payload) > MAX_INPUT:
        raise InputRejected('pdf-budget')
    sys.stdout.buffer.write(render(payload, font))


if __name__ == '__main__':
    try:
        main()
    except InputRejected as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception:
        print('pdf-tool-failure', file=sys.stderr)
        sys.exit(1)
