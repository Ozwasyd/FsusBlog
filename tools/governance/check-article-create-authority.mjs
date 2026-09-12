#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

const contractFile = "src/backend/Services/Authoring/ArticleCreateContracts.cs";
const storeFile = "src/backend/Services/Authoring/ArticleCreateStore.cs";
const verifierFile = "src/backend/Services/Authoring/ArticleCreateVerifier.cs";
const persistenceFile =
    "src/backend/Services/Authoring/PostgresArticleCreatePersistence.cs";
const migrationFile =
    "src/migration/Definitions/ArticleCreateAuthorityMigrationDefinitions.cs";
const catalogFile =
    "src/migration/Catalogs/SchemaMigrationCatalog20260908ArticleCreate.cs";
const registrationFile =
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs";

const ownedFiles = [
    contractFile,
    storeFile,
    verifierFile,
    persistenceFile,
    migrationFile,
    catalogFile,
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

export function checkArticleCreateAuthority(repositoryRoot = root) {
    const violations = [];
    for (const relative of [...ownedFiles, registrationFile]) {
        if (!existsSync(path.join(repositoryRoot, relative))) {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0) {
        return violations;
    }

    const createFiles = walk(path.join(repositoryRoot, "src/backend")).filter(
        (absolute) =>
            /ArticleCreate(?:Store|Command|Receipt|Mode|Persistence|Verifier|Verification|Payload|Snapshot|Exception)|article_create_(?:request|receipt|immutable_guard)/u.test(
                readFileSync(absolute, "utf8"),
            ),
    );

    const writerClasses = new Set();
    for (const absolute of createFiles) {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, "utf8");
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*ArticleCreate[A-Za-z0-9_]*(?:Store|Persistence|Writer|Transaction|Executor|Handler|Service))\b/gu,
        )) {
            writerClasses.add(`${relative}:${match[1]}`);
        }
    }
    const allowedWriters = new Set([
        `${storeFile}:ArticleCreateStore`,
        `${persistenceFile}:PostgresArticleCreatePersistence`,
    ]);
    for (const writer of writerClasses) {
        if (!allowedWriters.has(writer)) {
            violations.push(`second create writer is forbidden: ${writer}`);
        }
    }
    for (const expected of allowedWriters) {
        if (!writerClasses.has(expected)) {
            violations.push(`missing canonical create writer ${expected}`);
        }
    }

    for (const absolute of createFiles) {
        const relative = path.relative(repositoryRoot, absolute);
        const source = readFileSync(absolute, "utf8");
        if (/\b(?:localStorage|sessionStorage|indexedDB)\b/u.test(source)) {
            violations.push(
                `${relative}: client-side create authority is forbidden`,
            );
        }
        if (
            /\b(?:defaultTemplateId|lastTemplateId|recentTemplate|rememberTemplate|defaultTemplate|lastUsedTemplate|lastTemplate|recommendedTemplate|DefaultTemplateId|LastTemplateId|RecentTemplate|RecommendedTemplate)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: default/last/recommended template lookups are forbidden`,
            );
        }
        if (
            /\b(?:SourceArticleId|CopiedFromArticle|OriginalArticleId|CopyArticleState|CloneArticle|DuplicateArticle)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: copying article state into a create is forbidden`,
            );
        }
        if (
            /\b(?:ApplyTemplate|ApplyPlan|DraftThenApply|PromoteDraftToTemplate|AttachTemplateToDraft)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: draft-then-apply template paths are forbidden`,
            );
        }
        if (
            /\bcatch\s*\(\s*(?:OperationCanceledException|TaskCanceledException|TimeoutException)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: cancel/timeout fallback is forbidden`,
            );
        }
        if (
            /\bArticleStatus\.(?:Published|Scheduled|Archived|Deleted)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: create may only write draft-status articles`,
            );
        }
        if (
            /\b(?:async\s+void|Task\.Run|ChannelWriter|BackgroundService|FireAndForget)\b/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: deferred or asynchronous create writes are forbidden`,
            );
        }
        if (
            /\b(?:eval\s*\(|new\s+Function\s*\(|node:vm|\bfetch\s*\(|XMLHttpRequest)/u.test(
                source,
            )
        ) {
            violations.push(
                `${relative}: dynamic eval or remote include is forbidden`,
            );
        }
    }

    const contractSource = readFileSync(
        path.join(repositoryRoot, contractFile),
        "utf8",
    );
    const receiptMatch = contractSource.match(
        /record\s+ArticleCreateReceipt\s*\(([^)]*)\)/su,
    );
    if (!receiptMatch) {
        violations.push(`${contractFile}: ArticleCreateReceipt record missing`);
    } else if (
        /\b(?:Title|Summary|Markdown|Content|Body|Description)\b/u.test(
            receiptMatch[1].replaceAll(/\b\w*Digest\b/gu, ""),
        )
    ) {
        violations.push(
            `${contractFile}: create receipt must not carry article or template body fields`,
        );
    }
    if (
        !/\bBlank\s*=\s*0/u.test(contractSource) ||
        !/\bTemplate\s*=\s*1/u.test(contractSource)
    ) {
        violations.push(
            `${contractFile}: closed create mode must declare exactly blank and template`,
        );
    }
    for (const required of [
        "article_create_mode_invalid",
        "article_create_mode_incomplete_template_set",
        "article_create_plan_binding_invalid",
        "article_create_idempotency_conflict",
    ]) {
        if (
            !contractSource.includes(required) &&
            !readFileSync(
                path.join(repositoryRoot, storeFile),
                "utf8",
            ).includes(required) &&
            !readFileSync(
                path.join(repositoryRoot, persistenceFile),
                "utf8",
            ).includes(required)
        ) {
            violations.push(
                `${contractFile}: fail-closed rejection ${required} is missing`,
            );
        }
    }

    const storeSource = readFileSync(
        path.join(repositoryRoot, storeFile),
        "utf8",
    );
    if (!/ThrowIfCancellationRequested/u.test(storeSource)) {
        violations.push(
            `${storeFile}: create must fail closed on a cancelled request`,
        );
    }
    const resolveIndex = storeSource.indexOf("ResolveRequestAsync");
    const executeIndex = storeSource.indexOf("persistence.ExecuteAsync");
    if (resolveIndex < 0 || executeIndex < 0 || resolveIndex > executeIndex) {
        violations.push(
            `${storeFile}: exact-once request resolution must precede payload resolution and execution`,
        );
    }
    if (!/ArticleCreateMode\.Blank/u.test(storeSource)) {
        violations.push(`${storeFile}: canonical blank create path missing`);
    }

    const persistenceSource = readFileSync(
        path.join(repositoryRoot, persistenceFile),
        "utf8",
    );
    const transactionBoundaries = persistenceSource.match(
        /\bUseTran(?:Async)?\s*\(/gu,
    );
    if (!transactionBoundaries || transactionBoundaries.length !== 1) {
        violations.push(
            `${persistenceFile}: create graph must execute inside exactly one transaction boundary`,
        );
    }
    if (
        !/AuthoringSignedAuditWriter\s*\.\s*InsertAsync/u.test(
            persistenceSource,
        )
    ) {
        violations.push(
            `${persistenceFile}: create audit must go through the signed audit writer`,
        );
    }
    if (/INSERT\s+INTO\s+sys_audit_log/iu.test(persistenceSource)) {
        violations.push(
            `${persistenceFile}: direct sys_audit_log writes are forbidden`,
        );
    }
    if (!/ArticleMutationEventTypes\.Created/u.test(persistenceSource)) {
        violations.push(
            `${persistenceFile}: create outbox event must use the created event type`,
        );
    }
    if (
        /ArticleMutationEventTypes\.(?:ScheduledPublished|RightsProofUpdated|ResponsibilityUpdated)/u.test(
            persistenceSource,
        )
    ) {
        violations.push(
            `${persistenceFile}: publication outbox coordinates are forbidden on create`,
        );
    }
    if (!/TryReplayAsync/u.test(persistenceSource)) {
        violations.push(
            `${persistenceFile}: in-transaction idempotency replay check missing`,
        );
    }

    const migrationSource = readFileSync(
        path.join(repositoryRoot, migrationFile),
        "utf8",
    );
    for (const required of [
        "article_create_request",
        "article_create_receipt",
        "article_create_immutable_guard",
        "ck_article_create_receipt_draft_only",
        "ck_article_create_receipt_template_set",
    ]) {
        if (!migrationSource.includes(required)) {
            violations.push(
                `${migrationFile}: missing durable element ${required}`,
            );
        }
    }
    if (/\bjsonb\b/iu.test(migrationSource)) {
        violations.push(
            `${migrationFile}: opaque jsonb create state is forbidden`,
        );
    }
    if (
        /SchemaMigrationPhase\.PostCodeFirst/u.test(migrationSource) === false
    ) {
        violations.push(
            `${migrationFile}: create authority must stay post-code-first`,
        );
    }

    const catalogSource = readFileSync(
        path.join(repositoryRoot, catalogFile),
        "utf8",
    );
    if (
        !/ArticleVaultExecutionMigrationDefinitions\.MigrationId/u.test(
            catalogSource,
        )
    ) {
        violations.push(
            `${catalogFile}: catalog must depend on the latest earlier post-code-first migration`,
        );
    }

    const verifierSource = readFileSync(
        path.join(repositoryRoot, verifierFile),
        "utf8",
    );
    if (!/violations\.Count\s*==\s*0/u.test(verifierSource)) {
        violations.push(
            `${verifierFile}: verification result must derive from recomputed violations`,
        );
    }
    for (const required of [
        "create_outbox_missing",
        "create_audit_missing",
        "create_draft_only_violated",
        "create_publication_forbidden",
    ]) {
        if (!verifierSource.includes(required)) {
            violations.push(
                `${verifierFile}: missing closure check ${required}`,
            );
        }
    }

    const registrationSource = readFileSync(
        path.join(repositoryRoot, registrationFile),
        "utf8",
    );
    for (const registration of [
        "AddScoped<IArticleCreateStore, ArticleCreateStore>",
        "AddScoped<IArticleCreatePersistence, PostgresArticleCreatePersistence>",
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
    const violations = checkArticleCreateAuthority();
    if (violations.length > 0) {
        console.error("[article-create-authority] failed");
        for (const violation of violations) {
            console.error(`- ${violation}`);
        }
        process.exitCode = 1;
    } else {
        console.log(
            "[article-create-authority] passed: exact-one canonical writer, closed modes, atomic transaction, no fallback or state copy",
        );
    }
}
