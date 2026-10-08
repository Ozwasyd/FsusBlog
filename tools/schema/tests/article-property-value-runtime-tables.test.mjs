import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateRuntimeTables } from '../generate-article-property-value-runtime-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(path.join(root, 'src/migration/Definitions/ArticlePropertyValueMigrationDefinitions.cs'), 'utf8');

test('preserves every SQL statement byte for byte while separating tables and indexes', () =>
{
    const result = generateRuntimeTables(source);
    const raw = source.match(/new RawSqlStep\("""([\s\S]+?)"""\)/u)[1];
    const original = raw.replace(/^\n/u, '').replace(/\n +$/u, '').split('\n').map(line => line.slice(20)).join('\n');
    assert.equal(result.statements.join('\n'), original);
    assert.deepEqual(result.tables.map(table => table.name), [
        'article_property_value_factset', 'article_property_value_entry', 'article_property_value_option',
        'article_property_value_reference', 'article_property_value_snapshot', 'article_property_value_head',
        'article_property_value_receipt'
    ]);
    assert.equal(result.tables.flatMap(table => table.additionalSql).length, 3);
    assert.ok(result.tables.every(table => !table.sql.includes('CREATE INDEX') && !table.sql.includes('CREATE UNIQUE INDEX')));
    assert.deepEqual([...result.tables.map(table => table.sql), ...result.tables.flatMap(table => table.additionalSql)].sort(), result.statements.toSorted());
    assert.deepEqual(result, generateRuntimeTables(source));
    for (const table of result.tables)
        assert.ok(result.code.includes(table.sql.split('\n').map(line => `            ${line}`).join('\n')));
});

test('refuses missing, duplicate and additional table definitions', () =>
{
    assert.throws(() => generateRuntimeTables(source.replace('CREATE TABLE IF NOT EXISTS article_property_value_receipt (', 'CREATE TABLE IF NOT EXISTS article_property_value_head (')), /table_set_invalid/u);
    assert.throws(() => generateRuntimeTables(source.replace('CREATE TABLE IF NOT EXISTS article_property_value_receipt (', 'CREATE TABLE IF NOT EXISTS foreign_receipt (')), /table_set_invalid/u);
    assert.throws(() => generateRuntimeTables(source + source), /migration_sql_missing/u);
});

test('refuses unknown or unterminated SQL without dropping statements', () =>
{
    assert.throws(() => generateRuntimeTables(source.replace('CREATE INDEX IF NOT EXISTS ix_article_property_value_target', 'DROP INDEX IF EXISTS ix_article_property_value_target')), /unowned_sql_statement/u);
    assert.throws(() => generateRuntimeTables(source.replace('ON article_property_value_reference(target_article_id', 'ON missing_table(target_article_id')), /unowned_sql_statement/u);
    const unterminated = source.replace(/\);\n(\s+"""\))/u, ')\n$1');
    assert.notEqual(unterminated, source);
    assert.throws(() => generateRuntimeTables(unterminated), /unterminated_sql/u);
});
