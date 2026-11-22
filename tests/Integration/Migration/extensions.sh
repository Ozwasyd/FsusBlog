#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
    printf 'Usage: %s /absolute/path/FsusBlog.V2.Cli.dll\n' "$0" >&2
    exit 2
fi
project="$1"
scratch="$(mktemp -d)"
scratch="$(cd "$scratch" && pwd -P)"
trap 'rm -rf -- "$scratch"' EXIT
umask 077
mkdir "$scratch"/{store,operator}
export FSUSBLOG_EXTENSION_ROOT="$scratch/store"
export FSUSBLOG_EXTENSION_STORE_ID="df6327b8-e175-46dd-82ab-3c110a2fae78"
export FSUSBLOG_EXTENSION_MAC_KEY_FILE="$scratch/operator/key"
unset FSUSBLOG_DB
openssl rand -out "$FSUSBLOG_EXTENSION_MAC_KEY_FILE" 32
chmod 400 "$FSUSBLOG_EXTENSION_MAC_KEY_FILE"
openssl ecparam -name prime256v1 -genkey -noout -out "$scratch/publisher.key"
openssl pkey -in "$scratch/publisher.key" -pubout -outform DER -out "$scratch/publisher.spki"

python3 - "$scratch" <<'PY'
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile
import json, struct, sys

base = Path(sys.argv[1]); name = b"bin/worker.wasm"; module = b"\x00asm\x01\x00\x00\x00"
def frame(value):
    return struct.pack(">I", len(value)) + value
def digest(value):
    return sha256(value).hexdigest()

manifest = dict(SchemaVersion=1, RegistryVersion=1, Id="fixture.extension", Version="1.0",
    Publisher="fixture.publisher", SignatureReference="signature/first", TrustPolicyReference="trust/policy",
    PackageSha256=digest(b"fsusblog.authoring-package.payload.v1\0" + frame(name) + frame(module)),
    ContentSha256=digest(frame(name) + sha256(module).digest()), HostApi=dict(Minimum=1, Maximum=1),
    SupportedPlatforms=[2], Contributions=[dict(Id="fixture.read", Kind=1, ExecutionClass=1, Capabilities=[0],
        Entrypoint=dict(Format=1, PathOrAdapterId=name.decode(), ContentSha256=digest(module)))],
    Limits=dict(MaximumCpuTime="00:00:01", WallClock="00:00:10", MemoryBytes=4096, MaximumRequestBytes=1024,
        MaximumResponseBytes=1024, MaximumConcurrentCalls=1, MaximumQueueDepth=8, MaximumObjectDepth=4,
        MaximumRestarts=0, MaximumNetworkBytes=0, MaximumFileBytes=0, MaximumStateBytes=0),
    StateSchemaVersion=1, DataSchemaVersion=1, UpdatePolicy=0, MigrationPolicy=0, UninstallPolicy=0,
    AllowExecutionFallback=False)
with ZipFile(base / "package.zip", "w") as package:
    package.writestr("manifest.json", json.dumps(manifest))
    package.writestr(name.decode(), module)

now = datetime.now(timezone.utc)
trust = dict(keys=[dict(publisher="fixture.publisher", keyId="first", subjectPublicKeyInfo=list((base / "publisher.spki").read_bytes()),
    validFrom=(now-timedelta(hours=1)).isoformat(), validUntil=(now+timedelta(hours=1)).isoformat())], sources=[dict(
    reference="approved-source/fixture", provenance="provenance/fixture", publisher="fixture.publisher", keyId="first",
    archiveSha256=digest((base / "package.zip").read_bytes()), signatureReference="signature/first", trustPolicyReference="trust/policy")])
path = base / "operator/trust.json"
path.write_text(json.dumps(trust))
path.chmod(0o400)
PY

openssl dgst -sha256 -sign "$scratch/publisher.key" -out "$scratch/signature.der" "$scratch/package.zip"
python3 -B - "$scratch" "$(dirname -- "${BASH_SOURCE[0]}")/../../../tools" <<'PY'
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[2])
from fixture_signing import fixture_signature

base = Path(sys.argv[1])
(base / "signature.raw").write_bytes(fixture_signature((base / "signature.der").read_bytes()))
PY

extension() { dotnet "$project" extension "$@"; }
checkpoint() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(str(d["sequence"])+":"+d["digest"])'; }
deny() {
    local expected="$1"; shift
    if extension "$@" >"$scratch/deny.out" 2>"$scratch/deny.err"; then
        printf 'Unexpected success for %s\n' "$*" >&2
        exit 1
    fi
    test ! -s "$scratch/deny.out"
    test "$(cat "$scratch/deny.err")" = "$expected"
}
activate() { extension activate "$1" approved-source/fixture "$scratch/package.zip" "$scratch/signature.raw"; }

deny extension-local-file-unavailable status
test -z "$(ls -A "$scratch/store")"
first="$(extension init "$scratch/operator/trust.json" | checkpoint)"
mkfifo "$scratch/archive.fifo"
deny extension-input-size activate "$first" approved-source/fixture "$scratch/archive.fifo" "$scratch/signature.raw"
active="$(activate "$first" | checkpoint)"
deny activation-checkpoint-mismatch quarantine "$first" fixture.extension manual-check

installed_archive="$(find "$scratch/store" -name '*.zip' -type f)"
cp "$scratch/package.zip" "$scratch/tampered"
printf 'changed' >> "$scratch/tampered"
chmod 400 "$scratch/tampered"
mv -f "$scratch/tampered" "$installed_archive"
extension status | python3 -c 'import json,sys; p=json.load(sys.stdin)["installations"][0]; assert p["state"]=="active-blocked" and p["verificationIssue"]=="archive-digest"'
quarantine="$(extension quarantine "$active" fixture.extension manual-check | checkpoint)"
read -r receipt < <(extension status | python3 -c 'import json,sys; p=json.load(sys.stdin)["installations"][0]; assert p["state"]=="quarantined"; print(p["quarantine"]["receipt"])')
deny extension-quarantined activate "$quarantine" approved-source/fixture "$scratch/package.zip" "$scratch/signature.raw"
approval="b7d37cc3-fa19-419d-a674-778ec588a3ba"
deny quarantine-approval release "$quarantine" fixture.extension "$approval" "$approval"
released="$(extension release "$quarantine" fixture.extension "$receipt" "$approval" | checkpoint)"
extension status | python3 -c 'import json,sys; p=json.load(sys.stdin)["installations"][0]; assert p["state"]=="inactive" and p["quarantine"]["releasedAt"]'
deny installed-file-size activate "$released" approved-source/fixture "$scratch/package.zip" "$scratch/signature.raw"
printf 'Verified CLI trust, activation, read-only failure reporting, and quarantine/release across processes.\n'
