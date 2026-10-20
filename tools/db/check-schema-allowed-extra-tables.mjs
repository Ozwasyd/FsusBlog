#!/usr/bin/env node
// Guards the single-source-of-truth relationship between the canonical
// SugarTable entities, the migration catalog definitions, the schema
// verifier's allowedExtraTables allowlist, and the required PostCodeFirst
// rollup EnsureTable catalog owned by the Server.
//
// The server runtime must not reference the migration assembly (see
// check-migration-assembly-boundary.mjs), so s_allowedExtraTables is the
// server-side register of tables that MAY exist outside the canonical entity
// set. PostCodeFirst runtime tables (rollup stats, release fence, public
// projection, theme/customization/canvas/pin surfaces) are required extras:
// they must exist, they are not CodeFirst entities, and they must not remain
// on the optional allowlist. Two original drift modes plus rollup drift
// must stay impossible:
//   1. a SugarTable entity also listed as allowed or required extra;
//   2. a migration-created table without any entity, missing from both the
//      optional allowlist and the required rollup catalog;
//   3. required rollup CREATE TABLE SQL that does not match the PostCodeFirst
//      migration DDL it claims to align with.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argRootIndex = process.argv.indexOf("--root");
const root = resolve(
    argRootIndex >= 0
        ? process.argv[argRootIndex + 1]
        : dirname(fileURLToPath(import.meta.url)),
    argRootIndex >= 0 ? "" : "../.."
);
const failures = [];
const rollupMigrationIds = [
    "20260629-post-visit-log-stats-rollup",
    "20260629-post-author-analytics-rollups",
    "20260714-post-public-article-projection",
    "20260715-post-active-release-fence-durable-witness",
    "20260715-post-active-release-fenced-commit-ledger",
    "20260724-post-plugin-registry",
    "20260724-post-theme-registry",
    "20260724-post-theme-runtime",
    "20260725-post-customization",
    "20260828-post-authoring-canvas-document",
    "20260904-post-author-article-pins",
    "20260904-post-author-saved-view",
    "20260905-post-article-template-authority",
    "20260908-post-article-create-authority",
    "20260915-post-article-property-definition-authority",
    "20260915-post-author-recent-history",
    "20261002-post-article-property-definition-command-history",
    "20261018-post-taxonomy-mutation-receipt",
    "20261018-post-user-locale-mutation-receipt"
];
function fail(message)
{
    failures.push(message);
}

function collectFileNames(dir, suffix)
{
    const names = [];
    if (!existsSync(dir))
    {
        return names;
    }
    for (const entry of readdirSync(dir))
    {
        if (entry.endsWith(suffix))
        {
            names.push(join(dir, entry));
        }
    }
    return names;
}

function sourceFilesRecursive(dir, suffix)
{
    const files = [];
    if (!existsSync(dir))
    {
        return files;
    }
    const stack = [dir];
    while (stack.length > 0)
    {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const full = join(current, entry.name);
            if (entry.isDirectory())
            {
                stack.push(full);
            }
            else if (entry.isFile() && entry.name.endsWith(suffix))
            {
                files.push(full);
            }
        }
    }
    return files;
}

function rel(file)
{
    return file.slice(root.length + 1).replaceAll("\\", "/");
}

function normalizeSql(sql)
{
    return sql
        .replaceAll("\r\n", "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
}

function extractNamedRawSql(source)
{
    const tables = new Map();
    const pattern =
        /(?:new\s+EnsureTableStep|new)\(\s*"([a-z_0-9]+)"\s*,\s*"""(.*?)"""/gsu;
    for (const match of source.matchAll(pattern))
    {
        tables.set(match[1], normalizeSql(match[2]));
    }
    return tables;
}

function splitStatements(sql)
{
    const statements = [];
    let current = [];
    for (const line of sql.split("\n"))
    {
        current.push(line);
        if (line.trimEnd().endsWith(";"))
        {
            statements.push(current.join("\n"));
            current = [];
        }
    }
    const rest = current.join("\n").trim();
    if (rest.length > 0)
    {
        statements.push(rest);
    }
    return statements;
}

// Collect every CREATE TABLE statement owned by the scoped migration
// descriptors, across EnsureTableStep, CreateIndexStep-adjacent raw blocks and
// multi-statement RawSqlStep bodies, in both triple-quoted and single-line
// string forms. Descriptor ids may be literals or file-scoped const names.
function extractDescriptorTables(source, wantedIds)
{
    const tables = new Map();
    const constIds = new Map();
    for (const match of source.matchAll(
        /const string (\w+) = "([0-9]{6,8}-[a-z0-9-]+)"/gu
    ))
    {
        constIds.set(match[1], match[2]);
    }
    const allStarts = [
        ...source.matchAll(/new\s+SchemaMigrationDescriptor\(/gu)
    ].map((match) => match.index);
    for (const match of source.matchAll(
        /new\s+SchemaMigrationDescriptor\(\s*(?:"([0-9]{6,8}-[a-z0-9-]+)"|(\w+))/gu
    ))
    {
        const id = match[1] ?? constIds.get(match[2]);
        if (!id || !wantedIds.has(id))
        {
            continue;
        }
        const next = allStarts.find((pos) => pos > match.index);
        const block =
            next === undefined
                ? source.slice(match.index)
                : source.slice(match.index, next);
        for (const inner of block.matchAll(/"""([\s\S]*?)"""/gu))
        {
            for (const statement of splitStatements(inner[1]))
            {
                const table = statement.match(
                    /CREATE TABLE IF NOT EXISTS ([a-z_0-9]+)/u
                );
                if (table)
                {
                    tables.set(table[1], normalizeSql(statement));
                }
            }
        }
        for (const inner of block.matchAll(
            /new\s+(?:EnsureTableStep|RawSqlStep)\(\s*"(CREATE TABLE[^"]*)"\s*\)/gu
        ))
        {
            const table = inner[1].match(
                /CREATE TABLE IF NOT EXISTS ([a-z_0-9]+)/u
            );
            if (table)
            {
                tables.set(table[1], normalizeSql(inner[1]));
            }
        }
        for (const inner of block.matchAll(
            /new\s+EnsureTableStep\(\s*"([a-z_0-9]+)"\s*,\s*"(CREATE TABLE[^"]*)"\s*\)/gu
        ))
        {
            tables.set(inner[1], normalizeSql(inner[2]));
        }
    }
    return tables;
}

// 1. All canonical entity table names (SugarTable attribute).
const entityTables = new Set();
for (const file of sourceFilesRecursive(join(root, "src/backend"), ".cs"))
{
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/SugarTable\("([a-z_0-9]+)"\)/gu))
    {
        entityTables.add(match[1]);
    }
}

