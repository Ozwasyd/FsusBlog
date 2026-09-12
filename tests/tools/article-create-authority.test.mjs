import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkArticleCreateAuthority } from "../../tools/governance/check-article-create-authority.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const owned = [
    "src/backend/Services/Authoring/ArticleCreateContracts.cs",
    "src/backend/Services/Authoring/ArticleCreateStore.cs",
    "src/backend/Services/Authoring/ArticleCreateVerifier.cs",
    "src/backend/Services/Authoring/PostgresArticleCreatePersistence.cs",
    "src/migration/Definitions/ArticleCreateAuthorityMigrationDefinitions.cs",
    "src/migration/Catalogs/SchemaMigrationCatalog20260908ArticleCreate.cs",
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs",
];

function fixture() {
    const target = fs.mkdtempSync(
        path.join(os.tmpdir(), "article-create-authority-"),
    );
    for (const relative of owned) {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, relative), destination);
    }
    return target;
}

function mutate(target, relative, transform) {
    const absolute = path.join(target, relative);
    fs.writeFileSync(absolute, transform(fs.readFileSync(absolute, "utf8")));
}

test("current article create authority satisfies static governance", () => {
    assert.deepEqual(checkArticleCreateAuthority(root), []);
});

test("governance rejects a second create writer", () => {
    const target = fixture();
    mutate(target, owned[1], (source) =>
        source.replace(
            "public sealed class ArticleCreateStore(",
            "public sealed class ArticleCreateBackupWriter {\n    private ArticleCreateBackupWriter() { }\n}\n\npublic sealed class ArticleCreateStore(",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("second create writer"),
        ),
    );
});

test("governance rejects default/last template lookups", () => {
    const target = fixture();
    mutate(target, owned[0], (source) =>
        source.concat(
            "\npublic sealed record LastUsedTemplatePreference(Guid LastTemplateId);\n",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("default/last/recommended"),
        ),
    );
});

test("governance rejects copied article state", () => {
    const target = fixture();
    mutate(target, owned[0], (source) =>
        source.concat("\n// int SourceArticleId from CopiedFromArticle\n"),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("copying article state"),
        ),
    );
});

test("governance rejects cancel fallback and deferred writes", () => {
    const target = fixture();
    mutate(target, owned[1], (source) =>
        source.concat(
            "\n// catch (OperationCanceledException) fallback + Task.Run apply\n",
        ),
    );
    const errors = checkArticleCreateAuthority(target);
    assert.ok(errors.some((error) => error.includes("cancel/timeout fallback")));
    assert.ok(
        errors.some((error) => error.includes("deferred or asynchronous")),
    );
});

test("governance rejects non-draft status writes on create", () => {
    const target = fixture();
    mutate(target, owned[3], (source) =>
        source.replace(
            "Status = ArticleStatus.Draft",
            "Status = ArticleStatus.Published",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("draft-status"),
        ),
    );
});

test("governance rejects split transaction boundaries", () => {
    const target = fixture();
    mutate(target, owned[3], (source) =>
        source.concat(
            "\n// await db.Ado.UseTranAsync(() => Task.CompletedTask);\n",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("exactly one transaction boundary"),
        ),
    );
});

test("governance rejects direct audit writes and missing replay check", () => {
    const target = fixture();
    mutate(target, owned[3], (source) =>
        source.concat("\n// INSERT INTO sys_audit_log VALUES (1)\n"),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("sys_audit_log"),
        ),
    );

    const other = fixture();
    mutate(other, owned[3], (source) =>
        source.replaceAll("TryReplayAsync", "RemovedReplayCheck"),
    );
    assert.ok(
        checkArticleCreateAuthority(other).some((error) =>
            error.includes("idempotency replay check missing"),
        ),
    );
});

test("governance rejects request resolution ordered after execution", () => {
    const target = fixture();
    mutate(target, owned[1], (source) =>
        source
            .replaceAll("ResolveRequestAsync", "DeferredRequestLookup")
            .replace(
                "persistence.ExecuteAsync",
                "persistence.ExecuteAsync /* ResolveRequestAsync removed */",
            ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("exact-once request resolution"),
        ),
    );
});

test("governance rejects body fields on the create receipt", () => {
    const target = fixture();
    mutate(target, owned[0], (source) =>
        source.replace(
            "    string ContentDigest,",
            "    string ContentDigest,\n    string Title,\n    string MarkdownContent,",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("body fields"),
        ),
    );
});

test("governance rejects missing durable ledger elements", () => {
    const target = fixture();
    mutate(target, owned[4], (source) =>
        source.replaceAll("article_create_immutable_guard", "removed_guard"),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("article_create_immutable_guard"),
        ),
    );
});

test("governance rejects a second DI registration", () => {
    const target = fixture();
    mutate(target, owned[6], (source) =>
        source.replace(
            "services.AddScoped<IArticleCreateStore, ArticleCreateStore>();",
            "services.AddScoped<IArticleCreateStore, ArticleCreateStore>();\n        services.AddScoped<IArticleCreateStore, ArticleCreateStore>();",
        ),
    );
    assert.ok(
        checkArticleCreateAuthority(target).some((error) =>
            error.includes("exactly one runtime DI registration"),
        ),
    );
});
