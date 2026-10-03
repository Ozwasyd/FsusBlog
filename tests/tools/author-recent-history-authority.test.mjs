import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkAuthorRecentHistoryAuthority } = await import(new URL('../../tools/governance/check-author-recent-history-authority.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const owned = [
    'src/backend/Services/Authoring/AuthorRecentArticleHistoryContracts.cs',
    'src/backend/Services/Authoring/AuthorRecentArticleHistoryStore.cs',
    'src/backend/Services/Authoring/SqlAuthorRecentArticleHistoryPermissionAuthority.cs',
    'src/backend/Services/Authoring/AuthorRecentArticleHistoryProjectionService.cs',
    'src/backend/Services/Authoring/AuthorRecentArticleHistoryCursorCodec.cs',
    'src/backend/Services/Authoring/AuthorRecentArticleHistoryApplicationFacade.cs',
    'src/migration/Definitions/AuthorRecentArticleHistoryMigrationDefinitions.cs',
    'src/migration/Catalogs/SchemaMigrationCatalog20260915AuthorRecentHistory.cs',
    'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs',
    'tests/backend/Unit/AuthorRecentArticleHistoryContractTests.cs'
];

function fixture()
{
    const target = mkdtempSync(path.join(os.tmpdir(), 'author-recent-history-authority-'));
    for (const relative of owned)
    {
        const destination = path.join(target, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(root, relative), destination);
    }
    return target;
}

function mutate(target, relative, transform)
{
    const absolute = path.join(target, relative);
    writeFileSync(absolute, transform(readFileSync(absolute, 'utf8')));
}

test('current recent history authority satisfies exact-one static governance', () =>
{
    assert.deepEqual(checkAuthorRecentHistoryAuthority(root), []);
});

test('static governance rejects a second store and browser-local fallback', () =>
{
    const target = fixture();
    try
    {
        const secondStore = path.join(
            target,
            'src/backend/Services/Authoring/ReplicaAuthorRecentArticleHistoryStore.cs');
        writeFileSync(
            secondStore,
            'public sealed class ReplicaAuthorRecentArticleHistoryStore : IAuthorRecentArticleHistoryStore { }\n');
        const frontendFallback = path.join(target, 'src/frontend/recent-history.ts');
        mkdirSync(path.dirname(frontendFallback), { recursive: true });
        writeFileSync(
            frontendFallback,
            'export const AuthorRecentArticleHistory = localStorage.getItem("recent");\n');
        const errors = checkAuthorRecentHistoryAuthority(target);
        assert.ok(errors.some(error => error.includes('exactly one server store authority')));
        assert.ok(errors.some(error => error.includes('browser-local authority')));
    }
    finally
    {
        rmSync(target, { recursive: true, force: true });
    }
});

test('static governance rejects non-history writes and weakened relational migration', () =>
{
    const target = fixture();
    try
    {
        mutate(target, owned[1], source => source.replace(
            'INSERT INTO author_recent_history_entry',
            'UPDATE article SET views = views + 1;\nINSERT INTO author_recent_history_entry'));
        mutate(target, owned[6], source => source.replace(
            "status = 'committed'",
            "status = 'pending'"));
        const errors = checkAuthorRecentHistoryAuthority(target);
        assert.ok(errors.some(error => error.includes('writes outside its durable tables')));
        assert.ok(errors.some(error => error.includes("status = 'committed'")));
    }
    finally
    {
        rmSync(target, { recursive: true, force: true });
    }
});

test('static governance rejects a contract that adds metadata or search identity', () =>
{
    const target = fixture();
    try
    {
        mutate(target, owned[0], source => source.replace(
            'public sealed record AuthorRecentArticleHistoryEntry(',
            'public sealed record AuthorRecentArticleHistoryEntry(string Title,'));
        const errors = checkAuthorRecentHistoryAuthority(target);
        assert.ok(errors.some(error => error.includes('metadata or search identity')));
    }
    finally
    {
        rmSync(target, { recursive: true, force: true });
    }
});

test('static governance rejects a bypassed projection cache publication', () =>
{
    const target = fixture();
    try
    {
        mutate(target, owned[3], source => source.replace(
            'cache.PublishAsync(',
            'cache.PublishBypassAsync('));
        const errors = checkAuthorRecentHistoryAuthority(target);
        assert.ok(errors.some(error => error.includes('cache.PublishAsync')));
    }
    finally
    {
        rmSync(target, { recursive: true, force: true });
    }
});
