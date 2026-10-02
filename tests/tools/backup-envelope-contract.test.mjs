import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    assert.match(backup, /WaitCaptureChild "\$capturePid"/);
    assert.match(backup, /\.capture\.Source == \$start\.Source/);
    assert.match(backup, /\.capture\.DatabaseDumpSha256 == \$digest/);
    assert.match(backup, /database-backup-provider-unsupported/);
    assert.match(backup, /version: \(if \$sourceCapture == null then 2 else 3 end\)/);
    assert.ok(backup.indexOf('--snapshot="$snapshotId"') < backup.indexOf("printf 'DUMP_COMPLETED\\n'"));
    assert.ok(backup.indexOf('WaitCaptureChild "$capturePid"') < backup.indexOf('sourceCapture="$(jq -c'));
    assert.ok(backup.indexOf('await handle.sync()') < backup.indexOf("printf 'DUMP_COMPLETED\\n'"));
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
        assert.match(script, /observe-source --provider postgresql\s+(?:\\\n\s*)?--env-file/);
        assert.match(script, /\.sourceBinding\.capture\.Source\.ContentDigest/);
        assert.match(script, /\.sourceBinding\.capture\.DatabaseDumpSha256 == \.artifactDigests\.database/);
    }
});

test('source operations share one monotonic deadline and preserve direct child ownership', async () =>
{
    const [backup, restore, drill] = await Promise.all([
        source('tools/operations/backup-site.sh'),
        source('tools/operations/restore-site.sh'),
        source('tools/operations/backup-restore-drill.sh')
    ]);

    for (const script of [backup, restore, drill])
    {
        assert.match(script, /FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS/);
        assert.match(script, /read -r uptimeValue ignored <\/proc\/uptime/);
        assert.match(script, /timeout --signal=TERM --kill-after=1s/);
        assert.match(script, /SignalOwnedChildGroup TERM "\$pid"/);
        assert.match(script, /SignalOwnedChildGroup KILL "\$pid"/);
        assert.match(script, /ChildGroupEmpty "\$pid" \|\| return 1\s+wait "\$pid"/);
        const runningCheck = script.match(/ChildRunning\(\) \{[\s\S]*?\n\}/);
        assert.ok(runningCheck);
        assert.doesNotMatch(runningCheck[0], /kill -0/);
    }
    assert.match(backup, /read -r -t "\$remaining" -u "\$captureReadFd"/);
    assert.match(backup, /\.capture\.TimeoutSeconds == \$start\.TimeoutSeconds/);
    assert.match(backup, /\[\[ -n "\$migrationDll" \]\] && ! ReadCaptureBudget/);
    assert.doesNotMatch(restore, /\$\(ObserveDatabase\)/);
    assert.match(restore, /targetSource="\$observedDatabase"/);
    for (const script of [restore, drill])
    {
        assert.match(script, /"\$@" <&0 >"\$outputPath"/);
        assert.equal((script.match(/sourceDeadline=\$\(/g) ?? []).length, 1);
    }
});

test('owned child termination refuses a mismatched process-generation identity', async () =>
{
    for (const [path, prefix] of [
        ['tools/operations/backup-site.sh', 'Capture'],
        ['tools/operations/restore-site.sh', 'Source'],
        ['tools/operations/backup-restore-drill.sh', 'Source']
    ])
    {
        const script = await source(path);
        const names = [`${prefix}Now`, `${prefix}Remaining`, 'ChildRunning', 'ChildGroupEmpty',
            'ReadChildIdentity', 'RegisterChildIdentity', 'SignalOwnedChildGroup', `Stop${prefix}Child`];
        const helpers = names.map(name =>
        {
            const match = script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
            assert.ok(match, name);
            return match[0];
        }).join('\n');
        const low = prefix.toLowerCase();
        const result = spawnSync('bash', ['-c', `set -euo pipefail\nblocked=0\nAddBlocker() { blocked=1; }\n${helpers}\ndeclare -A ${low}ChildIdentities=()\n${low}Deadline=$(( $(${prefix}Now) + 2 ))\ntimeout 2s sleep 0.3 &\npid=$!\nRegisterChildIdentity "$pid"\n[[ -n "\${${low}ChildIdentities[$pid]:-}" ]]\n${low}ChildIdentities["$pid"]="$pid:999999999999999999"\nif Stop${prefix}Child "$pid"; then exit 2; fi\n[[ "$blocked" == 1 ]]\nwait "$pid"\nblocked=0\ntimeout 2s sleep 1 &\npid=$!\nRegisterChildIdentity "$pid"\nStop${prefix}Child "$pid"\n[[ "$blocked" == 0 ]]\n! ChildRunning "$pid"\nChildGroupEmpty "$pid"`], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    }
});

test('the production shell budget parsers reject noncanonical or overflowing values', async () =>
{
    for (const [path, prefix] of [
        ['tools/operations/backup-site.sh', 'Capture'],
        ['tools/operations/restore-site.sh', 'Source'],
        ['tools/operations/backup-restore-drill.sh', 'Source']
    ])
    {
        const script = await source(path);
        const parser = script.match(new RegExp(`Read${prefix}Budget\\(\\) \\{[\\s\\S]*?\\n\\}`));
        const clock = script.match(new RegExp(`${prefix}Now\\(\\) \\{[\\s\\S]*?\\n\\}`));
        assert.ok(parser && clock);
        const variable = prefix === 'Capture' ? 'captureTimeoutSeconds' : 'sourceTimeoutSeconds';
        for (const [value, accepted] of [
            ['', false], ['0', false], ['01', false], ['+1', false], ['-1', false],
            [' 1', false], ['1 ', false], ['1e3', false], ['１２', false],
            ['2147484', false], ['99999999999999999999', false], ['1', true], ['2147483', true]
        ])
        {
            // Only the actual parser and monotonic clock functions run: no script Main, files, or database tools.
            const result = spawnSync('bash', ['-c', `AddBlocker() { :; }\n${clock[0]}\n${parser[0]}\n${prefix.toLowerCase()}Deadline=0\n${variable}="$1"\nRead${prefix}Budget`, 'budget-parser', value], { encoding: 'utf8' });
            assert.equal(result.status, accepted ? 0 : 1, `${path}: ${JSON.stringify(value)}: ${result.stderr}`);
        }
    }
});

test('read-only inspection reuses authenticated restore validation and never restores a target', async () =>
{
    const restore = await source('tools/operations/restore-site.sh');
    const body = restore.match(/InspectAuthenticatedPackage\(\) \{[\s\S]*?\n\}/);
    const entry = restore.match(/InspectPackage\(\) \{[\s\S]*?\n\}/);
    assert.ok(body && entry);
    assert.match(body[0], /DecryptPackage/);
    assert.match(body[0], /ArchiveIsSafe/);
    assert.match(body[0], /VerifyPackageManifest/);
    assert.match(body[0], /VerifyConsumedArtifacts/);
    assert.match(body[0], /manifestBase64:/);
    assert.match(body[0], /sourceBinding:/);
    assert.doesNotMatch(body[0], /RestoreDatabase|ObserveDatabase|RestoreTree|pg_restore|dotnet/);
    assert.match(entry[0], /RunSourceCommand[\s\S]*InspectAuthenticatedPackage/);
    assert.match(entry[0], /CleanupInspection/);
    assert.ok(restore.indexOf('    if [[ "$inspectOnly" == "1" ]]; then\n        InspectPackage') < restore.indexOf('    mkdir -p "$RESTORE_ROOT/package"'));
});

test('inspection rejects missing or invalid explicit budget before any staging writes', () =>
{
    const script = new URL('tools/operations/restore-site.sh', root).pathname;
    for (const value of [null, '0', '01', '+1', '2147484', '999999999999999999999'])
    {
        const args = [script, '--inspect-only', '--backup', '/nonexistent-inspection-package'];
        if (value !== null)
        {
            args.push('--timeout-seconds', value);
        }
        const result = spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS: '1' } });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /inspection-timeout-invalid-or-missing/);
    }
});

