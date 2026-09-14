import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {validateAuthorSavedViewStorageContract} = await import(new URL('../../tools/governance/check-author-saved-view-storage-contract.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const owned = [
    'src/backend/Services/Authoring/AuthorSavedViewStore.cs',
    'src/backend/Services/Authoring/PostgresAuthorSavedViewPersistence.cs',
    'src/backend/Services/Authoring/PostgresAuthorSavedViewDependencyProvider.cs',
    'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs',
    'tests/backend/Unit/AuthorSavedViewStoreTests.cs',
    'tests/backend/Integration/AuthorSavedViewPostgresIntegrationTests.cs',
    'src/migration/Definitions/AuthorSavedViewMigrationDefinitions.cs',
    'src/migration/Catalogs/SchemaMigrationCatalog20260904SavedViews.cs'
];

function fixture()
{
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'author-saved-view-storage-'));
    for (const relative of owned)
    {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, relative), destination);
    }
    return target;
}

function mutate(target, relative, transform)
{
    const absolute = path.join(target, relative);
    fs.writeFileSync(absolute, transform(fs.readFileSync(absolute, 'utf8')));
}

test('current Author Saved View storage contract satisfies static governance', () =>
{
    assert.deepEqual(validateAuthorSavedViewStorageContract(root), []);
});

test('governance rejects a second server authority or local storage side path', () =>
{
    const target = fixture();
    mutate(target, owned[0], source => source
        .replace('public sealed class AuthorSavedViewStore(', 'public sealed class AuthorSavedViewStoreReplica(\n    IAuthorSavedViewPersistence ignored) : IAuthorSavedViewStore { }\n\npublic sealed class AuthorSavedViewStore(')
        .concat('\n// localStorage\n'));
    const errors = validateAuthorSavedViewStorageContract(target);
    assert.ok(errors.some(error => error.includes('exactly one server authority')));
    assert.ok(errors.some(error => error.includes('forbidden surface')));
});

test('governance rejects persistence without the owner-site transaction lock', () =>
{
    const target = fixture();
    mutate(target, owned[1], source => source.replaceAll('pg_advisory_xact_lock', 'pg_lock_removed'));
    assert.ok(validateAuthorSavedViewStorageContract(target)
        .some(error => error.includes('pg_advisory_xact_lock')));
});

test('governance requires database paging, batched audit writes, and production dependency wiring', () =>
{
    const target = fixture();
    mutate(target, owned[1], source => source
        .replace('LIMIT @ReadLimit', 'LIMIT 1000')
        .replace('saved_view_history_write_count_mismatch', 'removed_history_batch_guard'));
    mutate(target, owned[3], source => source.replace(
        'AddScoped<IAuthorSavedViewDependencyProvider, PostgresAuthorSavedViewDependencyProvider>()',
        'AddScoped<IAuthorSavedViewDependencyCatalog, AuthorSavedViewDependencyCatalog>()'));
    const errors = validateAuthorSavedViewStorageContract(target);
    assert.ok(errors.some(error => error.includes('LIMIT @ReadLimit')));
    assert.ok(errors.some(error => error.includes('saved_view_history_write_count_mismatch')));
    assert.ok(errors.some(error => error.includes('dependency registration')));
});

test('governance rejects JSON, result snapshots, and missing relational history', () =>
{
    const target = fixture();
    mutate(target, owned[6], source => source
        .replace('CREATE TABLE IF NOT EXISTS author_saved_view_receipt_change', 'CREATE TABLE IF NOT EXISTS removed_receipt_change')
        .concat('\n-- jsonb permission_snapshot article_ids\n'));
    const errors = validateAuthorSavedViewStorageContract(target);
    assert.ok(errors.some(error => error.includes('author_saved_view_receipt_change')));
    assert.ok(errors.some(error => error.includes('must remain relational')));
});

test('governance rejects removal of CAS, bounds, and verifier coverage', () =>
{
    const target = fixture();
    mutate(target, owned[0], source => source
        .replaceAll('ExpectedCollectionRevision', 'RemovedCollectionRevision')
        .replace('MaxViewsPerOwner = 1_000', 'MaxViewsPerOwner = 10_000'));
    mutate(target, owned[4], source => source
        .replace('Verifier_DetectsMissingReceiptAndBrokenCollectionRevisionChain', 'RemovedVerifierCoverage'));
    const errors = validateAuthorSavedViewStorageContract(target);
    assert.ok(errors.some(error => error.includes('ExpectedCollectionRevision')));
    assert.ok(errors.some(error => error.includes('MaxViewsPerOwner')));
    assert.ok(errors.some(error => error.includes('RemovedVerifierCoverage')
        || error.includes('Verifier_DetectsMissingReceiptAndBrokenCollectionRevisionChain')));
});
