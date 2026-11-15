import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def fixture():
    # Exact expanded entries from Minimal Ink in pinned v1 ThemeInfrastructureTests.CreatePackage.
    name = "fsusblog.theme.minimal-ink"
    manifest = b'''{
    "id": "fsusblog.theme.minimal-ink",
    "name": "Minimal Ink",
    "version": "1.0.0",
    "fsusblog": ">=1.3.0 <1.4.0",
    "author": "example",
    "description": "A reading theme",
    "type": "theme",
    "entry": {
        "tokens": "styles/tokens.css",
        "theme": "styles/theme.css"
    },
    "modes": ["light", "dark"],
    "supports": {
        "public": true,
        "admin": false,
        "console": false,
        "highContrast": true,
        "reducedMotion": true,
        "rtl": false
    },
    "assets": {
        "preview": "assets/preview.png"
    },
    "configSchema": "config/schema.json",
    "permissions": {
        "script": false,
        "network": false,
        "filesystem": false
    },
    "budgets": {
        "cssBytes": 65536,
        "assetBytes": 524288,
        "maxSelectors": 512,
        "maxSelectorDepth": 4,
        "maxImportant": 8,
        "maxMotionDurationMs": 1000,
        "previewBytes": 262144
    }
}'''
    return {
        "manifest.json": manifest,
        "styles/tokens.css": f':root[data-theme="{name}"] {{ --fsus-color-page-bg: #fff; }}'.encode(),
        "styles/theme.css": f'[data-theme="{name}"] .fsus-theme-scope {{ background: var(--fsus-color-page-bg); }}'.encode(),
        "assets/preview.png": bytes.fromhex("89504e47"),
        "config/schema.json": b'{"type":"object","additionalProperties":false,"properties":{"fontScale":{"type":"number"},"showAuthor":{"type":"boolean"}}}',
    }


def archive(entries, linked=None, extra=None):
    data = io.BytesIO()
    with ZipFile(data, "w", compression=ZIP_DEFLATED) as zip:
        for key, value in entries.items():
            entry = ZipInfo(key)
            entry.external_attr = (0o120777 if key == linked else 0o100644) << 16
            zip.writestr(entry, value, compress_type=ZIP_DEFLATED)
        if extra:
            zip.writestr(*extra)
    return data.getvalue()


def sign(key, path):
    der = subprocess.check_output(["openssl", "dgst", "-sha256", "-sign", str(key), str(path)])
    assert der[0] == 0x30 and der[1] == len(der) - 2
    offset = 2
    parts = []
    for _ in range(2):
        assert der[offset] == 2
        width = der[offset + 1]
        offset += 2
        parts.append(int.from_bytes(der[offset:offset + width], "big").to_bytes(32, "big"))
        offset += width
    assert offset == len(der)
    return b"".join(parts)


