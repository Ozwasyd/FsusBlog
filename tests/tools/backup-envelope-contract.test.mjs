import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function source(path)
{
    return readFile(new URL(path, root), 'utf8');
}

test('backup command only publishes an authenticated encrypted envelope', async () =>
{
    const [backup, envelope] = await Promise.all([
        source('tools/operations/backup-site.sh'),
        source('tools/operations/backup-envelope.mjs')
    ]);

    assert.match(backup, /backup-envelope\.mjs/);
    assert.match(backup, /site-package" "authenticated-encrypted"/);
    assert.match(backup, /data-protection-keyring-plaintext-or-invalid/);
    assert.match(backup, /plaintextMasterKeyPresent: false/);
    assert.doesNotMatch(backup, /tar -czf "\$PACKAGE_PATH"/);
    assert.match(envelope, /createCipheriv\('aes-256-gcm'/);
    assert.match(envelope, /RSA_PKCS1_OAEP_PADDING/);
    assert.match(envelope, /oaepHash: 'sha256'/);
    assert.match(envelope, /cipher\.setAAD\(headerBytes\)/);
    assert.match(envelope, /cipher\.getAuthTag\(\)/);
    assert.match(envelope, /recipient file must not contain a private key/);
});

test('restore rejects unauthenticated packages and verifies manifest digests', async () =>
{
    const restore = await source('tools/operations/restore-site.sh');

    assert.match(restore, /backup-envelope-authentication-or-decryption-failed/);
    assert.match(restore, /backup-manifest-digest-mismatch/);
    assert.match(restore, /data-protection-keyring-generation-count-mismatch/);
    assert.match(restore, /data-protection-keyring-plaintext-or-invalid/);
    assert.doesNotMatch(restore, /tar -xzf "\$BACKUP_PACKAGE"/);
});

test('real restore drill requires current and previous encrypted generations', async () =>
{
    const drill = await source('tools/operations/backup-restore-drill.sh');

    assert.match(drill, /site-backup-envelope-invalid/);
    assert.match(drill, /site-backup-archive-unsafe/);
    assert.match(drill, /site-backup-keyring-archive-unsafe/);
    assert.match(drill, /\.dataProtection\.encryptedKeyCount >= 2/);
    assert.match(drill, /data-protection-current-previous-generations/);
    assert.match(drill, /site-backup-artifact-digest-mismatch/);
});

test('security documentation defines separate custody, rotation, retention, and rollback', async () =>
{
    const documentation = await source('docs/security/site-backup-envelope.md');

    for (const required of [
        'Key custody',
        'Recipient rotation and retention',
        'Disaster recovery drill',
        'Failure and no-restart rollback',
        'FSUSBLOG_BACKUP_RECIPIENT_FILE',
        'FSUSBLOG_BACKUP_IDENTITY_FILE'
    ])
    {
        assert.match(documentation, new RegExp(required));
    }
});

test('backup and restore reports bind the exact encrypted package bytes', async () =>
{
    const [backup, restore, drill] = await Promise.all([
        source('tools/operations/backup-site.sh'),
        source('tools/operations/restore-site.sh'),
        source('tools/operations/backup-restore-drill.sh')
    ]);

    for (const script of [backup, restore, drill])
    {
        assert.match(script, /packageSha256:/);
    }
    assert.match(backup, /sha256sum "\$PACKAGE_PATH"/);
    assert.match(restore, /backup-package-changed-during-authentication/);
    assert.match(drill, /site-backup-package-changed-during-authentication/);
});

test('site package drill cannot substitute independently supplied restore artifacts', async () =>
{
    const drill = await source('tools/operations/backup-restore-drill.sh');

    assert.match(drill, /site-backup-artifact-override-forbidden/);
    assert.match(drill, /POSTGRES_BACKUP="\$packageDir\/database\.dump"/);
    assert.match(drill, /UPLOADS_BACKUP="\$packageDir\/uploads\.tar\.gz"/);
    assert.match(drill, /AOT_BACKUP="\$packageDir\/aot-cache\.tar\.gz"/);
    assert.match(drill, /SEARCH_BACKUP="\$packageDir\/search\.tar\.gz"/);
    assert.doesNotMatch(drill, /POSTGRES_BACKUP="\$\{POSTGRES_BACKUP:-/);
});

test('migration capture holds the native snapshot until the original dump has completed', async () =>
{
    const backup = await source('tools/operations/backup-site.sh');

    assert.match(backup, /--capture-session --dump-output "\$target"/);
    assert.match(backup, /--format=custom --snapshot="\$snapshotId" --file="\$target"/);
    assert.match(backup, /printf 'DUMP_COMPLETED\\n'/);
    assert.match(backup, /wait "\$capturePid"/);
    assert.match(backup, /\.capture\.Source == \$start\.Source/);
    assert.match(backup, /\.capture\.DatabaseDumpSha256 == \$digest/);
    assert.match(backup, /database-backup-provider-unsupported/);
    assert.match(backup, /version: \(if \$sourceCapture == null then 2 else 3 end\)/);
    assert.ok(backup.indexOf('--snapshot="$snapshotId"') < backup.indexOf("printf 'DUMP_COMPLETED\\n'"));
    assert.ok(backup.indexOf('wait "$capturePid"') < backup.indexOf('SOURCE_CAPTURE="$(jq -c'));
});

test('bound restore independently observes an isolated target and exact restored content', async () =>
{
    const [restore, drill] = await Promise.all([
        source('tools/operations/restore-site.sh'),
        source('tools/operations/backup-restore-drill.sh')
    ]);

    assert.match(restore, /database-restore-target-not-isolated-or-unobserved/);
    assert.match(restore, /--exit-on-error --clean --if-exists/);
    assert.match(restore, /database-restored-source-content-mismatch/);
    assert.match(restore, /database-bound-restore-path-not-isolated/);
    assert.match(drill, /database-restored-source-not-isolated-or-content-mismatch/);
    assert.match(drill, /restoredDatabaseDumpSha256:/);
    for (const script of [restore, drill])
    {
        assert.match(script, /observe-source --provider postgresql --env-file/);
        assert.match(script, /\.sourceBinding\.capture\.Source\.ContentDigest/);
        assert.match(script, /\.sourceBinding\.capture\.DatabaseDumpSha256 == \.artifactDigests\.database/);
    }
});
