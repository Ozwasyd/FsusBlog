import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkAuthorArticlePinProjection } = await import(new URL('../../tools/governance/check-author-article-pin-projection.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');

function withFixture(mutate, verify)
{
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-article-pin-projection-'));
    try
    {
        for (const relative of [
            'src/backend/Services/Authoring/AuthorArticlePinProjectionContracts.cs',
            'src/backend/Services/Authoring/AuthorArticlePinProjectionService.cs',
            'src/backend/Services/Authoring/AuthorArticlePinProjectionVerifier.cs',
            'src/backend/Services/Authoring/SqlAuthorArticlePinArticleProjectionSource.cs'
        ])
        {
            const destination = path.join(temporary, relative);
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(path.join(root, relative), destination);
        }
        mutate(temporary);
        verify(checkAuthorArticlePinProjection(temporary));
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
}

test('current article pin projection passes exact-one privacy governance', () =>
{
    assert.deepEqual(checkAuthorArticlePinProjection(root), []);
});

test('governance rejects executable client filtering, local ordering, rebind and public ranking mutations', () =>
{
    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/frontend/src/data/articlePins.ts');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `
export function articlePins(items) {
  return items.filter(item => item.CanProject).sort((left, right) => right.PublicRank - left.PublicRank)
}
`);
        },
        (violations) =>
        {
            assert.ok(violations.some((violation) => violation.includes('client-side article pin permission filtering')), violations.join('\n'));
            assert.ok(violations.some((violation) => violation.includes('client-side article pin reorder')), violations.join('\n'));
            assert.ok(violations.some((violation) => violation.includes('public ranking/hotness pin signal')), violations.join('\n'));
        });

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/frontend/src/data/articlePins.ts');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `
export function rebindArticlePin(pin, articles) {
  return articles.find(article => article.Title === pin.Title || article.Slug === pin.Slug)
}
`);
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('title/slug article pin rebind')), violations.join('\n')));
});

test('governance rejects second projection, caller permission, metadata order and non-batch identity mutations', () =>
{
    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AlternateAuthorArticlePinProjectionService.cs');
            writeFileSync(file, 'sealed class AlternateAuthorArticlePinProjectionService {}\n');
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('exact-one article pin projection service')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Modules/Endpoints/AlternateArticlePinEndpoints.cs');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, `
app.MapGet("/api/binary/author/article-pins", ReadPins);
app.MapGet("/api/author/article-pins/secondary", ReadPinsAgain);
`);
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('at most one transport route')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinProjectionContracts.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'int Limit = AuthorArticlePinProjectionContract.DefaultPageSize,',
                'int Limit = AuthorArticlePinProjectionContract.DefaultPageSize, bool HasPermission = false,'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('caller-provided permission decisions')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinProjectionContracts.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'int Limit = AuthorArticlePinProjectionContract.DefaultPageSize,',
                'int Limit = AuthorArticlePinProjectionContract.DefaultPageSize, int Views = 0,'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('public ranking/hotness projection')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinProjectionService.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'OrderBy(static pin => pin.OrderKey)',
                'OrderBy(static pin => pin.ArticleId)'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('server pin ordering')), violations.join('\n')));

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/SqlAuthorArticlePinArticleProjectionSource.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace(
                'WHERE a.id = ANY(CAST(@ArticleIds AS integer[]))',
                'WHERE a.title = ANY(CAST(@ArticleIds AS integer[]))'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('stable-id batch query')), violations.join('\n')));
});
