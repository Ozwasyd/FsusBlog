import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checker = join(repoRoot, 'tools/db/check-schema-allowed-extra-tables.mjs');
const recipePath = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs';
const operationPath = 'src/migration/Definitions/AuthoringCanvasOperationJournalMigrationDefinitions.cs';
const cutoverPath = 'src/migration/Definitions/ContentAssetCutoverMigrationDefinitions.cs';
const retirementPath = 'src/migration/Definitions/LegacyIdentityMigrationDefinitions.cs';
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'fsusblog-current-schema-source-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of ['src/backend/Entities', 'src/backend/Infrastructure/SchemaMigration', 'src/migration']) {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(join(repoRoot, path), destination, { recursive: true });
    }
    return root;
}
function mutate(root, path, transform) {
    const full = join(root, path);
    const before = readFileSync(full, 'utf8');
    const after = transform(before);
    assert.notEqual(after, before, `control did not mutate ${path}`);
    writeFileSync(full, after);
}
function check(root) {
    return spawnSync(process.execPath, ['--max-old-space-size=512', checker, '--root', root], { encoding: 'utf8' });
}
function reject(root, expected) {
    const result = check(root);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, expected);
}
function removeRecipe(source, table) {
    const entries = [...source.matchAll(/\bnew\(\s*"([a-z_0-9]+)",/gu)];
    const index = entries.findIndex((match) => match[1] === table);
    assert.ok(index >= 0);
    const start = entries[index].index;
    const end = entries[index + 1]?.index ?? source.indexOf('    ];', start);
    return source.slice(0, start) + source.slice(end);
}
function appendStep(source, step) {
    assert.equal(source.split('            ]);').length, 2);
    return source.replace('            ]);', `                , ${step}\n            ]);`);
}
function raw(sql) { return `new RawSqlStep("""\n${sql}\n""")`; }

test('original complete current target, including published retirement, is accepted', (t) => {
    const result = check(fixture(t));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ok entities=\d+ descriptors=\d+ surviving=\d+ required=\d+/u);
});
for (const table of ['authoring_canvas_operation_journal', 'event_type_read_stats', 'article_property_definition_history']) {
    test(`removing required ${table} preserves a real coverage failure`, (t) => {
        const root = fixture(t);
        mutate(root, recipePath, (source) => removeRecipe(source, table));
        reject(root, new RegExp(`${table}: surviving migration table is missing`, 'u'));
    });
}
test('removing an original required index is rejected', (t) => {
    const root = fixture(t);
    mutate(root, recipePath, (source) => source.replace(/,\s*AdditionalSql:\s*\[\s*"""\s*CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history[\s\S]*?"""\s*\]/u, ''));
    reject(root, /authoring_canvas_operation_journal: original final effect is missing/u);
});
test('removing a required foreign key is rejected', (t) => {
    const root = fixture(t);
    mutate(root, recipePath, (source) => source.replace(/\s*CONSTRAINT fk_authoring_canvas_operation_journal_document[\s\S]*?ON DELETE CASCADE,/u, ''));
    reject(root, /CREATE TABLE SQL for "authoring_canvas_operation_journal" does not match/u);
});
for (const [name, type] of [['command_kinds', 'smallint'], ['affected_node_ids', 'uuid'], ['reasons', 'text']]) {
    test(`removing original ${type}[] column ${name} is rejected`, (t) => {
        const root = fixture(t);
        mutate(root, recipePath, (source) => source.replace(new RegExp(`\\s*${name} ${type}\\[\\] NOT NULL,`, 'u'), ''));
        reject(root, /CREATE TABLE SQL for "authoring_canvas_operation_(?:journal|receipt)" does not match/u);
    });
}
test('entity/required ownership overlap is rejected', (t) => {
    const root = fixture(t);
    writeFileSync(join(root, 'src/backend/Entities/Unexpected.cs'), 'using SqlSugar; [SugarTable("authoring_canvas_operation_journal")] internal class Unexpected {}\n');
    reject(root, /authoring_canvas_operation_journal: entity\/required recipe owner overlap/u);
});
test('optional table grants cannot bypass complete ownership', (t) => {
    const root = fixture(t);
    mutate(root, 'src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs', (source) => source + '\ninternal class OptionalGrants { static string[] s_allowedExtraTables = ["daily_read_stats"]; }\n');
    reject(root, /optional table grants are forbidden/u);
});
test('recursive unregistered source cannot obtain retirement or creation authority', (t) => {
    const root = fixture(t);
    const directory = join(root, 'src/migration/Definitions/Unknown/Nested');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'Unknown.cs'), 'internal class Unknown { static string Sql = "CREATE TABLE unknown_survivor (id bigint);"; }\n');
    reject(root, /unbound schema source outside descriptor steps/u);
});
for (const [label, change] of [
    ['variable array element', (source) => source.replace("'article_asset_' || 'reference'", "'article_asset_' || dynamic_suffix")],
    ['foreign loop variable', (source) => source.replace('quote_ident(legacy_table)', 'quote_ident(other_table)')],
    ['conditional drop', (source) => source.replace('LOOP\n                            EXECUTE', 'LOOP\n                            IF optional THEN EXECUTE')]
]) {
    test(`unresolved retirement ${label} is rejected`, (t) => {
        const root = fixture(t);
        mutate(root, cutoverPath, change);
        reject(root, /unresolved (?:dynamic\/conditional table retirement|retirement array expression)/u);
    });
}
test('phase ordering refuses retirement before a later-phase CREATE', (t) => {
    const root = fixture(t);
    const oldId = '20260715-post-read-event-retirement';
    const newId = '20260715-pre-read-event-retirement';
    for (const path of [retirementPath, 'src/migration/DestructiveMigrationProofs.cs', 'src/migration/OfflineMigrationClassificationFacts.cs']) {
        mutate(root, path, (source) => source.replaceAll(oldId, newId).replace(
            /("20260715-pre-read-event-retirement",[\s\S]*?)SchemaMigrationPhase.PostCodeFirst/u,
            '$1SchemaMigrationPhase.PreCodeFirst'));
    }
    reject(root, /retirement precedes CREATE/u);
});
test('a CREATE after actual retirement survives and must have a current owner', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw('CREATE TABLE IF NOT EXISTS sys_visit_log (id bigint PRIMARY KEY);')));
    reject(root, /sys_visit_log: surviving migration table is missing/u);
});
test('a conflicting IF NOT EXISTS cannot replace the first surviving shape', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw('CREATE TABLE IF NOT EXISTS authoring_canvas_operation_journal (id bigint PRIMARY KEY);')));
    reject(root, /conflicting CREATE without retirement/u);
});
for (const [label, sql] of [
    ['opaque SQL', 'DO $$ BEGIN EXECUTE opaque_command; END $$;'],
    ['concatenated rename', "DO $$ BEGIN EXECUTE 'ALTER TABLE ' || quote_ident('authoring_canvas_operation_command') || ' RENAME TO lost_operation'; END $$;"],
    ['formatted index', "DO $$ BEGIN EXECUTE format('CREATE INDEX missing ON %I(%I)', table_name, field_name); END $$;"]
]) {
    test(`unknown dynamic ${label} cannot supply schema effects`, (t) => {
        const root = fixture(t);
        mutate(root, operationPath, (source) => appendStep(source, raw(sql)));
        reject(root, /unresolved dynamic (?:SQL|index)/u);
    });
}
for (const [label, step, expected] of [
    ['index retirement', 'new DropIndexStep("ix_authoring_canvas_operation_journal_history")', /not a final surviving effect/u],
    ['added column', 'new EnsureColumnStep("authoring_canvas_operation_journal", "extra_column", "bigint NOT NULL DEFAULT 0")', /original final effect is missing/u],
    ['column retirement', 'new DropColumnStep("authoring_canvas_operation_journal", "command_kinds", DestructiveMigrationProofs.For("20260715-post-read-event-retirement"))', /unsupported required-table shape mutation/u],
    ['column rename', 'new RenameColumnStep("authoring_canvas_operation_journal", "command_kinds", "lost_kinds")', /unsupported required-table shape mutation/u],
    ['raw column retirement', raw('ALTER TABLE authoring_canvas_operation_journal DROP COLUMN command_kinds;'), /unsupported required-table ALTER effect/u]
]) {
    test(`required final ${label} is not ignored`, (t) => {
        const root = fixture(t);
        mutate(root, operationPath, (source) => appendStep(source, step));
        reject(root, expected);
    });
}
test('required CREATE cannot discard an extra statement tail', (t) => {
    const root = fixture(t);
    mutate(root, recipePath, (source) => source.replace(/(CREATE TABLE IF NOT EXISTS authoring_canvas_operation_journal \([\s\S]*?\);)(\s*""")/u, '$1\n SELECT 1;$2'));
    reject(root, /unparsed required CREATE tail/u);
});
test('immutable historical source SQL drift cannot be masked by current recipe SQL', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => source.replace('command_kinds smallint[]', 'command_kinds integer[]'));
    reject(root, /CREATE TABLE SQL for "authoring_canvas_operation_journal" does not match/u);
});
for (const [path, id] of [
    ['src/migration/Definitions/ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.cs', '20261002-post-article-property-definition-command-history'],
    ['src/migration/Definitions/AuthorRecentArticleHistoryMigrationDefinitions.cs', '20260915-post-author-recent-history']
]) {
    test(`original descriptor ID ${id} is source-classification bound`, (t) => {
        const root = fixture(t);
        mutate(root, path, (source) => source.replace(id, id.replace('-post-', '-post-unknown-')));
        reject(root, /descriptor has no original source classification/u);
    });
}
test('an unrelated dictionary cannot supply a missing original destructive proof', (t) => {
    const root = fixture(t);
    mutate(root, 'src/migration/DestructiveMigrationProofs.cs', (source) => {
        const entry = source.match(/\["20260715-post-read-event-retirement"\] = Create\([\s\S]*?\),/u);
        assert.ok(entry);
        return source.replace(entry[0], '') + `\ninternal class ForeignProofs { object unused = new Dictionary<string, object> { ${entry[0]} }; }\n`;
    });
    reject(root, /unbound destructive retirement proof/u);
});
test('ordinary SugarTable calls and inert strings do not manufacture an entity owner', (t) => {
    const root = fixture(t);
    mutate(root, recipePath, (source) => removeRecipe(source, 'authoring_canvas_operation_journal'));
    writeFileSync(join(root, 'src/backend/Entities/Inert.cs'), 'class Inert { string s = "SugarTable(\\"authoring_canvas_operation_journal\\")"; void F(){ SugarTable("authoring_canvas_operation_journal"); } }\n');
    reject(root, /authoring_canvas_operation_journal: surviving migration table is missing/u);
});

test('an index IF NOT EXISTS cannot replace the first surviving keys', (t) => {
    const root = fixture(t);
    const sql = 'CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history ON authoring_canvas_operation_journal(journal_id, revision);';
    mutate(root, operationPath, (source) => appendStep(source, raw(sql)));
    mutate(root, recipePath, (source) => source.replace(/CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history[\s\S]*?;/u, sql));
    reject(root, /conflicting final effect without retirement index:/u);
});
test('explicit index retirement permits a new source-bound final index', (t) => {
    const root = fixture(t);
    const sql = 'CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history ON authoring_canvas_operation_journal(journal_id, revision);';
    mutate(root, operationPath, (source) => appendStep(appendStep(source,
        'new DropIndexStep("ix_authoring_canvas_operation_journal_history")'), raw(sql)));
    mutate(root, recipePath, (source) => source.replace(/CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history[\s\S]*?;/u, sql));
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
});

test('qualified SugarTable calls cannot manufacture an entity owner', (t) => {
    const root = fixture(t);
    mutate(root, recipePath, (source) => removeRecipe(source, 'authoring_canvas_operation_journal'));
    writeFileSync(join(root, 'src/backend/Entities/QualifiedCall.cs'), 'class Consumer { void F(){ SqlSugar.SugarTable("authoring_canvas_operation_journal"); } }\n');
    reject(root, /authoring_canvas_operation_journal: surviving migration table is missing/u);
});

test('a separate formatted step cannot remove a required constraint', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw("DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'authoring_canvas_operation_journal', 'fk_authoring_canvas_operation_journal_document'); END $$;")));
    reject(root, /unsupported formatted required-table constraint mutation/u);
});
test('opaque formatted schema targets are not presumed outside current ownership', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw("DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', unknown_table, unknown_constraint); END $$;")));
    reject(root, /unresolved formatted schema target relation/u);
});

test('a dynamic literal ALTER cannot add an unprojected required column', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw("DO $$ BEGIN EXECUTE 'ALTER TABLE authoring_canvas_operation_journal ADD COLUMN IF NOT EXISTS extra bigint NOT NULL DEFAULT 0'; END $$;")));
    reject(root, /unsupported dynamic required-table schema mutation/u);
});

test('a formatted schema command cannot append another dynamic effect', (t) => {
    const root = fixture(t);
    mutate(root, operationPath, (source) => appendStep(source, raw("DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'sys_article', 'legacy_constraint') || '; ALTER TABLE authoring_canvas_operation_journal DROP CONSTRAINT fk_authoring_canvas_operation_journal_document'; END $$;")));
    reject(root, /unresolved formatted schema concatenation/u);
});
