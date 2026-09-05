import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkAuthorArticlePinAuthority } from '../../tools/governance/check-author-article-pin-authority.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function withFixture(mutate, verify)
{
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-article-pin-authority-'));
    try
    {
        const files = [
            'src/backend/Services/Authoring/AuthorArticlePinStore.cs',
            'src/backend/Services/Authoring/AuthorArticlePinContracts.cs',
            'src/migration/Definitions/AuthorArticlePinMigrationDefinitions.cs',
            'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs'
        ];
        for (const relative of files)
        {
            const destination = path.join(temporary, relative);
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(path.join(root, relative), destination, { recursive: true });
        }
        mutate(temporary);
        verify(checkAuthorArticlePinAuthority(temporary));
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
}

test('current article pin authority passes exact-one static governance', () =>
{
    assert.deepEqual(checkAuthorArticlePinAuthority(root), []);
});

test('static scanner rejects executable source-shape mutations to pin authority boundaries', () =>
{
    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AlternateAuthorArticlePinStore.cs');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `
namespace FsusBlog.Server.Services.Authoring;
sealed class AlternateAuthorArticlePinStore
{
    private readonly Dictionary<int, long> _orderByArticle = new();
    public void Add(int articleId) => _orderByArticle.Add(articleId, _orderByArticle.Count + 1);
}
`);
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('exact-one article pin store')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinContracts.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'public sealed record AuthorArticlePin(\n    Guid PinId,',
                'public sealed record AuthorArticlePin(\n    Guid PinId,\n    string Title,\n    string Slug,'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('title/slug/url/source/index/display identity')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/frontend/src/data/authorArticlePinAuthority.ts');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `
export function persistPinOrder(articleIds: number[]): void {
  localStorage.setItem('article-pins', JSON.stringify(articleIds))
}
`);
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('browser-local pin authority')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinStore.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'DELETE FROM author_article_pin\n                WHERE owner_admin_principal_id',
                'UPDATE article SET views = views + 1\n                WHERE owner_admin_principal_id'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('non-pin writes are forbidden')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinContracts.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'string ContentDigest);',
                'string ContentDigest, int PublicRank);'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('favorite/public-ranking metadata authority')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinStore.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace('SET order_key = CASE article_id', 'SET order_key = order_key'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('bounded set-based update'))));
});

test('static scanner scope is source authority shape; PostgreSQL verifier owns runtime replay and tamper semantics', () =>
{
    assert.deepEqual(checkAuthorArticlePinAuthority(root), []);
});
