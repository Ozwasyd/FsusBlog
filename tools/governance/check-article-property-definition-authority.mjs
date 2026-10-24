#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

const storeFile =
    "src/backend/Services/Authoring/ArticlePropertyDefinitionStore.cs";
const contractFiles = [
    "src/backend/Services/Authoring/ArticlePropertyDefinitionCoreModels.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionContracts.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionAuthorityContracts.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionCommands.cs"
];
const persistenceFile =
    "src/backend/Services/Authoring/PostgresArticlePropertyDefinitionPersistence.cs";
const verifierFile =
    "src/backend/Services/Authoring/ArticlePropertyDefinitionVerifier.cs";
const migrationFile =
    "src/migration/Definitions/ArticlePropertyDefinitionAuthorityMigrationDefinitions.cs";
const catalogFile =
    "src/migration/Catalogs/SchemaMigrationCatalog20260915ArticlePropertyDefinitions.cs";
const registrationFile =
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs";
const runtimeTableFile =
    "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs";
const auditWriterFile =
    "src/backend/Services/Authoring/AuthoringSignedAuditWriter.cs";

const ownedFiles = [
    storeFile,
    ...contractFiles,
    persistenceFile,
    verifierFile,
    migrationFile,
    catalogFile,
    registrationFile,
    runtimeTableFile,
    auditWriterFile
];