def main(dll):
    source = "approved-source/minimal-ink"
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary).resolve()
        operator = root / "operator"
        operator.mkdir(mode=0o700)
        private_key = operator / "publisher.key"
        subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(private_key)], check=True)
        spki = subprocess.check_output(["openssl", "pkey", "-in", str(private_key), "-pubout", "-outform", "DER"])
        trust_path = operator / "trust.json"
        archive_path = root / "minimal-ink.fstheme"
        signature_path = root / "signature.raw"
        nonce = datetime.now(timezone.utc)
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"FSUSBLOG_DB", "FSUSBLOG_EXTENSION_ROOT", "FSUSBLOG_EXTENSION_STORE_ID", "FSUSBLOG_EXTENSION_MAC_KEY_FILE"}}

        def prepare(data, revoked=False):
            archive_path.write_bytes(data)
            signature_path.write_bytes(sign(private_key, archive_path))
            keys = [{"publisher": "fixture.publisher", "keyId": "first", "subjectPublicKeyInfo": list(spki),
                     "validFrom": (nonce - timedelta(hours=1)).isoformat(), "validUntil": (nonce + timedelta(hours=1)).isoformat()}]
            if revoked:
                keys[0]["revokedAt"] = nonce.isoformat()
            trusted = {"keys": keys, "sources": [{"reference": source, "provenance": "provenance/minimal-ink",
                       "publisher": "fixture.publisher", "keyId": "first", "archiveSha256": digest(data),
                       "signatureReference": "signature/first", "trustPolicyReference": "trust/policy"}]}
            trust_path.unlink(missing_ok=True)
            trust_path.write_bytes(encoded(trusted))
            trust_path.chmod(0o400)

        def inspect(code=None, selected_source=source):
            result = subprocess.run(["dotnet", dll, "extension", "inspect-fstheme", str(trust_path),
                                     selected_source, str(archive_path), str(signature_path)], env=environment,
                                    capture_output=True, text=True, timeout=10)
            if code:
                assert (result.returncode, result.stdout, result.stderr.strip()) == (1, "", code), result
                return
            assert result.returncode == 0 and not result.stderr, result
            assert str(root) not in result.stdout
            return json.loads(result.stdout)

        entries = fixture()
        good = archive(entries)
        prepare(good)
        before = {item.relative_to(root): digest(item.read_bytes()) for item in root.rglob("*") if item.is_file()}
        report = inspect()
        assert report["state"] == "inspection-only" and report["id"] == "fsusblog.theme.minimal-ink"
        assert report["schema"] == "fsusblog.fstheme.v1.structural.v1"
        assert report["archiveSha256"] == digest(good) and report["publisher"] == "fixture.publisher"
        assert report["modes"] == ["light", "dark"] and report["supports"]["highContrast"]
        assert report["preview"] == {"path": "assets/preview.png", "bytes": 4, "sha256": digest(entries["assets/preview.png"])}
        assert report["stylePaths"] == ["styles/theme.css", "styles/tokens.css"]
        assert report["entries"] == [{"path": path, "bytes": len(content), "sha256": digest(content)}
                                     for path, content in sorted(entries.items())]
        assert report["configuration"] == [{"name": "fontScale", "type": "number", "required": False},
                                            {"name": "showAuthor", "type": "boolean", "required": False}]
        assert {item.relative_to(root): digest(item.read_bytes()) for item in root.rglob("*") if item.is_file()} == before
        assert {item.relative_to(root) for item in root.rglob("*") if item.is_dir()} == {Path("operator")}

        inspect("source-not-approved", "approved-source/other")
        archive_path.write_bytes(good + b"tampered")
        inspect("archive-digest")
        archive_path.write_bytes(good)
        signature = signature_path.read_bytes()
        signature_path.write_bytes(bytes([signature[0] ^ 1]) + signature[1:])
        inspect("archive-signature")
        prepare(good, revoked=True)
        inspect("publisher-key-not-current")

        manifest = json.loads(entries["manifest.json"])
        manifest["permissions"]["network"] = True
        unknown_config = b'{"type":"object","additionalProperties":false,"properties":{},"required":["missing"]}'
        oversized = b"x" * (8 * 1024 * 1024)
        wrong_crc = bytearray(good)
        wrong_crc[wrong_crc.index(b"PK\x01\x02") + 16] ^= 1
        for corrupt, code in [
            (archive(entries, linked="assets/preview.png"), "fstheme-entry-shape"),
            (archive(entries, extra=("Manifest.json", b"{}")), "fstheme-entry-shape"),
            (archive(entries, extra=("../outside", b"{}")), "fstheme-entry-shape"),
            (bytes(wrong_crc), "fstheme-entry-crc"),
            (archive({**entries, "manifest.json": entries["manifest.json"].replace(b'"type": "theme"', b'"type": "theme", "type": "theme"')}),
             "fstheme-manifest"),
            (archive(entries, extra=("extra/decompressed", oversized)), "fstheme-expanded-size"),
            (archive({**entries, "manifest.json": encoded(manifest)}), "fstheme-permission"),
            (archive({**entries, "config/schema.json": unknown_config}), "fstheme-config"),
            (archive({**entries, "styles/tokens.css": b"\xff"}), "fstheme-css-encoding"),
            (archive({**entries, "assets/preview.png": b"x" * 262145}), "fstheme-budget"),
        ]:
            prepare(corrupt)
            inspect(code)
        print("Verified pinned v1 Minimal Ink structure and hashes, trusted signature, and read-only rejection cases.")


if __name__ == "__main__":
    main(os.path.abspath(sys.argv[1]))
