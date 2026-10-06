import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrationCurrentSchemaBoundaryFailures } from '../../tools/db/migration-current-schema-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function sources(directory)
{
    return new Map(readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.cs'))
        .map(entry => [join(entry.parentPath, entry.name).slice(root.length + 1),
            readFileSync(join(entry.parentPath, entry.name), 'utf8')]));
}
const canonicalSources = sources('src/shared/Contracts/Schema');
const migrationSources = sources('src/migration');
const consumer = 'using FsusBlog.Contracts.Schema; namespace FsusBlog.Migration; ';
const unknown = 'src/migration/Unregistered/Nested/Consumer.cs';
function failures(source, additional = [])
{
    return migrationCurrentSchemaBoundaryFailures({ canonicalSources,
        migrationSources: new Map([[unknown, source], ...additional]) });
}

test('all actual Migration neutral-fact consumers preserve Shared ownership', () =>
{
    assert.equal([...migrationSources.values()].filter(source => /CurrentSchemaCanonical|SchemaTableModel/u.test(source)).length, 11);
    assert.deepEqual(migrationCurrentSchemaBoundaryFailures({ canonicalSources, migrationSources }), []);
});

for (const [name, source] of [
    ['ordinary consumer name and member', consumer + 'class CurrentSchemaCanonicalConsumer { SchemaTableModel? model; void F(Holder h) { var value = h.SchemaTableModel; } }'],
    ['same-name canonical alias', 'using SchemaTableModel = global::FsusBlog.Contracts.Schema.SchemaTableModel; class Consumer { SchemaTableModel value; }'],
    ['canonical namespace alias chain', 'using Contract = FsusBlog.Contracts.Schema; using Model = Contract.SchemaTableModel; class Consumer { Model value; Contract.SchemaTableModel other; }'],
    ['fully qualified canonical annotation', 'class Consumer { global::FsusBlog.Contracts.Schema.SchemaColumnModel value; }'],
    ['comment and raw literal', consumer + 'class Consumer { /* class SchemaColumnModel {} */ string text = """record SchemaTableModel;"""; }'],
    ['interpolated expression consumption', consumer + 'class Consumer { string F(SchemaTableModel model) => $"type={typeof(SchemaTableModel)}"; }'],
    ['generic type arguments and calls', consumer + 'class Consumer { List<SchemaTableModel> values; void F() { Call<SchemaTableModel>(); var x = Call<SchemaTableModel>(); return Call<SchemaTableModel>(); } }'],
    ['qualified generic calls', consumer + 'class Consumer { void F() { service.Module.Call<SchemaTableModel>(); System.Module.Utility.Call<SchemaTableModel>(); var x=flag?service.Module.Call<SchemaTableModel>():null; } }'],
    ['generic parameter attribute consumes canonical type', consumer + 'class Consumer<[Some(typeof(SchemaTableModel))] T> {}'],
    ['ORM names in inert text', 'class Consumer { /* [SugarTable("x")] */ string text = """[SugarColumn]"""; }']
])
{
    test(`legal ${name} is accepted without a path allowlist`, () => assert.deepEqual(failures(source), []));
}

for (const [name, source] of [
    ['unknown-directory neutral duplicate', consumer + 'class SchemaColumnModel {}'],
    ['record class duplicate', consumer + 'record class SchemaIndexModel<T>;'],
    ['record struct duplicate', consumer + 'record struct SchemaConstraintModel;'],
    ['escaped identifier duplicate', consumer + 'class @SchemaTableModel {}'],
    ['unicode escaped duplicate', consumer + 'class Schema\\u0054ableModel {}'],
    ['unicode formatting duplicate', consumer + 'class Schema\\u200DTableModel {}'],
    ['generic type parameter shadow', consumer + 'class Consumer<SchemaTableModel> {}'],
    ['generic method parameter shadow', consumer + 'class Consumer { void F<SchemaTableModel>() {} }'],
    ['attributed generic method shadow', consumer + 'class Consumer { void F<[Some] SchemaTableModel>() {} }'],
    ['attributed tuple-return generic method shadow', consumer + 'class Consumer { [Obsolete] public (int Left, int Right) F<SchemaTableModel>() => default; }'],
    ['nullable explicit-interface method shadow', consumer + 'class Consumer { System.String? I.Contract.F<SchemaTableModel>() => null; }'],
    ['generic delegate parameter shadow', consumer + 'delegate int Consumer<SchemaTableModel>();'],
    ['delegate duplicate', consumer + 'delegate void SchemaTableModel();'],
    ['generic delegate duplicate', consumer + 'delegate void SchemaTableModel<T>();'],
    ['attributed generic delegate duplicate', consumer + 'delegate void SchemaTableModel<[Some(typeof(int))] T>();'],
    ['foreign namespace homonym', 'namespace Foreign { class SchemaTableModel {} }'],
    ['canonical namespace definition', 'namespace FsusBlog.Contracts.Schema { class Shadow {} }'],
    ['same-name foreign alias', 'using SchemaTableModel = System.String; class Consumer {}'],
    ['renamed foreign type alias', 'using Model = Other.SchemaColumnModel; class Consumer { Model value; }'],
    ['foreign namespace alias annotation', 'using Models = Other.Models; class Consumer { Models.SchemaTableModel value; }'],
    ['later canonical alias cannot cover bad alias', 'namespace Bad { using SchemaTableModel=System.String; class X { SchemaTableModel value; } } namespace Good { using SchemaTableModel=FsusBlog.Contracts.Schema.SchemaTableModel; class X { SchemaTableModel value; } }'],
    ['unbound type annotation', 'using Other.Models; class Consumer { SchemaTableModel value; }'],
    ['direct ORM mapping', '[SugarTable("x")] class Consumer {}'],
    ['fully qualified ORM suffix', '[global::SqlSugar.SugarTableAttribute("x")] class Consumer {}'],
    ['property-target ORM', 'class Consumer { [property:global::SqlSugar.SugarColumnAttribute] int Value; }'],
    ['second ORM attribute', '[Obsolete, global::SqlSugar.SugarIndexAttribute("x")] class Consumer {}'],
    ['ORM type alias', 'using Mapping = SqlSugar.SugarTableAttribute; [Mapping("x")] class Consumer {}'],
    ['ORM namespace alias chain', 'using O = SqlSugar; using M = O.SugarColumnAttribute; class Consumer { [M] int Value; }'],
    ['cyclic alias', 'using A = B; using B = A; class Consumer {}']
])
{
    test(`${name} fails closed`, () => assert.notDeepEqual(failures(source), []));
}