// 2. All migration-created table names (CREATE TABLE / CREATE TABLE IF NOT EXISTS).
const migrationTables = new Set();
const definitionFiles = collectFileNames(
    join(root, "src/migration/Definitions"),
    ".cs"
);
for (const file of definitionFiles)
{
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_0-9]+)/gu
    ))
    {
        migrationTables.add(match[1]);
    }
}

// 3. The verifier optional allowlist.
const runnerPath = join(
    root,
    "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRunner.cs"
);
const runnerSrc = existsSync(runnerPath)
    ? readFileSync(runnerPath, "utf8")
    : "";
const allowedStart = runnerSrc.indexOf("s_allowedExtraTables =");
const allowedEnd = runnerSrc.indexOf("];", allowedStart);
if (allowedStart < 0 || allowedEnd < 0)
{
    fail("SchemaMigrationRunner.cs: s_allowedExtraTables block not found");
}
const allowedTables = new Set();
if (allowedStart >= 0 && allowedEnd >= 0)
{
    for (const match of runnerSrc
        .slice(allowedStart, allowedEnd)
        .matchAll(/"([a-z_0-9]+)"/gu))
    {
        allowedTables.add(match[1]);
    }
}

// 4. Required PostCodeFirst rollup EnsureTable catalog owned by the Server.
const rollupPath = join(
    root,
    "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs"
);
if (!existsSync(rollupPath))
{
    fail(
        "CurrentSchemaRuntimeRollupTables.cs: required rollup catalog is missing"
    );
}
const rollupSrc = existsSync(rollupPath)
    ? readFileSync(rollupPath, "utf8")
    : "";
const requiredSql = extractNamedRawSql(rollupSrc);
const requiredTables = new Set(requiredSql.keys());

const migrationRollupSql = new Map();
for (const file of definitionFiles)
{
    const src = readFileSync(file, "utf8");
    for (const [tableName, sql] of extractDescriptorTables(
        src,
        new Set(rollupMigrationIds)
    ))
    {
        migrationRollupSql.set(tableName, sql);
    }
}

if (migrationRollupSql.size === 0)
{
    fail(
        "PostCodeFirst runtime-table migration descriptors were not found in migration definitions"
    );
}

// Invariant 1: no dead entries (entity table also listed as allowed or required).
for (const table of allowedTables)
{
    if (entityTables.has(table))
    {
        fail(
            `${rel(runnerPath)}: "${table}" is a SugarTable entity; it must not be listed in ` +
                "s_allowedExtraTables (the canonical expected model already covers it)"
        );
    }
}
for (const table of requiredTables)
{
    if (entityTables.has(table))
    {
        fail(
            `${rel(rollupPath)}: "${table}" is a SugarTable entity; it must not be a required extra table`
        );
    }
    if (allowedTables.has(table))
    {
        fail(
            `${rel(runnerPath)}: "${table}" is a required rollup table; it must not remain in ` +
                "s_allowedExtraTables (the verifier must require it, not only allow it)"
        );
    }
}

// Invariant 2: no missing migration tables (migration-created, no entity,
// absent from both the optional allowlist and the required rollup catalog).
for (const table of migrationTables)
{
    if (
        !entityTables.has(table) &&
        !allowedTables.has(table) &&
        !requiredTables.has(table)
    )
    {
        fail(
            `${rel(runnerPath)}: migration-created table "${table}" has no SugarTable entity and ` +
                "is not listed in s_allowedExtraTables or CurrentSchemaRuntimeRollupTables; " +
                "the verifier would reject it as an extra table"
        );
    }
}

// Invariant 3: required rollup catalog matches the two PostCodeFirst EnsureTable sets.
for (const table of requiredTables)
{
    if (!migrationRollupSql.has(table))
    {
        fail(
            `${rel(rollupPath)}: "${table}" is not created by the PostCodeFirst rollup EnsureTable methods`
        );
        continue;
    }
    if (requiredSql.get(table) !== migrationRollupSql.get(table))
    {
        fail(
            `${rel(rollupPath)}: CREATE TABLE SQL for "${table}" does not match the PostCodeFirst EnsureTable step`
        );
    }
}
for (const table of migrationRollupSql.keys())
{
    if (!requiredTables.has(table))
    {
        fail(
            `${rel(rollupPath)}: PostCodeFirst rollup table "${table}" is missing from the required catalog`
        );
    }
}

if (failures.length > 0)
{
    for (const issue of failures)
    {
        process.stderr.write(`[schema-allowed-extra-tables] ${issue}\n`);
    }
    process.exitCode = 1;
}
else
{
    process.stdout.write(
        `[schema-allowed-extra-tables] ok entities=${entityTables.size} migration=${migrationTables.size} ` +
            `allowed=${allowedTables.size} required=${requiredTables.size}\n`
    );
}
