import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateRuntimeTables, migrationPath, persistencePath } from '../generate-authoring-workspace-snapshot-runtime-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const persistence = readFileSync(path.join(root, persistencePath), 'utf8');
const migration = readFileSync(path.join(root, migrationPath), 'utf8');

test('exact PostgreSQL offer generates one bounded runtime table deterministically', () =>
{
    const first = generateRuntimeTables(persistence, migration);
    assert.deepEqual(first, generateRuntimeTables(persistence, migration));
    assert.equal((first.code.match(/new\("authoring_workspace_snapshot"/gu) ?? []).length, 1);
    assert.equal(first.receipt.table, 'authoring_workspace_snapshot');
    assert.match(first.receipt.normalizedSqlDigest, /^[a-f0-9]{64}$/u);
});

for (const [name, before, after] of [
    ['FK', 'REFERENCES admin_principal(id) ON DELETE CASCADE', ''],
    ['scope key', 'PRIMARY KEY (user_id, site_id, workspace_id)', 'PRIMARY KEY (user_id)'],
    ['default workspace', "CHECK (workspace_id = 'default')", "CHECK (workspace_id = 'other')"],
    ['JS-safe CAS', '9007199254740991', '9223372036854775807'],
    ['64 KiB limit', '65536', '1048576']
])
{
    test(`refuses ${name} drift in migration and simultaneous owner drift`, () =>
    {
        assert.throws(() => generateRuntimeTables(persistence, migration.replace(before, after)), /sql_offer_drift/u);
        assert.throws(() => generateRuntimeTables(persistence.replace(before, after), migration.replace(before, after)), /bounded_single_row_required/u);
    });
}

test('refuses additional SQL, duplicate owners and missing idempotent migration', () =>
{
    assert.throws(() => generateRuntimeTables(persistence, migration.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')), /sql_offer_drift/u);
    assert.throws(() => generateRuntimeTables(persistence + persistence, migration), /sql_owner_required/u);
    assert.throws(() => generateRuntimeTables(persistence, migration + migration), /sql_owner_required/u);
    const add = source => source.replace(');\n', ');\nDROP TABLE article;\n');
    assert.throws(() => generateRuntimeTables(add(persistence), add(migration)), /bounded_single_row_required/u);
});
