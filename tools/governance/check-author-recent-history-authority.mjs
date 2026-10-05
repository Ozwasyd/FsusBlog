#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = Object.freeze({
    contract: 'src/backend/Services/Authoring/AuthorRecentArticleHistoryContracts.cs',
    store: 'src/backend/Services/Authoring/AuthorRecentArticleHistoryStore.cs',
    permission: 'src/backend/Services/Authoring/SqlAuthorRecentArticleHistoryPermissionAuthority.cs',
    projection: 'src/backend/Services/Authoring/AuthorRecentArticleHistoryProjectionService.cs',
    cursor: 'src/backend/Services/Authoring/AuthorRecentArticleHistoryCursorCodec.cs',
    facade: 'src/backend/Services/Authoring/AuthorRecentArticleHistoryApplicationFacade.cs',
    migration: 'src/migration/Definitions/AuthorRecentArticleHistoryMigrationDefinitions.cs',
    catalog: 'src/migration/Catalogs/SchemaMigrationCatalog20260915AuthorRecentHistory.cs',
    bootstrap: 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs',
    tests: 'tests/backend/Unit/AuthorRecentArticleHistoryContractTests.cs'
});

function read(repositoryRoot, relative, violations)
{
    const absolute = path.join(repositoryRoot, relative);
    if (!existsSync(absolute))
    {
        violations.push(`required authority file missing: ${relative}`);
        return '';
    }
    return readFileSync(absolute, 'utf8');
}

function requireText(source, expected, label, violations)
{
    if (!source.includes(expected))
    {
        violations.push(`${label} is missing ${expected}`);
    }
}

function walkSource(repositoryRoot)
{
    const roots = ['src/backend', 'src/frontend', 'src/shared', 'src/core'];
    const result = [];
    for (const relativeRoot of roots)
    {
        const absoluteRoot = path.join(repositoryRoot, relativeRoot);
        if (!existsSync(absoluteRoot))
        {
            continue;
        }
        const pending = [absoluteRoot];
        while (pending.length > 0)
        {
            const current = pending.pop();
            for (const entry of readdirSync(current, { withFileTypes: true }))
            {
                const absolute = path.join(current, entry.name);
                if (entry.isDirectory())
                {
                    if (!['bin', 'obj', 'node_modules', 'dist'].includes(entry.name))
                    {
                        pending.push(absolute);
                    }
                    continue;
                }
                if (entry.isFile() && /\.(?:cs|js|mjs|ts|tsx|vue)$/u.test(entry.name))
                {
                    result.push({
                        path: path.relative(repositoryRoot, absolute).split(path.sep).join('/'),
                        source: readFileSync(absolute, 'utf8')
                    });
                }
            }
        }
    }
    return result;
}

