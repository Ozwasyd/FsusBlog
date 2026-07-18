#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p \
    "$TMP_DIR/fake-bin" \
    "$TMP_DIR/data/keyring" \
    "$TMP_DIR/web/uploads" \
    "$TMP_DIR/web/aot-cache" \
    "$TMP_DIR/web/search" \
    "$TMP_DIR/backups"

node --input-type=module - "$TMP_DIR/identity.pem" "$TMP_DIR/recipient.pem" "$TMP_DIR/wrong-identity.pem" "$TMP_DIR/wrong-recipient.pem" <<'NODE'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
for (let index = 0; index < 2; index += 1) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  writeFileSync(process.argv[2 + index * 2], privateKey, { mode: 0o600 })
  writeFileSync(process.argv[3 + index * 2], publicKey, { mode: 0o600 })
}
NODE

printf '%s\n' '<key id="old"><descriptor><encryptedSecret><EncryptedData>old-generation</EncryptedData></encryptedSecret></descriptor></key>' \
    >"$TMP_DIR/data/keyring/key-old.xml"
printf '%s\n' '<key id="current"><descriptor><encryptedSecret><EncryptedData>current-generation</EncryptedData></encryptedSecret></descriptor></key>' \
    >"$TMP_DIR/data/keyring/key-current.xml"
printf '%s\n' 'upload-payload' >"$TMP_DIR/web/uploads/example.txt"
printf '%s\n' 'aot-payload' >"$TMP_DIR/web/aot-cache/example.html"
printf '%s\n' 'search-payload' >"$TMP_DIR/web/search/index.manifest.aeds"
printf '%s\n' '{"Jwt":{"SecretKey":"fixture-secret"},"Public":{"Value":"safe"}}' >"$TMP_DIR/appsettings.fixture.json"

