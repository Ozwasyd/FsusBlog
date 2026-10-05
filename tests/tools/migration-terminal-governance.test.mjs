import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function check(root, args = [])
{
    return spawnSync(process.execPath, [checker, '--root', root, ...args], { encoding: 'utf8' });
}

test('canonical terminal graph alone does not qualify terminal acceptance', t =>
{
    const result = check(fixture(t));
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /graph:|source:|current-schema-authority:|shared current contract/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
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

test('missing publish and executable observations cannot qualify terminal acceptance', t =>
{
    const result = check(fixture(t));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish: no published output was observed/);
    assert.match(result.stderr, /providers: executable PostgreSQL, MySQL and SQLite observations are missing/);
    assert.match(result.stderr, /mutation: terminal mutation results were not observed/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
    assert.doesNotMatch(result.stdout, /ok graph/);
});

test('incomplete observations cannot write an acceptance receipt', t =>
{
    const root = fixture(t);
    mkdirSync(join(root, '.tmp/publish'), { recursive: true });
    const result = check(root, ['--write']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publish: published output is empty/);
    assert.match(result.stderr, /benchmark: not-evaluable cannot qualify terminal acceptance/);
    assert.equal(existsSync(join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json')), false);
});