export function checkAuthorRecentHistoryAuthority(repositoryRoot = root)
{
    const violations = [];
    const source = Object.fromEntries(
        Object.entries(files).map(([key, relative]) => [key, read(repositoryRoot, relative, violations)]));
    if (violations.length > 0)
    {
        return violations;
    }

    const repositorySources = walkSource(repositoryRoot);
    const relevantSources = repositorySources.filter(candidate =>
        /AuthorRecentArticleHistory|author[_-]recent[_-]history|recent article history/iu.test(candidate.source));
    const forbiddenLocalAuthority =
        /\b(?:localStorage|sessionStorage|indexedDB|browser\.history|window\.history)\b/iu;
    const forbiddenFallback =
        /\b(?:article\.)?updatedAt\b[\s\S]{0,160}\b(?:fallback|recent|history)\b|\b(?:fallback|recent|history)\b[\s\S]{0,160}\b(?:article\.)?updatedAt\b/iu;
    const forbiddenClientMerge =
        /\b(?:merge|overwrite|hydrate|restore|sync|write|upsert)\w*Recent\w*History\w*(?:From)?(?:Client|Local|Offline)\b/iu;
    for (const candidate of relevantSources)
    {
        if (forbiddenLocalAuthority.test(candidate.source))
        {
            violations.push(`recent history source contains a browser-local authority: ${candidate.path}`);
        }
        if (forbiddenFallback.test(candidate.source))
        {
            violations.push(`recent history source contains an article.updatedAt fallback: ${candidate.path}`);
        }
        if (forbiddenClientMerge.test(candidate.source))
        {
            violations.push(`recent history source contains a client/offline authority merge: ${candidate.path}`);
        }
    }

    const allRuntimeSource = repositorySources.map(candidate => candidate.source).join('\n');
    if ((allRuntimeSource.match(/\b(?:sealed\s+)?class\s+\w*AuthorRecentArticleHistoryStore\b/gu) ?? []).length !== 1
        || !/class\s+AuthorRecentArticleHistoryStore[\s\S]*:\s*IAuthorRecentArticleHistoryStore/gu.test(source.store))
    {
        violations.push('recent history must have exactly one server store authority');
    }
    if ((source.bootstrap.match(/AddScoped<IAuthorRecentArticleHistoryStore,\s*AuthorRecentArticleHistoryStore>/gu) ?? []).length !== 1)
    {
        violations.push('recent history store must have exactly one runtime DI registration');
    }
    if (!/IAuthorRecentArticleHistoryMutationAuthorizer[\s\S]*SqlAuthorRecentArticleHistoryPermissionAuthority/gu.test(source.bootstrap)
        || !/IAuthorRecentArticleHistoryPermissionProjectionProvider[\s\S]*SqlAuthorRecentArticleHistoryPermissionAuthority/gu.test(source.bootstrap))
    {
        violations.push('recent history must use the production permission authority for writes and reads');
    }
    if (!/IAuthorRecentArticleHistoryProjectionCache[\s\S]*DirectAuthorRecentArticleHistoryProjectionCache/gu.test(source.bootstrap))
    {
        violations.push('recent history must register the direct server projection cache');
    }

    for (const required of [
        'SchemaVersion = 1',
        'MaxEntriesPerOwner = 1_000',
        'LastOpenedAtUtc',
        'LastEditedAtUtc',
        'LastActivatedAtUtc',
        'ServerRevision',
        'ValidateCursor',
        'ComputeReceiptDigest',
        'TryValidateSnapshot'
    ])
    {
        requireText(source.contract, required, 'closed recent history contract', violations);
    }
    for (const required of [
        'IDataProtectionProvider',
        'IDataProtector',
        'ProtectionPurpose',
        'TryDecode'
    ])
    {
        requireText(source.cursor, required, 'authenticated recent history cursor', violations);
    }
    if (/\b(?:Title|Slug|Route|Url|UpdatedAt|PublicRank|SearchRank)\b/u.test(source.contract))
    {
        violations.push('recent history contract contains article metadata or search identity');
    }

    for (const required of [
        'pg_advisory_xact_lock',
        'UseTranAsync',
        'author_recent_history_collection',
        'author_recent_history_entry',
        'author_recent_history_receipt',
        'author_recent_history_idempotency',
        'author_recent_history_outbox',
        'author_recent_history_audit',
        'RequireCurrentArticleAsync',
        'AuthorRecentArticleHistoryRevisionConflictException',
        'IdempotentReplay',
        'ValidateReceiptRow',
        'command_digest_mismatch',
        'durable_side_effect_missing'
    ])
    {
        requireText(source.store, required, 'recent history durable authority', violations);
    }
    const writes = [...source.store.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu)]
        .map(match => match[1].toLowerCase())
        .filter(table => table !== 'set');
    const foreignWrites = writes.filter(table => !table.startsWith('author_recent_history'));
    if (foreignWrites.length > 0)
    {
        violations.push(`recent history store writes outside its durable tables: ${[...new Set(foreignWrites)].join(', ')}`);
    }

    for (const required of [
        'CREATE TABLE IF NOT EXISTS author_recent_history_collection',
        'CREATE TABLE IF NOT EXISTS author_recent_history_entry',
        'CREATE TABLE IF NOT EXISTS author_recent_history_receipt',
        'CREATE TABLE IF NOT EXISTS author_recent_history_idempotency',
        'CREATE TABLE IF NOT EXISTS author_recent_history_outbox',
        'CREATE TABLE IF NOT EXISTS author_recent_history_audit',
        'schema_version = 1',
        'revision = previous_revision + 1',
        'ON DELETE RESTRICT',
        "status = 'committed'"
    ])
    {
        requireText(source.migration, required, 'recent history migration', violations);
    }
    requireText(source.catalog, 'AuthorRecentArticleHistoryMigrationDefinitions.BuildMigration()', 'recent history catalog', violations);
    requireText(source.projection, 'permissionProvider.ResolveAsync', 'independent permission verifier', violations);
    for (const required of [
        'MatchesVerifiedSnapshot(snapshot, verification)',
        'MatchesVerifiedSnapshot(snapshot, authority)',
        'verification.Valid',
        'verification.Revision == snapshot.Revision',
        'verification.ItemCount == snapshot.ItemCount',
        'verification.ContentDigest,',
        'snapshot.ContentDigest,',
        'permission.Decisions.Any(static decision => !decision.CanProject)'
    ])
    {
        requireText(source.projection, required, 'independent permission verifier', violations);
    }
    requireText(source.projection, 'DirectAuthorRecentArticleHistoryProjectionCache', 'projection cache consistency', violations);
    requireText(source.projection, 'TryValidateProjectionPage', 'projection cache consistency', violations);
    requireText(source.projection, 'cache.PublishAsync', 'projection cache consistency', violations);
    requireText(
        source.projection,
        'author_recent_history_projection_cache_unavailable',
        'projection cache fail-closed behavior',
        violations);
    requireText(source.tests, 'ClosedSchema_UsesOnlyStableServerArticleIdentity', 'recent history focused tests', violations);
    requireText(source.tests, 'Verifier_RejectsTamperAndMissingSideEffects', 'recent history focused tests', violations);
    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkAuthorRecentHistoryAuthority();
    if (violations.length > 0)
    {
        console.error('[author-recent-history-authority] failed');
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log('[author-recent-history-authority] passed: one server authority, closed identity, CAS, durable receipts and static local-fallback governance');
    }
}