test('global Shared import binds real consumers across files', () =>
{
    assert.deepEqual(failures('class Consumer { SchemaTableModel value; }', [
        ['src/migration/GlobalImports.cs', 'global using FsusBlog.Contracts.Schema;']
    ]), []);
});

test('global canonical alias cannot cover a conflicting local alias', () =>
{
    assert.notDeepEqual(failures('using SchemaTableModel = System.String; class Consumer {}', [
        ['src/migration/GlobalImports.cs', 'global using SchemaTableModel = FsusBlog.Contracts.Schema.SchemaTableModel;']
    ]), []);
});

test('the two backfill-row owners cannot admit a third alias table or column mapping', () =>
{
    const path = 'src/migration/Definitions/CommentRevisionMigrationRows.cs';
    const original = migrationSources.get(path);
    for (const extra of ['[Extra("third")] class ExtraRow {}', 'class ExtraRow { [Col] int Value; }'])
    {
        const source = 'using Extra = SqlSugar.SugarTableAttribute; using Col = SqlSugar.SugarColumnAttribute;\n' + original + '\n' + extra;
        assert.notDeepEqual(migrationCurrentSchemaBoundaryFailures({ canonicalSources,
            migrationSources: new Map([[path, source]]) }), []);
    }
});

test('unknown-path duplicate and alias reach the actual checker CLI without a forged receipt', t =>
{
    const fixture = mkdtempSync(join(tmpdir(), 'fsusblog-migration-neutral-source-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    for (const relative of ['FsusBlog.slnx', 'src/backend/FsusBlog.Server.csproj', 'src/migration',
        'src/shared/Contracts/Schema', 'src/shared/FsusBlog.Shared.csproj', 'tests/migration/FsusBlog.Migration.Tests.csproj'])
    {
        mkdirSync(dirname(join(fixture, relative)), { recursive: true });
        cpSync(join(root, relative), join(fixture, relative), { recursive: true });
    }
    const check = () => spawnSync(process.execPath, ['--max-old-space-size=512',
        join(root, 'tools/db/check-migration-assembly-boundary.mjs'), '--root', fixture], { encoding: 'utf8' });
    const initial = check();
    assert.equal(initial.status, 1);
    assert.match(initial.stderr, /migration assembly receipt is missing/u);
    assert.doesNotMatch(initial.stderr, /duplicate current-schema field mapping/u);
    mkdirSync(dirname(join(fixture, unknown)), { recursive: true });
    writeFileSync(join(fixture, unknown), 'class Consumer { /* [SugarTable("x")] */ string text = """[SugarColumn]"""; }');
    const inert = check();
    assert.equal(inert.status, 1);
    assert.doesNotMatch(inert.stderr, /duplicate current-schema field mapping/u);
    assert.match(inert.stderr, /migration assembly receipt is missing/u);
    writeFileSync(join(fixture, unknown), consumer + 'class SchemaColumnModel {}');
    const duplicate = check();
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /Unregistered.*declares or shadows Shared.*SchemaColumnModel/u);
    writeFileSync(join(fixture, unknown), 'using O = SqlSugar; [O.SugarTableAttribute("x")] class Consumer {}');
    const alias = check();
    assert.equal(alias.status, 1);
    assert.match(alias.stderr, /Unregistered.*ORM current-schema field mapping/u);
    assert.match(alias.stderr, /migration assembly receipt is missing/u);
    rmSync(join(fixture, unknown));
    const rowPath = 'src/migration/Definitions/CommentRevisionMigrationRows.cs';
    writeFileSync(join(fixture, rowPath), 'using Extra = SqlSugar.SugarTableAttribute;\n'
        + migrationSources.get(rowPath) + '\n[Extra("third")] class ExtraRow {}');
    const thirdTable = check();
    assert.equal(thirdTable.status, 1);
    assert.match(thirdTable.stderr, /CommentRevisionMigrationRows.cs.*ORM current-schema field mapping/u);
});
