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


def build(root, font, license_text):
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
        for kind, manifest, members in [
            ('theme', dict(Theme=dict(LightAccent='#225533', LightHover='#447733', DarkAccent='#99eeaa', DarkHover='#cceedd')), {}),
            ('font', dict(Font=dict(License='OFL-1.1', FontSha256=digest(font), LicenseSha256=digest(license_text))),
             {'font.woff2': font, 'LICENSE.txt': license_text}),
        ]:
            reference = f'approved-source/{kind}'
            manifest.update(Format=1, Id=f'fixture.{kind}', Version='1.0', Kind=kind, Publisher='test.publisher',
                            SignatureReference='signature/one', TrustPolicyReference='trust/release')
            path = temp / f'{kind}.zip'
            with ZipFile(path, 'w') as archive:
                archive.writestr('manifest.json', json.dumps(manifest))
                for name, contents in members.items():
                    archive.writestr(name, contents)
            contents = path.read_bytes()
            signed = p1363(subprocess.check_output(['openssl', 'dgst', '-sha256', '-sign', str(private_key), str(path)]))
            archive_sha = digest(contents)
            signature_sha = digest(signed)
            store(root, archive_sha + '.zip', contents)
            store(root, signature_sha + '.signature', signed)
            sources.append(dict(Reference=reference, Provenance=f'provenance/{kind}', Publisher='test.publisher', KeyId='first',
                                ArchiveSha256=archive_sha, SignatureReference='signature/one', TrustPolicyReference='trust/release'))
            packages.append(dict(Source=reference, ArchiveSha256=archive_sha, SignatureSha256=signature_sha))
        keys = [dict(Publisher='test.publisher', KeyId='first', SubjectPublicKeyInfo=list(spki),
                     ValidFrom=(now - timedelta(hours=1)).isoformat(), ValidUntil=(now + timedelta(hours=1)).isoformat(),
                     RevokedAt=expiry.isoformat())]
        store(root, 'appearance.json', json.dumps(dict(Keys=keys, Sources=sources, Packages=packages,
                                                       ActiveTheme='fixture.theme', ActiveFont='fixture.font')).encode())
    return expiry.isoformat()


if __name__ == '__main__':
    target, font, license_file = map(Path, sys.argv[1:])
    print(build(target, font.read_bytes(), license_file.read_bytes()))
