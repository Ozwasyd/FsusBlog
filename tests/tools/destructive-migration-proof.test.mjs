import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const paths = {
    primitives: new URL('../../src/migration/SchemaMigrationPrimitives.cs', import.meta.url),
    proofs: new URL('../../src/migration/DestructiveMigrationProofs.cs', import.meta.url),
    runner: new URL('../../src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs', import.meta.url),
    executor: new URL('../../src/migration/OfflineMigrationExecutor.cs', import.meta.url),
    transaction: new URL('../../src/migration/SchemaMigrationExecution.cs', import.meta.url),
    manifest: new URL('../../docs/schema-migrations/destructive-rollback-window-proofs.json', import.meta.url)
};

const definitionsDirectory = new URL('../../src/migration/Definitions/', import.meta.url);
const definitionFiles = (await readdir(definitionsDirectory))
    .filter(name => name.endsWith('MigrationDefinitions.cs'))
    .sort();
const [entries, registrySources] = await Promise.all([
    Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')])),
    Promise.all(definitionFiles.map(name => readFile(new URL(name, definitionsDirectory), 'utf8')))
]);
const source = { ...Object.fromEntries(entries), registry: registrySources.join('\n') };
const manifest = JSON.parse(source.manifest);

function destructiveInventory()
{
    const token = /new SchemaMigrationDescriptor\(\s*"([^"]+)"|new Drop(Column|Table)Step\("([^"]+)"(?:,\s*"([^"]+)")?,\s*DestructiveMigrationProofs\.For\("([^"]+)"\)\)/gu;
    const inventory = [];
    let descriptorId = '';
    for (const match of source.registry.matchAll(token))
    {
        if (match[1])
        {
            descriptorId = match[1];
            continue;
        }
        inventory.push({ descriptorId, kind: match[2], table: match[3], column: match[4] ?? null, proofId: match[5] });
    }
    return inventory;
}

test('every current DropColumn and DropTable carries a descriptor-matched proof reference', () =>
{
    const rawDrops = source.registry.match(/new Drop(?:Column|Table)Step\(/gu) ?? [];
    const inventory = destructiveInventory();
    const descriptorIds = [...new Set(inventory.map(operation => operation.descriptorId))].sort();

    assert.equal(rawDrops.length, 46, 'the issue reported 44, but the live inventory includes two read-retirement tables');
    assert.equal(inventory.length, rawDrops.length, 'every destructive drop must use DestructiveMigrationProofs.For');
    for (const operation of inventory)
    {
        assert.equal(operation.proofId, operation.descriptorId, `${operation.table}.${operation.column ?? '*'} borrows the wrong proof`);
    }

    assert.equal(manifest.reportedDestructiveStepCount, 44);
    assert.equal(manifest.destructiveStepCount, inventory.length);
    assert.equal(manifest.proofDescriptorCount, descriptorIds.length);
    assert.deepEqual(manifest.proofs.map(proof => proof.migrationId).sort(), descriptorIds);
});

test('proof manifest binds real source SHAs to exact 30-day windows', () =>
{
    assert.match(manifest.inventoryCommitSha, /^[0-9a-f]{40}$/u);
    assert.equal(manifest.minimumRollbackWindowDays, 30);

    for (const proof of manifest.proofs)
    {
        assert.match(proof.introducedByCommit, /^[0-9a-f]{40}$/u);
        assert.equal(proof.earliestContractRelease, proof.migrationId);
        assert.match(source.proofs, new RegExp(`"${proof.migrationId}"[\\s\\S]{0,180}"${proof.introducedByCommit}"`, 'u'));
        const introducedAt = Date.parse(proof.introducedAtUtc);
        const windowEnd = Date.parse(proof.rollbackWindowEndUtc);
        assert.ok(Number.isFinite(introducedAt) && Number.isFinite(windowEnd), `${proof.migrationId} has invalid timestamps`);
        assert.equal(windowEnd - introducedAt, 30 * 24 * 60 * 60 * 1000, `${proof.migrationId} window is not exactly 30 days`);
    }
});

test('full-history checkout confirms source commits and timestamps', t =>
{
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';
    if (shallow)
    {
        t.skip('the fast CI checkout is shallow; immutable SHA/UTC shape remains enforced there');
        return;
    }

    for (const proof of manifest.proofs)
    {
        const committedAtSeconds = Number(execFileSync('git', ['show', '-s', '--format=%ct', proof.introducedByCommit], { encoding: 'utf8' }).trim());
        assert.equal(new Date(committedAtSeconds * 1000).toISOString(), new Date(proof.introducedAtUtc).toISOString());
        const changedPaths = execFileSync('git', ['show', '--format=', '--name-only', proof.introducedByCommit], { encoding: 'utf8' });
        assert.match(changedPaths, /SchemaMigrationRegistry\.cs/u);
    }
});

test('drop primitives require typed proof and runtime gates precede transactions', () =>
{
    assert.match(source.primitives, /DropColumnStep\([\s\S]*DestructiveMigrationProof Proof\)\s*:\s*SchemaMigrationStep, IDestructiveSchemaMigrationStep/u);
    assert.match(source.primitives, /DropTableStep\([\s\S]*DestructiveMigrationProof Proof\)\s*:\s*SchemaMigrationStep, IDestructiveSchemaMigrationStep/u);
    assert.doesNotMatch(source.primitives, /DestructiveMigrationProof\? Proof/u);

    // The original mutation guard belongs to Migration, not a retained Server
    // executor. This is a source-order control, not provider execution evidence.
    const executorStart = source.executor.indexOf('private static async Task<OfflineMigrationExecutionResult> ExecuteExpandAsync');
    const executorEnd = source.executor.indexOf('private static async Task<OfflineMigrationExecutionResult> ExecuteBackfillAsync', executorStart);
    assert.ok(executorStart >= 0 && executorEnd > executorStart);
    const executor = source.executor.slice(executorStart, executorEnd);
    const guard = executor.indexOf('DestructiveMigrationProofs.ValidateDescriptor');
    const transaction = executor.indexOf('SchemaMigrationTransactionExecutor.ExecuteAsync');
    assert.ok(guard > 0 && guard < transaction);
    assert.match(executor, /freshBootstrap: false/u);
    assert.match(source.transaction, /descriptor\.Transactional[\s\S]*UseTranAsync[\s\S]*executeStep/u);
    assert.doesNotMatch(source.runner, /DestructiveMigrationProofs|SchemaMigrationTransactionExecutor|UseTranAsync|InitTables/u);
    assert.match(source.runner, /CurrentSchemaReceiptAdmission\.VerifyAsync/u);
});

test('proof contract names every qualification and restore requirement', () =>
{
    assert.deepEqual(manifest.requiredEvidence, [
        'n_minus_one_qualification_passed',
        'rollback_manifest_sealed',
        'backup_restore_verified',
        'wal_restore_verified',
        'cross_region_restore_verified'
    ]);
    for (const evidence of manifest.requiredEvidence)
    {
        assert.match(source.proofs, new RegExp(`"${evidence}"`, 'u'));
    }
    assert.match(source.proofs, /schema_destructive_rollback_window_open/u);
});
