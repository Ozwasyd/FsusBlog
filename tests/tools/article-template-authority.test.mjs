import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkArticleTemplateAuthority } from "../../tools/governance/check-article-template-authority.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const owned = [
    "src/backend/Services/Authoring/ArticleTemplateStore.cs",
    "src/backend/Services/Authoring/ArticleTemplateContracts.cs",
    "src/backend/Services/Authoring/ArticleTemplateCoreModels.cs",
    "src/backend/Services/Authoring/ArticleTemplateStateModels.cs",
    "src/backend/Services/Authoring/ArticleTemplateAuthorityContracts.cs",
    "src/backend/Services/Authoring/ArticleTemplateCommands.cs",
    "src/backend/Services/Authoring/ArticleTemplateReceiptContract.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Mapping.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Storage.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplatePersistence.Writes.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplateReferenceAuthority.cs",
    "src/backend/Services/Authoring/ArticleTemplateVerifier.cs",
    "src/backend/Services/Authoring/AuthoringSignedAuditWriter.cs",
    "src/migration/Definitions/ArticleTemplateAuthorityMigrationDefinitions.cs",
    "src/migration/Catalogs/SchemaMigrationCatalog20260905ArticleTemplates.cs",
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs",
    "src/backend/Services/Authoring/ArticleTemplateExpansionContracts.cs",
    "src/backend/Services/Authoring/ArticleTemplateExpansionDigest.cs",
    "src/backend/Services/Authoring/ArticleTemplateExpansionEngine.cs",
    "src/backend/Services/Authoring/ArticleTemplateExpansionPlanner.cs",
    "src/backend/Services/Authoring/ArticleTemplateExpansionVerifier.cs",
    "src/backend/Services/Authoring/PostgresArticleTemplateExpansionAuthority.cs",
];

function fixture() {
    const target = fs.mkdtempSync(
        path.join(os.tmpdir(), "article-template-authority-"),
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

test("current article template authority satisfies static governance", () => {
    assert.deepEqual(checkArticleTemplateAuthority(root), []);
});

test("governance rejects a second template store or client-side authority", () => {
    const target = fixture();
    mutate(target, owned[0], (source) =>
        source
            .replace(
                "public sealed class ArticleTemplateStore(",
                "public sealed class ArticleTemplateReplicaStore {\n    private ArticleTemplateReplicaStore() { }\n}\n\npublic sealed class ArticleTemplateStore(",
            )
            .concat("\n// localStorage fallback"),
    );
    const errors = checkArticleTemplateAuthority(target);
    assert.ok(
        errors.some((error) =>
            error.includes("exact-one article template store"),
        ),
    );
    assert.ok(
        errors.some((error) =>
            error.includes("client-side template authority"),
        ),
    );
});

test("governance rejects default/last template preference fields", () => {
    const target = fixture();
    mutate(target, owned[3], (source) =>
        source.concat(
            "\npublic sealed record LastTemplatePreference(string LastTemplateId);\n",
        ),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("default/last/recommended template fields"),
        ),
    );
});

test("governance rejects publication state inside template contracts", () => {
    const target = fixture();
    mutate(target, owned[1], (source) =>
        source.concat(
            "\n// PublicationStatus PublishedAt ViewCount SessionId\n",
        ),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("publication, views, comments, history, session"),
        ),
    );
});

test("governance rejects expression engines and remote includes", () => {
    const target = fixture();
    mutate(target, owned[0], (source) =>
        source.concat("\n// Handlebars compile + fetch(https://include)\n"),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("dynamic eval, helper engine, or remote include"),
        ),
    );
});

test("governance rejects non-template writes in the persistence authority", () => {
    const target = fixture();
    mutate(target, owned[8], (source) =>
        source.concat("\n// UPDATE article SET title = 'x'\n"),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("non-template writes"),
        ),
    );
});

test("governance rejects audit writes outside sys_audit_log", () => {
    const target = fixture();
    mutate(target, owned[13], (source) =>
        source.concat("\n// INSERT INTO article_template_receipt SELECT 1\n"),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("sys_audit_log"),
        ),
    );
});

test("governance rejects opaque jsonb template state", () => {
    const target = fixture();
    mutate(target, owned[14], (source) =>
        source.concat(
            "\n-- ALTER TABLE article_template_version ADD COLUMN payload jsonb\n",
        ),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("jsonb"),
        ),
    );
});

test("governance rejects missing immutable guard", () => {
    const target = fixture();
    mutate(target, owned[14], (source) =>
        source.replaceAll("article_template_immutable_guard", "removed_guard"),
    );
    assert.ok(
        checkArticleTemplateAuthority(target).some((error) =>
            error.includes("article_template_immutable_guard"),
        ),
    );
});

test("governance rejects a second expansion planner or article identity in plans", () => {
    const target = fixture();
    mutate(target, owned[17], (source) =>
        source.concat(
            "\npublic sealed class ArticleTemplateExpansionPlannerCopy { }\n",
        ),
    );
    let errors = checkArticleTemplateAuthority(target);
    assert.ok(
        errors.some((error) => error.includes("second expansion engine")),
    );

    const other = fixture();
    mutate(other, owned[17], (source) =>
        source.concat("\n// Guid ArticleId\n"),
    );
    errors = checkArticleTemplateAuthority(other);
    assert.ok(
        errors.some((error) =>
            error.includes("must not carry article identity"),
        ),
    );
});

test("governance rejects HTML round-trips and name lookups in expansion", () => {
    const target = fixture();
    mutate(target, owned[19], (source) =>
        source.concat("\n// Markdig.ToHtml round-trip\n"),
    );
    let errors = checkArticleTemplateAuthority(target);
    assert.ok(
        errors.some((error) => error.includes("HTML rendering round-trips")),
    );

    const other = fixture();
    mutate(other, owned[22], (source) =>
        source.concat("\n// lookup by tag.Name == value\n"),
    );
    errors = checkArticleTemplateAuthority(other);
    assert.ok(errors.some((error) => error.includes("resolution by name")));
});
