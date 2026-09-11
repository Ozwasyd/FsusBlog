#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

const storeFile = "src/backend/Services/Authoring/ArticleTemplateStore.cs";
const contractFiles = [
    "src/backend/Services/Authoring/ArticleTemplateContracts.cs",
    "src/backend/Services/Authoring/ArticleTemplateCoreModels.cs",
    "src/backend/Services/Authoring/ArticleTemplateStateModels.cs",
    "src/backend/Services/Authoring/ArticleTemplateAuthorityContracts.cs",
    "src/backend/Services/Authoring/ArticleTemplateCommands.cs",
    "src/backend/Services/Authoring/ArticleTemplateReceiptContract.cs",
];
const persistenceFiles = [
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Mapping.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Storage.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Writes.cs",
];
const referenceAuthorityFile =
    "src/backend/Services/Authoring/PostgresArticleTemplateReferenceAuthority.cs";
const verifierFile =
    "src/backend/Services/Authoring/ArticleTemplateVerifier.cs";
const auditWriterFile =
    "src/backend/Services/Authoring/AuthoringSignedAuditWriter.cs";
const migrationFile =
    "src/migration/Definitions/ArticleTemplateAuthorityMigrationDefinitions.cs";
const catalogFile =
    "src/migration/Catalogs/SchemaMigrationCatalog20260905ArticleTemplates.cs";
const registrationFile =
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs";
const expansionContractFile =
    "src/backend/Services/Authoring/ArticleTemplateExpansionContracts.cs";
const expansionDigestFile =
    "src/backend/Services/Authoring/ArticleTemplateExpansionDigest.cs";
const expansionEngineFile =
    "src/backend/Services/Authoring/ArticleTemplateExpansionEngine.cs";
const expansionPlannerFile =
    "src/backend/Services/Authoring/ArticleTemplateExpansionPlanner.cs";
const expansionVerifierFile =
    "src/backend/Services/Authoring/ArticleTemplateExpansionVerifier.cs";
const expansionAuthorityFile =
    "src/backend/Services/Authoring/PostgresArticleTemplateExpansionAuthority.cs";
const expansionFiles = [
    expansionContractFile,
    expansionDigestFile,
    expansionEngineFile,
    expansionPlannerFile,
    expansionVerifierFile,
    expansionAuthorityFile,
];

const ownedFiles = [
    storeFile,
    ...contractFiles,
    ...persistenceFiles,
    referenceAuthorityFile,
    verifierFile,
    auditWriterFile,
    migrationFile,
    catalogFile,
    ...expansionFiles,
];

