import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    cpSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = join(
    repoRoot,
    "tools/db/check-schema-allowed-extra-tables.mjs"
);
const fixturePaths = [
    "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs",
    "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
    "src/backend/Entities",
    "src/migration/Definitions"
];

function fixture(t)
{
    const root = mkdtempSync(join(tmpdir(), "fsusblog-schema-allowed-"));
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
    const source = readFileSync(fullPath, "utf8");
    writeFileSync(fullPath, transform(source));
}

function check(root)
{
    return spawnSync(process.execPath, [checker, "--root", root], {
        encoding: "utf8"
    });
}

for (const [table, definition, migrationId, column] of [
    ["taxonomy_mutation_receipt", "TaxonomyMutationReceiptMigrationDefinitions.cs", "20261018-post-taxonomy-mutation-receipt", "target_id"],
    ["user_locale_mutation_receipt", "UserLocaleMutationReceiptMigrationDefinitions.cs", "20261018-post-user-locale-mutation-receipt", "account_id"]
])
{
    test(`required ${table} migration ID drift is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(root, `src/migration/Definitions/${definition}`, (source) =>
        {
            assert.equal(source.split(migrationId).length, 2);
            return source.replace(migrationId, `${migrationId}-changed`);
        });
        const result = check(root);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`"${table}" is not created by the PostCodeFirst rollup EnsureTable methods`));
    });

    test(`required ${table} original DDL drift is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(root, "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs", (source) =>
        {
            const declaration = new RegExp(`(new\\(\\s*"${table}"\\s*,\\s*"""[\\s\\S]*?)"""`, "u");
            assert.equal([...source.matchAll(new RegExp(declaration.source, "gu"))].length, 1);
            return source.replace(declaration, (block) =>
            {
                assert.ok(block.includes(`${column} integer NOT NULL`));
                return block.replace(`${column} integer NOT NULL`, `${column} bigint NOT NULL`);
            });
        });
        const result = check(root);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`CREATE TABLE SQL for "${table}" does not match the PostCodeFirst EnsureTable step`));
    });
}

test("canonical allowed-extra-tables register is accepted", (t) =>
{
    const root = fixture(t);
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[schema-allowed-extra-tables\] ok/);
});

test("a SugarTable entity listed as allowed extra is rejected (dead entry)", (t) =>
{
    const root = fixture(t);
    mutate(
        root,
        "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs",
        (source) =>
            source.replace(
                '        "sys_visit_log",',
                '        "comment_moderation_event",\n        "sys_visit_log",'
            )
    );
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /comment_moderation_event.*must not be listed/);
});

test("a migration-created table missing from the allowlist is rejected (drift)", (t) =>
{
    const root = fixture(t);
    // Remove an allowed migration table from the register; the migration catalog
    // still creates it, so the verifier would treat it as a branded extra table.
    mutate(
        root,
        "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs",
        (source) => source.replace('        "sys_visit_log",\n', "")
    );
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /sys_visit_log.*not listed in s_allowedExtraTables/
    );
});

test("a required rollup table listed as optional extra is rejected", (t) =>
{
    const root = fixture(t);
    mutate(
        root,
        "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs",
        (source) =>
            source.replace(
                '        "sys_visit_log",',
                '        "daily_read_stats",\n        "sys_visit_log",'
            )
    );
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /daily_read_stats.*must not remain in s_allowedExtraTables/
    );
});

test("required rollup CREATE TABLE SQL drift is rejected", (t) =>
{
    const root = fixture(t);
    mutate(
        root,
        "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
        (source) =>
            source.replace(
                "total_reads bigint NOT NULL DEFAULT 0",
                "total_reads integer NOT NULL DEFAULT 0"
            )
    );
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CREATE TABLE SQL for "daily_read_stats" does not match/
    );
});

