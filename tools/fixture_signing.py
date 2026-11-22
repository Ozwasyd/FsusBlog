"""Create signed fixture packages for development and integration tests."""
from hashlib import sha256
import json
import subprocess
from zipfile import ZipFile


def digest(content):
    return sha256(content).hexdigest()


def generate_key(path):
    subprocess.run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', str(path)], check=True)
    return subprocess.check_output(['openssl', 'pkey', '-in', str(path), '-pubout', '-outform', 'DER'])


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def p1363(der, *, allow_tail=False, require=_require):
    require(der[0] == 0x30 and der[1] == len(der) - 2, 'Unexpected P-256 DER signature')
    offset = 2
    scalars = []
    for _ in range(2):
        require(der[offset] == 2, 'Expected DER integer')
        width = der[offset + 1]
        start = offset + 2
        offset = start + width
        scalars.append(int.from_bytes(der[start:offset], 'big').to_bytes(32, 'big'))
    if not allow_tail:
        require(offset == len(der), 'Unexpected P-256 DER signature tail')
    return b''.join(scalars)


def _assert_der(condition, message):
    assert condition


def fixture_signature(der):
    return p1363(der, require=_assert_der)


class AppearancePackages:
    def __init__(self, key, publisher, key_id, signature_reference, trust_reference, store, *, allow_tail=False):
        self.key = key
        self.spki = generate_key(key)
        self.authority = dict(Publisher=publisher, KeyId=key_id)
        self.references = dict(SignatureReference=signature_reference, TrustPolicyReference=trust_reference)
        self.store = store
        self.allow_tail = allow_tail
        self.sources = []
        self.packages = []

    def add(self, slug, manifest, members, suffix='.zip', package_format=None):
        path = self.key.parent / (slug + '.zip')
        with ZipFile(path, 'w') as archive:
            archive.writestr('manifest.json', json.dumps(manifest))
            for name, contents in members.items():
                archive.writestr(name, contents)
        contents = path.read_bytes()
        der = subprocess.check_output(['openssl', 'dgst', '-sha256', '-sign', str(self.key), str(path)])
        signed = p1363(der, allow_tail=self.allow_tail)
        archive_sha, signature_sha = digest(contents), digest(signed)
        self.store(archive_sha + suffix, contents)
        self.store(signature_sha + '.signature', signed)
        reference = 'approved-source/' + slug
        self.sources.append(dict(Reference=reference, Provenance='provenance/' + slug, **self.authority,
                                 ArchiveSha256=archive_sha, **self.references))
        package = dict(Source=reference, ArchiveSha256=archive_sha, SignatureSha256=signature_sha)
        if package_format is not None:
            package['Format'] = package_format
        self.packages.append(package)

    def finish(self, valid_from, valid_until, revoked, theme, font, indent=None):
        key = dict(**self.authority, SubjectPublicKeyInfo=list(self.spki), ValidFrom=valid_from.isoformat(),
                   ValidUntil=valid_until.isoformat(), RevokedAt=revoked)
        registry = dict(Keys=[key], Sources=self.sources, Packages=self.packages, ActiveTheme=theme, ActiveFont=font)
        self.store('appearance.json', json.dumps(registry, indent=indent).encode())
