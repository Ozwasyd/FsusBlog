#!/usr/bin/env python3
from hashlib import sha256
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import json
import subprocess
import sys


def digest(content):
    return sha256(content).hexdigest()


def store(root, name, data):
    path = root / name
    with path.open('xb') as output:
        output.write(data)
    path.chmod(0o400)


def p1363(der):
    if der[0] != 0x30 or der[1] != len(der) - 2:
        raise ValueError('Unexpected P-256 DER signature')
    offset = 2
    output = []
    for _ in range(2):
        if der[offset] != 2:
            raise ValueError('Expected DER integer')
        width = der[offset + 1]
        start = offset + 2
        offset = start + width
        output.append(int.from_bytes(der[start:offset], 'big').to_bytes(32, 'big'))
    if offset != len(der):
        raise ValueError('Unexpected P-256 DER signature tail')
    return b''.join(output)


def build(root, font, license_text, online=False, legacy_font=False):
    root.mkdir(mode=0o700)
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(seconds=20)
    with TemporaryDirectory() as private:
        temp = Path(private)
        private_key = temp / 'publisher.pem'
        subprocess.run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', str(private_key)], check=True)
        spki = subprocess.check_output(['openssl', 'pkey', '-in', str(private_key), '-pubout', '-outform', 'DER'])
        packages = []
        sources = []
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
            reference = f'approved-source/{package_id}'
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
            path = temp / f'{package_id}.zip'
            with ZipFile(path, 'w') as archive:
                archive.writestr('manifest.json', json.dumps(manifest))
                for member, contents in members.items():
                    archive.writestr(member, contents)
            contents = path.read_bytes()
            signed = p1363(subprocess.check_output(['openssl', 'dgst', '-sha256', '-sign', str(private_key), str(path)]))
            archive_sha = digest(contents)
            signature_sha = digest(signed)
            is_v1_font = legacy_font and kind == 'font'
            store(root, archive_sha + ('.fsfont' if is_v1_font else '.zip'), contents)
            store(root, signature_sha + '.signature', signed)
            sources.append(dict(Reference=reference, Provenance=f'provenance/{package_id}', Publisher='test.publisher', KeyId='first',
                                ArchiveSha256=archive_sha, SignatureReference='signature/one', TrustPolicyReference='trust/release'))
            descriptor = dict(Source=reference, ArchiveSha256=archive_sha, SignatureSha256=signature_sha)
            if is_v1_font:
                descriptor['Format'] = 'fsfont-v1'
            packages.append(descriptor)
        keys = [dict(Publisher='test.publisher', KeyId='first', SubjectPublicKeyInfo=list(spki),
                     ValidFrom=(now - timedelta(hours=1)).isoformat(), ValidUntil=(now + timedelta(hours=1)).isoformat(),
                     RevokedAt=None if online else expiry.isoformat())]
        store(root, 'appearance.json', json.dumps(dict(Keys=keys, Sources=sources, Packages=packages,
                                                       ActiveTheme='fixture.theme', ActiveFont=active_font)).encode())
    return expiry.isoformat()


if __name__ == '__main__':
    target, font, license_file = map(Path, sys.argv[1:4])
    print(build(target, font.read_bytes(), license_file.read_bytes(), online='online' in sys.argv[4:],
                legacy_font='fsfont-v1' in sys.argv[4:]))
