import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { validateArticleBulkAuthorities } = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/governance/check-article-bulk-authorities.mjs'
)).href);
const registryPath = 'src/backend/Services/Articles/Bulk/ArticleBulkOperationRegistry.cs';
const ownersPath = 'src/backend/Services/Articles/Bulk/ArticleBulkCanonicalCommandOwners.cs';

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-bulk-authority-'));
    for (const relativePath of [registryPath, ownersPath])
    {
        const destination = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relativePath), destination);
    }
    return root;
}

test('repository authority scan is exact', () =>
{
    const result = validateArticleBulkAuthorities(repositoryRoot);
    assert.deepEqual(result.errors, []);
    assert.equal(result.operations, 14);
    assert.equal(result.owners, 8);
});

test('scanner rejects registry owner and unregistered command drift', () =>
{
    const root = fixture();
    try
    {
        const registry = fs.readFileSync(path.join(root, registryPath), 'utf8')
            .replace('"article-category-command"', '"wrong-category-command"');
        fs.writeFileSync(path.join(root, registryPath), registry);
        const owners = fs.readFileSync(path.join(root, ownersPath), 'utf8')
            .replace('["search.reindex"]', '["search.reindex", "body.replace"]');
        fs.writeFileSync(path.join(root, ownersPath), owners);

        const result = validateArticleBulkAuthorities(root);
        assert.ok(result.errors.includes('owner mismatch for category.add'));
        assert.ok(result.errors.includes('unregistered operation owned by canonical command: body.replace'));
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('scanner rejects parallel production authority declarations', () =>
{
    const root = fixture();
    try
    {
        const parallelAuthorityPath = path.join(
            root,
            'src/backend/Services/Articles/Bulk/ParallelArticleBulkAuthority.cs'
        );
        fs.writeFileSync(
            parallelAuthorityPath,
            'new ArticleBulkCanonical' + 'CommandOwner("parallel", default, default);\n'
                + 'const string Schema = "fsusblog.article-bulk.operation-registry.v2";\n'
        );

        const result = validateArticleBulkAuthorities(root);
        assert.ok(result.errors.includes(
            'canonical owner declaration outside sole catalog: '
                + 'src/backend/Services/Articles/Bulk/ParallelArticleBulkAuthority.cs'
        ));
        assert.ok(result.errors.includes(
            'second operation registry schema declaration: '
                + 'src/backend/Services/Articles/Bulk/ParallelArticleBulkAuthority.cs'
        ));
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
