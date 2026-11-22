#!/usr/bin/env python3
from base64 import b64decode
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from fixture_signing import AppearancePackages, digest


def store(root, name, data):
    path = root / name
    with path.open('xb') as output:
        output.write(data)
    path.chmod(0o400)


def build(root, font, license_text, online=False, legacy_font=False, legacy_theme=False):
    root.mkdir(mode=0o700)
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(seconds=20)
    with TemporaryDirectory() as private:
        temp = Path(private)
        private_key = temp / 'publisher.pem'
        packages = AppearancePackages(private_key, 'test.publisher', 'first', 'signature/one', 'trust/release',
                                      lambda name, data: store(root, name, data))
        choices = [
            ('theme', 'theme', dict(Theme=dict(LightAccent='#225533', LightHover='#447733', DarkAccent='#99eeaa', DarkHover='#cceedd')), {}),
            ('font', 'font', dict(Font=dict(License='OFL-1.1', FontSha256=digest(font), LicenseSha256=digest(license_text))),
             {'font.woff2': font, 'LICENSE.txt': license_text}),
        ]
        if online:
            choices.append(('alternate', 'theme', dict(Theme=dict(LightAccent='#663322', LightHover='#774433',
                DarkAccent='#eecc99', DarkHover='#ffddcc')), {}))
        active_font = 'fsusblog.font.fixture' if legacy_font else 'fixture.font'
        for package_id, kind, manifest, members in choices:
            is_v1_theme = legacy_theme and package_id == 'alternate'
            manifest.update(Format=1, Id=f'fixture.{package_id}', Version='1.0', Kind=kind, Publisher='test.publisher',
                            SignatureReference='signature/one', TrustPolicyReference='trust/release')
            if legacy_font and kind == 'font':
                source = dict(kind='npm-fontsource', package='@fontsource/google-sans', version='5.2.1', upstream='Google Fonts')
                manifest = dict(id=active_font, name='Fixture Sans', version='1.0.0', fsusblog='>=1.3.0 <1.4.0',
                                type='font', family='Fixture Sans', category='ui-sans', scripts=[], locales=[],
                                faces=[dict(weight=400, style='normal', file='fonts/body-regular.woff2', contentHash=digest(font),
                                            unicodeRange='U+0000-00FF', critical=False)],
                                license=dict(name='OFL-1.1', file='license/LICENSE.txt', source='license/source.json'),
                                source=source, budgets=dict(criticalBytes=0, totalBytes=1_048_576, maxFaces=1),
                                loading=dict(display='swap', preload=[], defer=[]))
                members = {'fonts/': b'', 'license/': b'', 'fonts/body-regular.woff2': font,
                           'license/LICENSE.txt': license_text, 'license/source.json': json.dumps(source)}
            if is_v1_theme:
                identifier = 'fsusblog.theme.fixture'
                manifest = dict(id=identifier, name='Fixture accents', version='1.0.0', fsusblog='>=1.3.0 <1.4.0',
                                author='Fixture publisher', description='Two-mode accents', type='theme',
                                entry=dict(tokens='styles/tokens.css', theme='styles/theme.css'), modes=['light', 'dark'],
                                supports=dict(public=True, admin=False, console=False, highContrast=False, reducedMotion=False, rtl=False),
                                assets=dict(preview='assets/preview.png'), configSchema='config/schema.json',
                                permissions=dict(script=False, network=False, filesystem=False),
                                budgets=dict(cssBytes=65536, assetBytes=524288, maxSelectors=512, maxSelectorDepth=4,
                                             maxImportant=8, maxMotionDurationMs=1000, previewBytes=262144))
                members = {
                    'styles/tokens.css': (
                        f':root[data-theme="{identifier}"] {{ --fsus-color-action-primary: #663322; --fsus-color-action-primary-hover: #774433; }}\n'
                        f':root[data-theme="{identifier}"][data-color-scheme="dark"] '
                        '{ --fsus-color-action-primary: #eecc99; --fsus-color-action-primary-hover: #ffddcc; }\n'),
                    'styles/theme.css': '\n',
                    'assets/preview.png': b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg=='),
                    'config/schema.json': '{"type":"object","additionalProperties":false,"properties":{}}',
                }
            is_v1_font = legacy_font and kind == 'font'
            suffix = '.fstheme' if is_v1_theme else '.fsfont' if is_v1_font else '.zip'
            package_format = 'fstheme-v1-palette' if is_v1_theme else 'fsfont-v1' if is_v1_font else None
            packages.add(package_id, manifest, members, suffix, package_format)
        packages.finish(now - timedelta(hours=1), now + timedelta(hours=1), None if online else expiry.isoformat(),
                        'fixture.theme', active_font)
    return expiry.isoformat()


if __name__ == '__main__':
    target, font, license_file = map(Path, sys.argv[1:4])
    print(build(target, font.read_bytes(), license_file.read_bytes(), online='online' in sys.argv[4:],
                legacy_font='fsfont-v1' in sys.argv[4:], legacy_theme='fstheme-v1-palette' in sys.argv[4:]))