function walk(directory) {
    if (!existsSync(directory)) {
        return [];
    }
    const files = [];
    const pending = [directory];
    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(absolute);
            } else if (entry.isFile() && /\.(?:cs|ts|vue)$/u.test(entry.name)) {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function checkArticleTemplateAuthority(repositoryRoot = root) {
    const violations = [];
    for (const relative of [...ownedFiles, registrationFile]) {
        if (!existsSync(path.join(repositoryRoot, relative))) {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0) {
        return violations;
    }

    const templateFiles = walk(path.join(repositoryRoot, "src")).filter(
        (absolute) =>
            /ArticleTemplate|article_template/iu.test(
                readFileSync(absolute, "utf8"),
            ),
    );

    const storeClasses = new Set();
    const persistenceClasses = new Set();
    for (const absolute of templateFiles) {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, "utf8");
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticleTemplate[A-Za-z0-9_]*Store)\b/gu,
        )) {
            storeClasses.add(`${relative}:${match[1]}`);
        }
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticleTemplate[A-Za-z0-9_]*Persistence)\b/gu,
        )) {
            persistenceClasses.add(match[1]);
        }
    }
    const stores = [...storeClasses];
    if (
        stores.length !== 1 ||
        stores[0] !== `${storeFile}:ArticleTemplateStore`
    ) {
        violations.push(
            `expected exact-one article template store, found ${stores.join(", ") || "<none>"}`,
        );
    }
    const persistences = [...persistenceClasses];
    if (
        persistences.length !== 1 ||
        persistences[0] !== "PostgresArticleTemplatePersistence"
    ) {
        violations.push(
            `expected exact-one article template persistence, found ${persistences.join(", ") || "<none>"}`,
        );
    }

    for (const absolute of templateFiles) {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, "utf8");
        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/u.test(source)) {
            violations.push(
                `${relative}: client-side template authority is forbidden`,
            );
        }
        if (
            /\b(?:defaultTemplateId|lastTemplateId|recentTemplate|rememberTemplate|defaultTemplate|lastUsedTemplate|lastTemplate|recommendedTemplate)\b/iu.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: automatic default/last/recommended template fields are forbidden`,
            );
        }
        if (
            /\bHandlebars\b|\beval\s*\(|new\s+Function\s*\(|node:vm|\bfetch\s*\(|XMLHttpRequest/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: dynamic eval, helper engine, or remote include is forbidden`,
            );
        }
        if (
            /\b(?:SourceArticleId|CopiedFromArticle|OriginalArticleId|CopyArticleState)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: copying article state into a template is forbidden`,
            );
        }
    }

    const modelSource = contractFiles
        .map((relative) =>
            readFileSync(path.join(repositoryRoot, relative), "utf8"),
        )
        .join("\n");
    if (
        /\b(?:Published|Scheduled|PublishedAt|ViewCount|Views\b|CommentCount|SessionId|HistoryId|PublicationStatus|RevisionId)\b/u.test(
            modelSource,
        )
    ) {
        violations.push(
            "template contracts must not own publication, views, comments, history, session, or revision identity fields",
        );
    }
    const contractSource = readFileSync(
        path.join(repositoryRoot, contractFiles[0]),
        "utf8",
    );
    if (
        !/article_template_html_authority_forbidden/u.test(contractSource) ||
        !/article_template_expression_forbidden/u.test(contractSource)
    ) {
        violations.push(
            `${contractFiles[0]}: closed source schema must reject HTML and arbitrary expressions`,
        );
    }
    for (const token of ['"title"', '"date"', '"author"', '"site_locale"']) {
        if (!contractSource.includes(token)) {
            violations.push(
                `${contractFiles[0]}: closed variable registry lost token ${token}`,
            );
        }
    }

    for (const relative of persistenceFiles) {
        const source = readFileSync(
            path.join(repositoryRoot, relative),
            "utf8",
        );
        const writeTargets = [
            ...source.matchAll(
                /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu,
            ),
        ].map((match) => match[1].toLowerCase());
        const foreignWrites = [
            ...new Set(
                writeTargets.filter(
                    (table) => !table.startsWith("article_template"),
                ),
            ),
        ];
        if (foreignWrites.length > 0) {
            violations.push(
                `${relative}: non-template writes are forbidden (${foreignWrites.join(", ")})`,
            );
        }
    }

    const auditSource = readFileSync(
        path.join(repositoryRoot, auditWriterFile),
        "utf8",
    );
    const auditTargets = [
        ...auditSource.matchAll(
            /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/giu,
        ),
    ].map((match) => match[1].toLowerCase());
    if (auditTargets.length !== 1 || auditTargets[0] !== "sys_audit_log") {
        violations.push(
            `${auditWriterFile}: signed audit writer may only append to sys_audit_log`,
        );
    }
    if (!/pg_advisory_xact_lock/u.test(auditSource)) {
        violations.push(
            `${auditWriterFile}: audit chain tail reads must stay serialized per chain`,
        );
    }

    const migrationSource = readFileSync(
        path.join(repositoryRoot, migrationFile),
        "utf8",
    );
    for (const required of [
        "article_template_definition",
        "article_template_version",
        "article_template_receipt",
        "article_template_idempotency",
        "article_template_immutable_guard",
    ]) {
        if (!migrationSource.includes(required)) {
            violations.push(
                `${migrationFile}: missing durable element ${required}`,
            );
        }
    }
    if (/\bjsonb\b/iu.test(migrationSource)) {
        violations.push(
            `${migrationFile}: opaque jsonb template state is forbidden`,
        );
    }
    if (/REFERENCES\s+article\b/iu.test(migrationSource)) {
        violations.push(
            `${migrationFile}: template tables must not hard-depend on the article ledger`,
        );
    }

    const expansionClassExpectations = new Map([
        ["ArticleTemplateExpansionEngine", expansionEngineFile],
        ["ArticleTemplateExpansionPlanner", expansionPlannerFile],
        ["ArticleTemplateExpansionVerifier", expansionVerifierFile],
        ["PostgresArticleTemplateExpansionAuthority", expansionAuthorityFile],
    ]);
    const expansionClasses = new Set();
    for (const absolute of templateFiles) {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, "utf8");
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticleTemplateExpansion(?:Engine|Planner|Verifier|Authority)[A-Za-z0-9_]*)\b/gu,
        )) {
            expansionClasses.add(`${relative}:${match[1]}`);
        }
    }
    for (const [className, relative] of expansionClassExpectations) {
        if (!expansionClasses.has(`${relative}:${className}`)) {
            violations.push(
                `missing expansion authority ${className} in ${relative}`,
            );
        }
        expansionClasses.delete(`${relative}:${className}`);
    }
    if (expansionClasses.size > 0) {
        violations.push(
            `second expansion engine or planner is forbidden: ${[...expansionClasses].join(", ")}`,
        );
    }

    const expansionContractSource = readFileSync(
        path.join(repositoryRoot, expansionContractFile),
        "utf8",
    );
    if (
        /\b(?:ArticleId|DraftId|RevisionId|PublicationStatus|PublishedAt)\b/u.test(
            expansionContractSource,
        )
    ) {
        violations.push(
            `${expansionContractFile}: expansion plans must not carry article identity or execution state`,
        );
    }
    const expansionEngineSource = readFileSync(
        path.join(repositoryRoot, expansionEngineFile),
        "utf8",
    );
    if (
        /\b(?:ToHtml|Markdig|HtmlAgilityPack|Markdown\.Render|DOMPurify)\b/u.test(
            expansionEngineSource,
        )
    ) {
        violations.push(
            `${expansionEngineFile}: HTML rendering round-trips are forbidden in expansion`,
        );
    }
    if (!/\bReplace\b/u.test(expansionEngineSource)) {
        violations.push(
            `${expansionEngineFile}: closed marker substitution must stay byte-preserving`,
        );
    }
    const expansionAuthoritySource = readFileSync(
        path.join(repositoryRoot, expansionAuthorityFile),
        "utf8",
    );
    if (/\.Name\s*==|name_key|Where\(.*Name/iu.test(expansionAuthoritySource)) {
        violations.push(
            `${expansionAuthorityFile}: reference resolution by name is forbidden`,
        );
    }

    const registrationSource = readFileSync(
        path.join(repositoryRoot, registrationFile),
        "utf8",
    );
    for (const registration of [
        "AddScoped<IArticleTemplateStore, ArticleTemplateStore>",
        "AddScoped<IArticleTemplatePersistence, PostgresArticleTemplatePersistence>",
        "AddScoped<IArticleTemplateVerifier, ArticleTemplateVerifier>",
        "AddScoped<IArticleTemplateExpansionPlanner, ArticleTemplateExpansionPlanner>",
        "AddScoped<IArticleTemplateExpansionVerifier, ArticleTemplateExpansionVerifier>",
        "AddScoped<IArticleTemplateExpansionAuthority, PostgresArticleTemplateExpansionAuthority>",
    ]) {
        const occurrences = registrationSource.split(registration).length - 1;
        if (occurrences !== 1) {
            violations.push(
                `${registrationFile}: ${registration} must have exactly one runtime DI registration`,
            );
        }
    }
    return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const violations = checkArticleTemplateAuthority();
    if (violations.length > 0) {
        console.error("[article-template-authority] failed");
        for (const violation of violations) {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    } else {
        console.log(
            "[article-template-authority] passed: exact-one authority, closed schema, immutable versions, no automatic template state",
        );
    }
}