test("a PostCodeFirst rollup table missing from the required catalog is rejected", (t) =>
{
    const root = fixture(t);
    mutate(
        root,
        "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
        (source) =>
            source.replace(
                /\n {8}new\(\s*"event_type_read_stats",[\s\S]*?"""\),/,
                ""
            )
    );
    const result = check(root);
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /event_type_read_stats.*missing from the required catalog/
    );
});

test("complete PropertyDefinition history tables bind to their registered migration", (t) =>
{
    const root = fixture(t);
    const definition = readFileSync(
        join(root, "src/migration/Definitions/ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.cs"),
        "utf8"
    );
    const required = readFileSync(
        join(root, "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs"),
        "utf8"
    );
    assert.match(definition, /const string MigrationId = "20261002-post-article-property-definition-command-history"/);
    for (const table of ["article_property_definition_history", "article_property_definition_command"])
    {
        assert.ok(definition.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
        assert.ok(required.includes(`CREATE TABLE IF NOT EXISTS ${table} (`));
    }
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[schema-allowed-extra-tables\] ok/);
});

for (const replacementId of ["", "20261003-post-article-property-definition-command-history"])
{
    test(`PropertyDefinition history migration ID ${replacementId ? "drift" : "absence"} is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(
            root,
            "src/migration/Definitions/ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.cs",
            (source) =>
            {
                const originalId = "20261002-post-article-property-definition-command-history";
                assert.equal(source.split(originalId).length, 2);
                return source.replace(originalId, replacementId);
            }
        );
        const result = check(root);
        assert.notEqual(result.status, 0);
        for (const table of ["article_property_definition_history", "article_property_definition_command"])
        {
            assert.ok(result.stderr.includes(`"${table}" is not created by the PostCodeFirst rollup EnsureTable methods`));
        }
    });
}

for (const table of ["article_property_definition_history", "article_property_definition_command"])
{
    test(`required ${table} CREATE TABLE SQL drift is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(
            root,
            "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
            (source) =>
            {
                const tableSql = new RegExp(`(new\\(\\s*"${table}"\\s*,\\s*"""[\\s\\S]*?)"""`, "u");
                assert.equal([...source.matchAll(new RegExp(tableSql.source, "gu"))].length, 1);
                return source.replace(tableSql, (block) =>
                {
                    assert.ok(block.includes("history_version integer NOT NULL"));
                    return block.replace("history_version integer NOT NULL", "history_version bigint NOT NULL");
                });
            }
        );
        const result = check(root);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`CREATE TABLE SQL for "${table}" does not match the PostCodeFirst EnsureTable step`));
    });
}

for (const replacementId of ["", "20260916-post-author-recent-history"])
{
    test(`recent article history migration ID ${replacementId ? "drift" : "absence"} is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(
            root,
            "src/migration/Definitions/AuthorRecentArticleHistoryMigrationDefinitions.cs",
            (source) =>
            {
                const originalId = "20260915-post-author-recent-history";
                assert.equal(source.split(originalId).length, 2);
                return source.replace(originalId, replacementId);
            }
        );
        const result = check(root);
        assert.notEqual(result.status, 0);
        for (const table of [
            "author_recent_history_collection",
            "author_recent_history_entry",
            "author_recent_history_receipt",
            "author_recent_history_idempotency",
            "author_recent_history_outbox",
            "author_recent_history_audit"
        ])
        {
            assert.ok(result.stderr.includes(`"${table}" is not created by the PostCodeFirst rollup EnsureTable methods`));
        }
    });
}

for (const table of [
    "author_recent_history_collection",
    "author_recent_history_entry",
    "author_recent_history_receipt",
    "author_recent_history_idempotency",
    "author_recent_history_outbox",
    "author_recent_history_audit"
])
{
    test(`required ${table} CREATE TABLE SQL drift is rejected`, (t) =>
    {
        const root = fixture(t);
        mutate(
            root,
            "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
            (source) =>
            {
                const tableSql = new RegExp(`(new\\(\\s*"${table}"\\s*,\\s*"""[\\s\\S]*?)"""`, "u");
                assert.equal([...source.matchAll(new RegExp(tableSql.source, "gu"))].length, 1);
                return source.replace(tableSql, (block) =>
                {
                    const declaration = `CREATE TABLE IF NOT EXISTS ${table} (`;
                    assert.ok(block.includes(declaration));
                    return block.replace(declaration, `${declaration}\n                unexpected_history_column integer,`);
                });
            }
        );
        const result = check(root);
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`CREATE TABLE SQL for "${table}" does not match the PostCodeFirst EnsureTable step`));
    });
}