test('owned migration drill retains the original full smoke and publishes only this completed invocation', async () =>
{
    const drill = await source('tools/operations/backup-restore-drill.sh');
    assert.match(drill, /--migration-evidence/);
    assert.match(drill, /sourceDeadline="\$2"; evidenceNonce="\$3"; RunEvidenceWorker/);
    assert.match(drill, /RunEvidenceWorker\(\) \{\s+RunReal/);
    assert.match(drill, /StartRestoredBackend\s+RunSmokeChecks/);
    assert.match(drill, /--cidfile "\$OUT_DIR\/owned-postgres.cid"/);
    assert.match(drill, /--cidfile "\$OUT_DIR\/owned-redis.cid"/);
    assert.match(drill, /docker rm -f "\$cid"/);
    assert.match(drill, /docker ps -aq --no-trunc --filter "id=\$cid"/);
    assert.match(drill, /evidenceWorkIdentity="\$\(stat -c '%d:%i'/);
    assert.match(drill, /owned-backend-listener-start.json/);
    assert.match(drill, /owned-backend-listener-end.json/);
    assert.match(drill, /producerExitCode:0/);
    assert.match(drill, /nativeRestoredSourceReference:/);
    assert.match(drill, /drillManifestSha256:/);
    assert.match(drill, /owned-drill-actual-proof-or-full-smoke-invalid/);
    const worker = drill.match(/RunEvidenceWorker\(\) \{[\s\S]*?\n\}/);
    assert.ok(worker);
    assert.ok(worker[0].indexOf('    Cleanup\n') < worker[0].indexOf('    WriteReport\n'));
});

test('owned migration drill rejects missing or invalid budget before creating output or running tools', () =>
{
    const script = new URL('tools/operations/backup-restore-drill.sh', root).pathname;
    for (const value of [null, '0', '01', '+1', '2147484', '999999999999999999999'])
    {
        const args = [script, '--migration-evidence'];
        if (value !== null)
        {
            args.push('--timeout-seconds', value);
        }
        const result = spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, FSUSBLOG_DRILL_MODE: 'real' } });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /owned-drill-timeout-invalid-or-missing/);
    }
});

