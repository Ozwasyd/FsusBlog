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

test('mutations reject second/local/metadata/public and per-item authorities', () =>
{
    const mutations = [
        ['src/backend/Services/Authoring/AuthorArticlePinStore.cs', '\nsealed class ShadowAuthorArticlePinStore {}\n', 'exact-one article pin store'],
        ['src/backend/Services/Authoring/AuthorArticlePinContracts.cs', '\nsealed record BadPin(string Title, string Slug, int ArrayIndex);\n', 'title/slug/url/source/index/display identity'],
        ['src/backend/Services/Authoring/AuthorArticlePinStore.cs', '\n// localStorage FavoriteTag Hotness\n', 'browser-local pin authority'],
        ['src/backend/Services/Authoring/AuthorArticlePinStore.cs', '\n// UPDATE article SET views = views + 1;\n', 'non-pin writes are forbidden']
    ];
    for (const [relative, suffix, expected] of mutations)
    {
        withFixture(
            (temporary) => writeFileSync(
                path.join(temporary, relative),
                readFileSync(path.join(temporary, relative), 'utf8') + suffix),
            (violations) => assert.ok(violations.some((violation) => violation.includes(expected)), violations.join('\n')));
    }

    withFixture(
        (temporary) =>
        {
            const file = path.join(temporary, 'src/backend/Services/Authoring/AuthorArticlePinStore.cs');
            writeFileSync(file, readFileSync(file, 'utf8').replace('SET order_key = CASE article_id', 'SET order_key = order_key'));
        },
        (violations) => assert.ok(violations.some((violation) => violation.includes('bounded set-based update'))));
});