function walk(directory)
{
    if (!existsSync(directory))
    {
        return [];
    }
    const files = [];
    const pending = [directory];
    while (pending.length > 0)
    {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                pending.push(absolute);
            }
            else if (entry.isFile() && entry.name.endsWith(".cs"))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

function source(repositoryRoot, relative)
{
    return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

function checkArticlePropertyDefinitionAuthority(repositoryRoot = root)
{
    const violations = [];
    for (const relative of ownedFiles)
    {
        if (!existsSync(path.join(repositoryRoot, relative)))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const propertyFiles = walk(path.join(repositoryRoot, "src")).filter(
        (absolute) => !absolute.endsWith(runtimeTableFile) &&
            /ArticlePropertyDefinition|article_property_definition/u.test(
                source(repositoryRoot, path.relative(repositoryRoot, absolute))
            )
    );
    const storeClasses = new Set();
    const persistenceClasses = new Set();
    for (const absolute of propertyFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const text = readFileSync(absolute, "utf8");
        for (const match of text.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticlePropertyDefinition[A-Za-z0-9_]*Store)\b/gu
        ))
        {
            storeClasses.add(`${relative}:${match[1]}`);
        }
        for (const match of text.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticlePropertyDefinition[A-Za-z0-9_]*Persistence)\b/gu
        ))
        {
            persistenceClasses.add(`${relative}:${match[1]}`);
        }
    }
    const stores = [...storeClasses];
    if (stores.length !== 1 || stores[0] !== `${storeFile}:ArticlePropertyDefinitionStore`)
    {
        violations.push(
            `expected exact-one article property definition store, found ${stores.join(", ") || "<none>"}`
        );
    }
    const persistences = [...persistenceClasses];
    if (
        persistences.length !== 1 ||
        persistences[0] !== `${persistenceFile}:PostgresArticlePropertyDefinitionPersistence`
    )
    {
        violations.push(
            `expected exact-one article property definition persistence, found ${persistences.join(", ") || "<none>"}`
        );
    }

    for (const absolute of propertyFiles)
    {
        const relative = path.relative(repositoryRoot, absolute);
        const text = readFileSync(absolute, "utf8");
        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/iu.test(text))
        {
            violations.push(`${relative}: client-side schema authority is forbidden`);
        }
        if (/\b(?:jsonb|JsonDocument|JsonElement)\b/iu.test(text))
        {
            violations.push(`${relative}: opaque JSON definition state is forbidden`);
        }
        if (/\b(?:formula|rollup|script)\s*[:=]/iu.test(text) ||
            /\beval\s*\(|\bfetch\s*\(|\bnew\s+Function\s*\(/u.test(text))
        {
            violations.push(`${relative}: formula/rollup/script/eval/fetch execution is forbidden`);
        }
        if (
            /article[-_ ]?reference.{0,80}\b(?:title|slug)\b/iu.test(text) ||
            /\b(?:title|slug)\b.{0,80}article[-_ ]?reference/iu.test(text)
        )
        {
            violations.push(`${relative}: article references must use stable article IDs, not title/slug`);
        }
    }

    const modelSource = [
        ...contractFiles,
        storeFile,
        persistenceFile
    ].map((relative) => source(repositoryRoot, relative)).join("\n");
    const typeNames = [
        '"text"',
        '"number"',
        '"boolean"',
        '"date"',
        '"single-select"',
        '"multi-select"',
        '"article-reference"',
        '"url"'
    ];
    for (const typeName of typeNames)
    {
        if (!modelSource.includes(typeName))
        {
            violations.push(`${contractFiles[1]}: closed type registry lost ${typeName}`);
        }
    }
    if (!/TypeNames/u.test(modelSource) || !/ParseType/u.test(modelSource))
    {
        violations.push(`${contractFiles[1]}: type parsing must remain closed and versioned`);
    }
    for (const required of [
        "article_property_type_unknown",
        "article_property_operator_unknown",
        "article_property_type_change_requires_new_definition",
        "article_property_delete_impact_unknown",
        "article_property_idempotency_conflict",
        "article_property_schema_revision_cas_stale",
        "article_property_owner_revision_cas_stale",
        "article_property_url_unsafe_scheme",
        "article_property_option_duplicate",
        "article_property_default_required"
    ])
    {
        if (!modelSource.includes(required))
        {
            violations.push(`${contractFiles[1]}: missing fail-closed policy ${required}`);
        }
    }
    for (const required of [
        "ArticlePropertyReferencePolicy",
        "ArticlePropertyUrlPolicy",
        "ArticlePropertyDefinitionWriteReceipt",
        "ArticlePropertyDefinitionObligation",
        "ArticlePropertyDefinitionPageCursor"
    ])
    {
        if (!modelSource.includes(required))
        {
            violations.push(`${contractFiles[0]}: missing definition authority fact ${required}`);
        }
    }

    const persistenceSource = source(repositoryRoot, persistenceFile);
    const writeTargets = [
        ...persistenceSource.matchAll(
            /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu
        )
    ].map((match) => match[1].toLowerCase());
    const foreignWrites = [...new Set(
        writeTargets.filter(
            (table) => !table.startsWith("article_property_definition")
        )
    )];
    if (foreignWrites.length > 0)
    {
        violations.push(`${persistenceFile}: non-definition writes are forbidden (${foreignWrites.join(", ")})`);
    }
    if (!/pg_advisory_xact_lock/u.test(persistenceSource))
    {
        violations.push(`${persistenceFile}: owner CAS must be serialized by an advisory transaction lock`);
    }
    if (!/article_property_definition_idempotency/u.test(persistenceSource) ||
        !/article_property_definition_receipt/u.test(persistenceSource))
    {
        violations.push(`${persistenceFile}: receipt and idempotency writes are mandatory`);
    }

    const migrationSource = source(repositoryRoot, migrationFile);
    for (const required of [
        "article_property_definition_owner",
        "article_property_definition",
        "article_property_definition_display_name",
        "article_property_definition_option",
        "article_property_definition_option_label",
        "article_property_definition_receipt",
        "article_property_definition_obligation",
        "article_property_definition_idempotency"
    ])
    {
        if (!migrationSource.includes(required))
        {
            violations.push(`${migrationFile}: missing durable definition element ${required}`);
        }
    }
    if (/\b(?:jsonb|JsonDocument|JsonElement)\b/iu.test(migrationSource))
    {
        violations.push(`${migrationFile}: opaque JSON schema state is forbidden`);
    }
    if (!/content_digest\s+varchar\(64\)/u.test(migrationSource) ||
        !/schema_revision\s+bigint/u.test(migrationSource))
    {
        violations.push(`${migrationFile}: schema revision and content digest are mandatory`);
    }

    const verifierSource = source(repositoryRoot, verifierFile);
    for (const required of [
        "ValidateDefinition",
        "ValidateReceipt",
        "ReceiptLimitExceeded",
        "AuditLinks",
        "IdempotencyRecords"
    ])
    {
        if (!verifierSource.includes(required))
        {
            violations.push(`${verifierFile}: independent verifier lost ${required}`);
        }
    }

    const registrationSource = source(repositoryRoot, registrationFile);
    for (const registration of [
        "AddScoped<IArticlePropertyDefinitionPersistence, PostgresArticlePropertyDefinitionPersistence>",
        "AddScoped<IArticlePropertyDefinitionStore, ArticlePropertyDefinitionStore>",
        "AddScoped<IArticlePropertyDefinitionPermissionAuthority, ArticlePropertyDefinitionPermissionAuthority>",
        "AddScoped<IArticlePropertyDefinitionImpactAuthority, UnavailableArticlePropertyDefinitionImpactAuthority>"
    ])
    {
        const occurrences = registrationSource.split(registration).length - 1;
        if (occurrences !== 1)
        {
            violations.push(`${registrationFile}: ${registration} must have exactly one runtime registration`);
        }
    }

    const runtimeSource = source(repositoryRoot, runtimeTableFile);
    for (const table of [
        "article_property_definition_owner",
        "article_property_definition",
        "article_property_definition_display_name",
        "article_property_definition_option",
        "article_property_definition_option_label",
        "article_property_definition_receipt",
        "article_property_definition_obligation",
        "article_property_definition_idempotency"
    ])
    {
        if (!runtimeSource.includes(`"${table}"`))
        {
            violations.push(`${runtimeTableFile}: runtime rollup catalog lost ${table}`);
        }
    }

    const auditSource = source(repositoryRoot, auditWriterFile);
    const auditTargets = [
        ...auditSource.matchAll(
            /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu
        )
    ].map((match) => match[1].toLowerCase());
    if (auditTargets.length !== 1 || auditTargets[0] !== "sys_audit_log")
    {
        violations.push(`${auditWriterFile}: signed audit writer may only append to sys_audit_log`);
    }

    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const violations = checkArticlePropertyDefinitionAuthority();
    if (violations.length > 0)
    {
        console.error("[article-property-definition-authority] failed");
        for (const violation of violations)
        {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    }
    else
    {
        console.log(
            "[article-property-definition-authority] passed: exact-one server authority, eight closed types, CAS receipts and fail-closed policies"
        );
    }
}

export { checkArticlePropertyDefinitionAuthority };
