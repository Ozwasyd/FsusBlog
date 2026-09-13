#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const files = Object.freeze({
    store: 'src/backend/Services/Authoring/AuthorSavedViewStore.cs',
    persistence: 'src/backend/Services/Authoring/PostgresAuthorSavedViewPersistence.cs',
    provider: 'src/backend/Services/Authoring/PostgresAuthorSavedViewDependencyProvider.cs',
    bootstrap: 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs',
    tests: 'tests/backend/Unit/AuthorSavedViewStoreTests.cs',
    integration: 'tests/backend/Integration/AuthorSavedViewPostgresIntegrationTests.cs',
    migration: 'src/migration/Definitions/AuthorSavedViewMigrationDefinitions.cs',
    catalog: 'src/migration/Catalogs/SchemaMigrationCatalog20260904SavedViews.cs'
});

function read(root, relative, errors) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
        errors.push(`missing required file: ${relative}`);
        return '';
    }
    return fs.readFileSync(absolute, 'utf8');
}

function requireText(source, text, label, errors) {
    if (!source.includes(text)) errors.push(`${label} is missing ${text}`);
}

function count(source, pattern) {
    return [...source.matchAll(pattern)].length;
}

export function validateAuthorSavedViewStorageContract(root) {
    const errors = [];
    const store = read(root, files.store, errors);
    const persistence = read(root, files.persistence, errors);
    const provider = read(root, files.provider, errors);
    const bootstrap = read(root, files.bootstrap, errors);
    const tests = read(root, files.tests, errors);
    const integration = read(root, files.integration, errors);
    const migration = read(root, files.migration, errors);
    const catalog = read(root, files.catalog, errors);

    if (count(store, /class\s+AuthorSavedViewStore\s*\(/g) !== 1
        || count(store, /:\s*IAuthorSavedViewStore\b/g) !== 1) {
        errors.push('saved view storage must have exactly one server authority');
    }

    for (const command of [
        'CreateAsync(', 'GetAsync(', 'ListAsync(', 'UpdateAsync(', 'RenameAsync(',
        'SetPinnedAsync(', 'ReorderPinnedAsync(', 'MovePinnedAsync(', 'SetDefaultAsync(', 'RetireAsync(',
        'DeleteAsync(', 'VerifyAsync('
    ]) {
        requireText(store, command, 'saved view authority', errors);
    }

    for (const fact of [
        'MaxViewsPerOwner = 1_000',
        'ExpectedCollectionRevision',
        'ExpectedViewRevision',
        'AuthorSavedViewCollectionRevisionConflictException',
        'AuthorSavedViewRevisionConflictException',
        'AuthorSavedViewIdempotencyConflictException',
        'IdempotentReplay = true',
        'AuthorSavedViewHistoryChange',
        'ComputeReceiptDigest',
        'ComputeHistoryChangeDigest',
        'ReadVerificationHistoryAsync'
    ]) {
        requireText(store, fact, 'saved view mutation contract', errors);
    }

    for (const forbidden of [
        /\blocalStorage\b/i,
        /\bResultIds?\b/i,
        /\bArticleIds?Snapshot\b/i,
        /\bPermissionSnapshot\b/i,
        /\bSqlExpression\b/i,
        /\bClientFunction\b/i
    ]) {
        if (forbidden.test(store)) {
            errors.push(`saved view authority contains forbidden surface: ${forbidden}`);
        }
    }

    for (const fact of [
        'pg_advisory_xact_lock',
        'UseTranAsync',
        'transaction.IsSuccess',
        'transaction.ErrorException',
        'author_saved_view_condition',
        'author_saved_view_projection',
        'author_saved_view_receipt_change',
        'author_saved_view_idempotency',
        'ReadPageAsync(',
        'LIMIT @ReadLimit',
        'ViewIdParameters(',
        'saved_view_history_write_count_mismatch'
    ]) {
        requireText(persistence, fact, 'PostgreSQL persistence', errors);
    }

    for (const fact of [
        'class PostgresAuthorSavedViewDependencyProvider',
        'AuthorSavedViewFieldKind.Category => "category"',
        'AuthorSavedViewFieldKind.Tag => "tag"',
        'AuthorSavedViewDependencyStatus.Deleted',
        'return null'
    ]) {
        requireText(provider, fact, 'saved view production dependency provider', errors);
    }
    requireText(
        bootstrap,
        'AddScoped<IAuthorSavedViewDependencyProvider, PostgresAuthorSavedViewDependencyProvider>()',
        'saved view dependency registration',
        errors);

    const requiredTables = [
        'author_saved_view_collection',
        'author_saved_view',
        'author_saved_view_condition',
        'author_saved_view_condition_value',
        'author_saved_view_projection',
        'author_saved_view_receipt',
        'author_saved_view_receipt_change',
        'author_saved_view_idempotency'
    ];
    for (const table of requiredTables) {
        requireText(migration, `CREATE TABLE IF NOT EXISTS ${table}`, 'saved view migration', errors);
    }
    for (const invariant of [
        'active_view_count BETWEEN 0 AND 1000',
        'change_count BETWEEN 0 AND 1000',
        'schema_version = 1',
        'ux_author_saved_view_active_name',
        'collection_revision = previous_collection_revision + 1',
        'DEFERRABLE INITIALLY DEFERRED'
    ]) {
        requireText(migration, invariant, 'saved view migration', errors);
    }
    if (/\bjsonb?\b|article_ids|permission_snapshot/i.test(migration)) {
        errors.push('saved view migration must remain relational and must not snapshot results or permissions');
    }

    requireText(catalog, 'AuthorSavedViewMigrationDefinitions.BuildMigration()', 'saved view catalog', errors);
    requireText(catalog, 'SchemaMigrationGapPolicy.AllowSparseVersions', 'saved view catalog', errors);

    for (const coverage of [
        'Authority_ReplaysCrudCasPinDefaultOrderRetireDeleteAndPrivacy',
        'Authority_TwoDevicesUseCollectionAndViewCasWithoutSilentLastWriteWins',
        'Authority_RejectsInvalidDependencyAndFutureAstBeforePersistence',
        'Authority_IdempotentReplaySurvivesLaterDependencyRetirement',
        'Authority_PagesZeroOneAndOneThousandAndBatchReordersInOneCommit',
        'Authority_MovesSingleAndBatchWithOneBoundedMutationAndCas',
        'Verifier_DetectsContentAndCollectionTamper',
        'Verifier_DetectsBidirectionalReceiptAndIdempotencyTamper',
        'Verifier_DetectsMissingReceiptAndBrokenCollectionRevisionChain',
        'Verifier_RejectsRehashedDefaultAndReorderSemanticTamper',
        'StaticGovernance_HasOneAuthorityAndClosedRelationalMigration'
    ]) {
        requireText(tests, coverage, 'saved view focused tests', errors);
    }

    for (const coverage of [
        'ProductionProvider_UsesTaxonomyAndFailsClosedForUnavailableUpstreams',
        'Persistence_PagesOneThousandAndBulkMovesWithOneAuditInsert'
    ]) {
        requireText(integration, coverage, 'saved view PostgreSQL tests', errors);
    }

    return errors;
}

function parseRoot(argv) {
    const index = argv.indexOf('--root');
    return index >= 0 ? path.resolve(argv[index + 1]) : process.cwd();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const errors = validateAuthorSavedViewStorageContract(parseRoot(process.argv.slice(2)));
    if (errors.length > 0) {
        for (const error of errors) console.error(`[author-saved-view-storage-contract] ${error}`);
        process.exitCode = 1;
    } else {
        console.log('[author-saved-view-storage-contract] ok');
    }
}