cat >"$TMP_DIR/fake-bin/pg_dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    --file=*) printf '%s\n' 'database-plaintext-marker' > "${argument#--file=}" ;;
  esac
done
SH
cat >"$TMP_DIR/fake-bin/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test -r "${@: -1}"
SH
chmod +x "$TMP_DIR/fake-bin/pg_dump" "$TMP_DIR/fake-bin/pg_restore"

if PATH="$TMP_DIR/fake-bin:$PATH" \
    FSUSBLOG_BACKUP_RUN_ID="issue-1099-missing-recipient" \
    FSUSBLOG_BACKUP_ROOT="$TMP_DIR/missing-recipient-backups" \
    FSUSBLOG_BACKUP_WORK_DIR="$TMP_DIR/missing-recipient-backups/work" \
    FSUSBLOG_BACKUP_PACKAGE="$TMP_DIR/missing-recipient-backups/site.fsbenc" \
    FSUSBLOG_POSTGRES_URL="Host=db;Database=fsus;Username=fsus;Password=fixture" \
    "$ROOT_DIR/tools/operations/backup-site.sh" >/dev/null 2>&1; then
    printf '%s\n' 'backup succeeded without an envelope recipient' >&2
    exit 1
fi
jq -e '.status == "blocked" and (.blockers | index("backup-envelope-recipient-missing")) != null' \
    "$TMP_DIR/missing-recipient-backups/backup-site-issue-1099-missing-recipient.json" >/dev/null
test ! -e "$TMP_DIR/missing-recipient-backups/site.fsbenc"

PACKAGE="$TMP_DIR/backups/site.tar.gz.fsbenc"
PATH="$TMP_DIR/fake-bin:$PATH" \
    FSUSBLOG_BACKUP_RUN_ID="issue-1099-fixture" \
    FSUSBLOG_BACKUP_ROOT="$TMP_DIR/backups" \
    FSUSBLOG_BACKUP_WORK_DIR="$TMP_DIR/backups/work" \
    FSUSBLOG_BACKUP_PACKAGE="$PACKAGE" \
    FSUSBLOG_BACKUP_RECIPIENT_FILE="$TMP_DIR/recipient.pem" \
    FSUSBLOG_BACKUP_CONFIG_FILES="$TMP_DIR/appsettings.fixture.json" \
    FSUSBLOG_POSTGRES_URL="Host=db;Database=fsus;Username=fsus;Password=fixture" \
    FSUSBLOG_DATA_PROTECTION_KEY_RING="$TMP_DIR/data/keyring" \
    FSUSBLOG_WEB_ROOT="$TMP_DIR/web" \
    FSUSBLOG_UPLOADS_DIR="$TMP_DIR/web/uploads" \
    FSUSBLOG_AOT_DIR="$TMP_DIR/web/aot-cache" \
    FSUSBLOG_SEARCH_DIR="$TMP_DIR/web/search" \
    "$ROOT_DIR/tools/operations/backup-site.sh" >/dev/null

test -s "$PACKAGE"
jq -e '.status == "ok" and .packageEncryption.contentEncryption == "AES-256-GCM" and .packageEncryption.keyWrap == "RSA-OAEP-SHA256"' \
    "$TMP_DIR/backups/backup-site-issue-1099-fixture.json" >/dev/null
if tar -tzf "$PACKAGE" >/dev/null 2>&1; then
    printf '%s\n' 'encrypted package was readable as plaintext tar' >&2
    exit 1
fi
if grep -a -q 'database-plaintext-marker\|old-generation\|current-generation' "$PACKAGE"; then
    printf '%s\n' 'encrypted package leaked plaintext fixture material' >&2
    exit 1
fi

DECRYPTED="$TMP_DIR/decrypted.tar.gz"
node "$ROOT_DIR/tools/operations/backup-envelope.mjs" decrypt \
    --input "$PACKAGE" \
    --output "$DECRYPTED" \
    --identity "$TMP_DIR/identity.pem" >/dev/null
mkdir -p "$TMP_DIR/decrypted"
tar -xzf "$DECRYPTED" -C "$TMP_DIR/decrypted"
jq -e '.version == 2 and .dataProtection.encryptedKeyCount == 2 and .dataProtection.plaintextMasterKeyPresent == false' \
    "$TMP_DIR/decrypted/manifest.json" >/dev/null

if node "$ROOT_DIR/tools/operations/backup-envelope.mjs" decrypt \
    --input "$PACKAGE" \
    --output "$TMP_DIR/wrong-output.tar.gz" \
    --identity "$TMP_DIR/wrong-identity.pem" >/dev/null 2>&1; then
    printf '%s\n' 'wrong backup identity unexpectedly decrypted package' >&2
    exit 1
fi
test ! -e "$TMP_DIR/wrong-output.tar.gz"

cp "$TMP_DIR/identity.pem" "$TMP_DIR/insecure-identity.pem"
chmod 0644 "$TMP_DIR/insecure-identity.pem"
if node "$ROOT_DIR/tools/operations/backup-envelope.mjs" decrypt \
    --input "$PACKAGE" \
    --output "$TMP_DIR/insecure-output.tar.gz" \
    --identity "$TMP_DIR/insecure-identity.pem" >/dev/null 2>&1; then
    printf '%s\n' 'insecurely permissioned identity unexpectedly decrypted package' >&2
    exit 1
fi
test ! -e "$TMP_DIR/insecure-output.tar.gz"

cp "$PACKAGE" "$TMP_DIR/tampered.fsbenc"
node --input-type=module - "$TMP_DIR/tampered.fsbenc" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
const bytes = readFileSync(path)
bytes[Math.floor(bytes.length / 2)] ^= 0x01
writeFileSync(path, bytes, { mode: 0o600 })
NODE
if node "$ROOT_DIR/tools/operations/backup-envelope.mjs" decrypt \
    --input "$TMP_DIR/tampered.fsbenc" \
    --output "$TMP_DIR/tampered-output.tar.gz" \
    --identity "$TMP_DIR/identity.pem" >/dev/null 2>&1; then
    printf '%s\n' 'tampered backup unexpectedly authenticated' >&2
    exit 1
fi
test ! -e "$TMP_DIR/tampered-output.tar.gz"

mkdir -p "$TMP_DIR/unsafe-package"
ln -s /tmp "$TMP_DIR/unsafe-package/escape"
tar -czf "$TMP_DIR/unsafe-package.tar.gz" -C "$TMP_DIR/unsafe-package" .
node "$ROOT_DIR/tools/operations/backup-envelope.mjs" encrypt \
    --input "$TMP_DIR/unsafe-package.tar.gz" \
    --output "$TMP_DIR/unsafe-package.fsbenc" \
    --recipient "$TMP_DIR/recipient.pem" >/dev/null
if PATH="$TMP_DIR/fake-bin:$PATH" \
    FSUSBLOG_RESTORE_RUN_ID="issue-1099-unsafe" \
    FSUSBLOG_RESTORE_ROOT="$TMP_DIR/unsafe-restore" \
    FSUSBLOG_RESTORE_REPORT="$TMP_DIR/unsafe-restore-report.json" \
    FSUSBLOG_BACKUP_IDENTITY_FILE="$TMP_DIR/identity.pem" \
    "$ROOT_DIR/tools/operations/restore-site.sh" \
    --backup "$TMP_DIR/unsafe-package.fsbenc" --dry-run >/dev/null 2>&1; then
    printf '%s\n' 'restore-site accepted an archive containing a symlink' >&2
    exit 1
fi
jq -e '.status == "blocked" and (.blockers | index("backup-package-archive-unsafe")) != null' \
    "$TMP_DIR/unsafe-restore-report.json" >/dev/null
test ! -e "$TMP_DIR/unsafe-restore/.site-package.plaintext.tar.gz"

mkdir -p "$TMP_DIR/restored-web"
PATH="$TMP_DIR/fake-bin:$PATH" \
    FSUSBLOG_RESTORE_RUN_ID="issue-1099-restore" \
    FSUSBLOG_RESTORE_ROOT="$TMP_DIR/restore" \
    FSUSBLOG_RESTORE_REPORT="$TMP_DIR/restore-report.json" \
    FSUSBLOG_BACKUP_IDENTITY_FILE="$TMP_DIR/identity.pem" \
    FSUSBLOG_POSTGRES_URL="Host=db;Database=fsus;Username=fsus;Password=fixture" \
    FSUSBLOG_DATA_PROTECTION_KEY_RING="$TMP_DIR/restored-keyring" \
    FSUSBLOG_WEB_ROOT="$TMP_DIR/restored-web" \
    FSUSBLOG_UPLOADS_DIR="$TMP_DIR/restored-web/uploads" \
    "$ROOT_DIR/tools/operations/restore-site.sh" --backup "$PACKAGE" --confirm >/dev/null

jq -e '.status == "ok" and (.checks | index("site-package-envelope:authenticated")) != null and (.checks | index("data-protection-key-generations:2")) != null' \
    "$TMP_DIR/restore-report.json" >/dev/null
test -f "$TMP_DIR/restored-keyring/key-old.xml"
test -f "$TMP_DIR/restored-keyring/key-current.xml"
test ! -e "$TMP_DIR/restore/.site-package.plaintext.tar.gz"

if PATH="$TMP_DIR/fake-bin:$PATH" \
    FSUSBLOG_RESTORE_RUN_ID="issue-1099-tampered" \
    FSUSBLOG_RESTORE_ROOT="$TMP_DIR/tampered-restore" \
    FSUSBLOG_RESTORE_REPORT="$TMP_DIR/tampered-restore-report.json" \
    FSUSBLOG_BACKUP_IDENTITY_FILE="$TMP_DIR/identity.pem" \
    "$ROOT_DIR/tools/operations/restore-site.sh" \
    --backup "$TMP_DIR/tampered.fsbenc" --dry-run >/dev/null 2>&1; then
    printf '%s\n' 'restore-site accepted a tampered envelope' >&2
    exit 1
fi
jq -e '.status == "blocked" and (.blockers | index("backup-envelope-authentication-or-decryption-failed")) != null' \
    "$TMP_DIR/tampered-restore-report.json" >/dev/null
test ! -e "$TMP_DIR/tampered-restore/.site-package.plaintext.tar.gz"

echo "[backup-envelope-fixture] ok"