test('embedded operation JavaScript parses without importing or executing its production body', async () =>
{
    let blocks = 0;
    for (const path of ['tools/operations/backup-site.sh', 'tools/operations/backup-restore-drill.sh'])
    {
        const script = await source(path);
        for (const match of script.matchAll(/<<'NODE'(?: &)?\n([\s\S]*?)\nNODE/g))
        {
            const result = spawnSync('node', ['--check', '--input-type=module'], { input: match[1], encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            blocks += 1;
        }
    }
    assert.equal(blocks, 2);
});

test('restore validators bind the canonical artifact names actually consumed', async () =>
{
    const [restore, drill] = await Promise.all([
        source('tools/operations/restore-site.sh'),
        source('tools/operations/backup-restore-drill.sh')
    ]);

    for (const script of [restore, drill])
    {
        for (const artifact of [
            'database.dump',
            'uploads.tar.gz',
            'data-protection-keyring.tar.gz',
            'config.redacted.tar.gz',
            'aot-cache.tar.gz',
            'search.tar.gz'
        ])
        {
            assert.ok(script.includes(`expectedArtifact="${artifact}"`));
        }
        assert.ok(script.includes('$artifact" != "$expectedArtifact'));
        assert.match(script, /inner-artifact-archive-unsafe/);
    }
    assert.match(restore, /backup-artifact-changed-before-restore/);
    assert.ok(restore.indexOf('        VerifyConsumedArtifacts\n') < restore.indexOf('        RestoreDatabase\n'));
    assert.match(drill, /restore-work-dir-not-fresh/);
    assert.match(drill, /if \[\[ "\$postgresOwned" == "1" \]\]/);
    assert.match(drill, /if \[\[ "\$redisOwned" == "1" \]\]/);
});
