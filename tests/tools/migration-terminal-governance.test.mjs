import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-migration-terminal-governance.mjs');
const fixturePaths = [
    'src/backend/FsusBlog.Server.csproj',
    'src/backend/Infrastructure/SchemaMigration',
    'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs',
    'src/migration',
    'src/shared'
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-terminal-gov-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of fixturePaths)
    {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    return root;
}

function check(root)
{
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
}

test('canonical terminal graph is accepted', t =>
{
    const result = check(fixture(t));
    assert.equal(result.status, 0, result.stderr);
});

test('Server→Migration and Migration→Server are rejected', t =>
{
    const root = fixture(t);
    writeFileSync(
        join(root, 'src/backend/FsusBlog.Server.csproj'),
        `${readFileSync(join(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8')}\n<ProjectReference Include="../migration/FsusBlog.Migration.csproj" />\n`);
    writeFileSync(
        join(root, 'src/migration/FsusBlog.Migration.csproj'),
        `${readFileSync(join(root, 'src/migration/FsusBlog.Migration.csproj'), 'utf8')}\n<ProjectReference Include="../backend/FsusBlog.Server.csproj" />\n`);
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Server → Migration/);
    assert.match(result.stderr, /Migration → Server/);
});

test('shared legacy column and type-forwarder are rejected', t =>
{
    const root = fixture(t);
    writeFileSync(join(root, 'src/shared/LegacyLeak.cs'), 'public sealed class LegacyLeak { public string LastUsernameUpdateTime { get; set; } = ""; }\n');
    writeFileSync(
        join(root, 'src/migration/Forwarder.cs'),
        'using System.Runtime.CompilerServices;\n[assembly: TypeForwardedTo(typeof(string))]\nnamespace FsusBlog.Server.Infrastructure.SchemaMigration;\n');
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy column/);
    assert.match(result.stderr, /type-forwarder or compat namespace/);
});
