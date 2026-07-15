import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('backup command only publishes an authenticated encrypted envelope', async () => {
  const [backup, envelope] = await Promise.all([
    source('tools/operations/backup-site.sh'),
    source('tools/operations/backup-envelope.mjs'),
  ])

  assert.match(backup, /backup-envelope\.mjs/)
  assert.match(backup, /site-package" "authenticated-encrypted"/)
  assert.match(backup, /data-protection-keyring-plaintext-or-invalid/)
  assert.match(backup, /plaintextMasterKeyPresent: false/)
  assert.doesNotMatch(backup, /tar -czf "\$PACKAGE_PATH"/)
  assert.match(envelope, /createCipheriv\('aes-256-gcm'/)
  assert.match(envelope, /RSA_PKCS1_OAEP_PADDING/)
  assert.match(envelope, /oaepHash: 'sha256'/)
  assert.match(envelope, /cipher\.setAAD\(headerBytes\)/)
  assert.match(envelope, /cipher\.getAuthTag\(\)/)
  assert.match(envelope, /recipient file must not contain a private key/)
})

test('restore rejects unauthenticated packages and verifies manifest digests', async () => {
  const restore = await source('tools/operations/restore-site.sh')

  assert.match(restore, /backup-envelope-authentication-or-decryption-failed/)
  assert.match(restore, /backup-manifest-digest-mismatch/)
  assert.match(restore, /data-protection-keyring-generation-count-mismatch/)
  assert.match(restore, /data-protection-keyring-plaintext-or-invalid/)
  assert.doesNotMatch(restore, /tar -xzf "\$BACKUP_PACKAGE"/)
})

test('real restore drill requires current and previous encrypted generations', async () => {
  const drill = await source('tools/operations/backup-restore-drill.sh')

  assert.match(drill, /site-backup-envelope-invalid/)
  assert.match(drill, /site-backup-archive-unsafe/)
  assert.match(drill, /site-backup-keyring-archive-unsafe/)
  assert.match(drill, /\.dataProtection\.encryptedKeyCount >= 2/)
  assert.match(drill, /data-protection-current-previous-generations/)
  assert.match(drill, /site-backup-artifact-digest-mismatch/)
})

test('security documentation defines separate custody, rotation, retention, and rollback', async () => {
  const documentation = await source('docs/security/site-backup-envelope.md')

  for (const required of [
    'Key custody',
    'Recipient rotation and retention',
    'Disaster recovery drill',
    'Failure and no-restart rollback',
    'FSUSBLOG_BACKUP_RECIPIENT_FILE',
    'FSUSBLOG_BACKUP_IDENTITY_FILE',
  ]) {
    assert.match(documentation, new RegExp(required))
  }
})
