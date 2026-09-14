import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-offline-migration-catalog-parity.mjs');
const fixturePaths = [
    'src/backend/Infrastructure/SchemaMigration/OnlineSchemaMigrationMetadata.cs',
    'src/migration/OfflineMigrationCatalogEntries.generated.cs',
    'src/migration/Definitions'
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-offline-catalog-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of fixturePaths)
    {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    return root;
}

function mutate(root, path, transform)
{
    const fullPath = join(root, path);
    const source = readFileSync(fullPath, 'utf8');
    writeFileSync(fullPath, transform(source));
}

function check(root)
{
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
}

test('offline classification table matches the authoritative catalog register', t =>
{
    const root = fixture(t);
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[offline-migration-catalog-parity\] ok/);
});

test('stale source digest header is rejected (classification drift)', t =>
{
    const root = fixture(t);
    mutate(root, 'src/migration/OfflineMigrationCatalogEntries.generated.cs', source =>
        source.replace(/(Source digest: sha256:)[0-9a-f]{64}/, '$1' + '0'.repeat(64)));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source digest drift/);
});

test('a migration missing from the classification table is rejected', t =>
{
    const root = fixture(t);
    mutate(root, 'src/migration/OfflineMigrationCatalogEntries.generated.cs', source =>
        source.replace(/result\.Add\("20260724-post-plugin-registry",/u, '').replace(/result\.Add\("20260724-post-plugin-registry"([^\n]*)\n/u, ''));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /migration 20260724-post-plugin-registry is missing/);
});
