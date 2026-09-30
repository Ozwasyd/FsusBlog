import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const documentPath = 'docs/database-migration.md';
const fixturePaths = [
    documentPath,
    'src/migration/SchemaMigrationRegistry.cs',
    'src/migration/SchemaMigrationManifest.cs',
    'src/migration/Definitions',
    'src/migration/Catalogs',
    'tools/db/migration-doc-lint.mjs'
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-migration-doc-lint-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const relative of fixturePaths)
    {
        const destination = join(root, relative);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repositoryRoot, relative), destination, { recursive: true });
    }
    return root;
}

function mutateDocument(root, transform)
{
    const absolute = join(root, documentPath);
    const source = readFileSync(absolute, 'utf8');
    const changed = transform(source);
    assert.notEqual(changed, source, 'mutation must change the current document');
    writeFileSync(absolute, changed);
}

function check(root)
{
    return spawnSync(process.execPath, [join(root, 'tools/db/migration-doc-lint.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_REPO_ROOT: root }
    });
}

test('current final-state heading and complete migration table pass', (t) =>
{
    const result = check(fixture(t));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migration-doc-lint passed: 24 legacy identity fields checked/u);
});

test('historical anchor without the current heading is not a table', (t) =>
{
    const root = fixture(t);
    mutateDocument(root, (source) => source.replace('## Final-state field table', '## Historical field inventory'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /缺少 "## Final-state field table" 标题/u);
});

test('the former Chinese heading does not silently replace the current authority', (t) =>
{
    const root = fixture(t);
    mutateDocument(root, (source) => source.replace('## Final-state field table', '## 字段最终态表'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /缺少 "## Final-state field table" 标题/u);
});

test('a missing final-state row still fails closed', (t) =>
{
    const root = fixture(t);
    mutateDocument(root, (source) => source.split('\n')
        .filter((line) => !line.startsWith('| `sys_user.username` |'))
        .join('\n'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /字段最终态表缺少 sys_user\.username/u);
});

test('a final-state value drift still fails closed', (t) =>
{
    const root = fixture(t);
    mutateDocument(root, (source) => source.replace(
        '| `sys_user.username` | dropped |',
        '| `sys_user.username` | present |'));
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sys_user\.username 的 physical 不一致/u);
});

test('workflow root inheritance cannot redirect a refusal fixture', () =>
{
    const environment = { ...process.env, FSUSBLOG_REPO_ROOT: repositoryRoot };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern=^a missing final-state row still fails closed$',
        fileURLToPath(import.meta.url)
    ], {
        encoding: 'utf8',
        env: environment
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pass 1\b/u);
    assert.match(result.stdout, /fail 0\b/u);
});
