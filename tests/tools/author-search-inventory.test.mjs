import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createAuthorSearchInventory, verifyAuthorSearchInventory } = await import(
    new URL('../../tools/governance/author-search-inventory.mjs', import.meta.url)
);

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'author-search-inventory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const run = args =>
    {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    run(['init', '-q']);
    run(['-c', 'user.name=Inventory Test', '-c', 'user.email=inventory@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    const write = (file, source) =>
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
    };
    return { root, run, write };
}

test('discovers renamed, new, backend, frontend, contract, migration, test, doc and script candidates', t =>
{
    const { root, write } = fixture(t);
    const sources = {
        'src/backend/new-owner/read.cs': 'var sql = "revision.title ILIKE @Keyword";',
        'src/frontend/src/new-domain/filter.ts': 'article.content.includes(queryText);',
        'src/shared/Contracts/new.cs': 'record ArticleSearchQuery(string Keyword);',
        'src/migration/Definitions/new.sql': 'SELECT title FROM article WHERE title LIKE @keyword;',
        'tests/new.ts': 'test("legacy search denial");',
        'docs/new.md': '# 全文搜索\nSearch query grammar',
        'package.json': '{"scripts":{"check:search":"node new/search.mjs"}}',
        'config/new.json': '{"searchRoute":"/admin/search"}',
        'tools/renamed.mjs': 'const titleIndex = new Map();'
    };
    for (const [file, source] of Object.entries(sources))
    {
        write(file, source);
    }
    const report = createAuthorSearchInventory(root);
    assert.deepEqual(report.files.map(file => file.path).sort(), Object.keys(sources).sort());
    for (const file of Object.keys(sources))
    {
        assert.ok(report.findings.some(finding => finding.path === file), file);
    }
    assert.ok(report.findings.some(finding => finding.signal === 'database-pattern'));
    assert.ok(report.findings.some(finding => finding.signal === 'field-client-match'));
    assert.equal(report.qualification, false);
    assert.ok(report.reviewRequired > 0);
    assert.equal(verifyAuthorSearchInventory(report, root), true);
});

test('proposes distinct owners and keeps mixed sources unresolved', t =>
{
    const { root, write } = fixture(t);
    write('src/frontend/src/new/List.vue', '<CollectionWorkbench><ElInput aria-label="搜索文章标题" /></CollectionWorkbench>');
    write('src/frontend/src/new/Quick.vue', 'const mode = "quick-switcher";');
    write('src/frontend/src/new/Content.vue', 'const mode = "global-author-search";');
    write('src/backend/Shared.cs', 'const owners = ["quick-switcher", "global-author-search"];');
    write('src/backend/Public.cs', 'const owner = "public-search";');
    const report = createAuthorSearchInventory(root);
    const classification = file => report.findings.find(finding => finding.path.endsWith(file)).classification;
    assert.equal(classification('List.vue'), 'admin-collection-filter');
    assert.equal(classification('Quick.vue'), 'article-entity-navigation');
    assert.equal(classification('Content.vue'), 'author-content-search');
    assert.equal(classification('Shared.cs'), 'mixed-or-shared');
    assert.equal(classification('Public.cs'), 'public-search');
    assert.equal(report.findings.find(finding => finding.path.endsWith('Shared.cs')).owner, null);
});

test('finds database/client/DOM/durable/fallback mutations without exposing query or source', t =>
{
    const { root, write } = fixture(t);
    const secret = 'PRIVATE_QUERY_DO_NOT_OUTPUT';
    write('src/frontend/src/renamed.ts', [
        `const keyword = "${secret}";`,
        'const searchResult = allArticles.filter(article => article.markdown.includes(keyword));',
        'const snippet = preview.textContent;',
        'localStorage.setItem("titleIndex", keyword);',
        'const fallback = legacyTitleSearch(keyword);',
        'const scan = article.title',
        '    .includes(keyword);'
    ].join('\n'));
    write('src/backend/renamed.cs', [
        'var query = "SELECT * FROM article WHERE content LIKE @Keyword OR title ILIKE @Keyword";',
        'var local = article.Content.Contains(keyword);',
        'var regex = Regex.IsMatch(article.Body, keyword);'
    ].join('\n'));
    const report = createAuthorSearchInventory(root);
    for (const signal of ['database-pattern', 'field-client-match', 'field-pattern-call', 'client-corpus', 'rendered-search', 'durable-client-state', 'fallback-reference'])
    {
        assert.ok(report.findings.some(finding => finding.signal === signal), signal);
    }
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(report.findings.some(finding => finding.line === 6 && finding.signal === 'field-client-match'));
});

test('tamper, omitted file, changed bytes and newly introduced entrypoint invalidate old inventory', t =>
{
    const { root, write } = fixture(t);
    write('src/new.ts', 'const search = "one";');
    const report = createAuthorSearchInventory(root);
    const changed = structuredClone(report);
    changed.findings[0].owner = '#2319';
    assert.equal(verifyAuthorSearchInventory(changed, root), false);
    assert.equal(verifyAuthorSearchInventory({ ...report, findings: [] }, root), false);
    write('src/new.ts', 'const search = "two";');
    assert.equal(verifyAuthorSearchInventory(report, root), false);
    const updated = createAuthorSearchInventory(root);
    write('src/new-route.ts', 'const keyword = "three";');
    assert.equal(verifyAuthorSearchInventory(updated, root), false);
});

test('does not follow symlinks or silently omit binary/deleted paths', t =>
{
    const { root, run, write } = fixture(t);
    write('src/deleted.ts', 'const search = true;');
    run(['add', 'src/deleted.ts']);
    fs.rmSync(path.join(root, 'src/deleted.ts'));
    write('src/binary.bin', Buffer.from([0, 255, 0]));
    fs.symlinkSync('/etc/passwd', path.join(root, 'src/search-link'));
    fs.symlinkSync('/etc', path.join(root, 'src/escape'));
    run(['update-index', '--add', '--cacheinfo', '100644', run(['hash-object', '-w', '--stdin']).trim(), 'src/escape/passwd']);
    const report = createAuthorSearchInventory(root);
    assert.equal(report.files.find(file => file.path === 'src/deleted.ts').status, 'deleted');
    assert.equal(report.files.find(file => file.path === 'src/binary.bin').status, 'binary');
    assert.equal(report.files.find(file => file.path === 'src/search-link').status, 'nonregular-review-required');
    assert.equal(report.files.find(file => file.path === 'src/escape/passwd').status, 'nonregular-review-required');
    assert.equal(report.nonregularFiles, 3);
    assert.ok(!report.findings.some(finding => finding.path === 'src/search-link'));
});

test('actual repository inventory covers admin UI, query parameters and shared DB patterns honestly', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const report = createAuthorSearchInventory(root);
    const admin = report.findings.filter(finding => finding.path === 'src/frontend/src/views/admin/article/List.vue');
    assert.ok(admin.length > 0);
    assert.ok(admin.every(finding => finding.classification === 'admin-collection-filter'));
    assert.ok(report.findings.some(finding => finding.path === 'src/frontend/src/api/article.ts' && finding.signal === 'query-parameter'));
    assert.ok(report.findings.some(finding => finding.path === 'src/backend/Services/ArticleService.LifecycleAndReadModels.cs' && finding.signal === 'database-pattern'));
    assert.ok(report.files.some(file => file.path === 'src/frontend/src/services/localSearch.ts' && file.status === 'scanned'));
    assert.equal(verifyAuthorSearchInventory(report, root), true);
});


test('accepts canonical Git roots but rejects partial subdirectories before inventory or verification', t =>
{
    const { root, write } = fixture(t);
    write('src/outer-search.ts', 'const search = "outer";');
    write('nested/inner-search.ts', 'const search = "inner";');
    const rootLink = `${root}-root-link`;
    const nestedLink = `${root}-nested-link`;
    fs.symlinkSync(root, rootLink, 'dir');
    fs.symlinkSync(path.join(root, 'nested'), nestedLink, 'dir');
    t.after(() =>
    {
        fs.rmSync(rootLink, { force: true });
        fs.rmSync(nestedLink, { force: true });
    });

    const report = createAuthorSearchInventory(root);
    assert.deepEqual(report.files.map(file => file.path), ['nested/inner-search.ts', 'src/outer-search.ts']);
    assert.deepEqual(createAuthorSearchInventory(rootLink), report);
    assert.equal(verifyAuthorSearchInventory(report, rootLink), true);

    const cliPath = path.resolve(import.meta.dirname, '../../tools/governance/author-search-inventory.mjs');
    for (const requestedRoot of [path.join(root, 'nested'), nestedLink])
    {
        assert.throws(() => createAuthorSearchInventory(requestedRoot), {
            message: 'author-search-inventory-repository-root-required'
        });
        assert.throws(() => verifyAuthorSearchInventory(report, requestedRoot), {
            message: 'author-search-inventory-repository-root-required'
        });
        const result = spawnSync(process.execPath, [cliPath, requestedRoot], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /author-search-inventory-repository-root-required/u);
    }
});
