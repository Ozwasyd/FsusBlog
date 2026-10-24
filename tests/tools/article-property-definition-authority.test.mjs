import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {checkArticlePropertyDefinitionAuthority} = await import(
    new URL(
        "../../tools/governance/check-article-property-definition-authority.mjs",
        import.meta.url
    )
);
const root = path.resolve(import.meta.dirname, "../..");
const owned = [
    "src/backend/Services/Authoring/ArticlePropertyDefinitionStore.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionCoreModels.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionContracts.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionAuthorityContracts.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionCommands.cs",
    "src/backend/Services/Authoring/PostgresArticlePropertyDefinitionPersistence.cs",
    "src/backend/Services/Authoring/ArticlePropertyDefinitionVerifier.cs",
    "src/migration/Definitions/ArticlePropertyDefinitionAuthorityMigrationDefinitions.cs",
    "src/migration/Catalogs/SchemaMigrationCatalog20260915ArticlePropertyDefinitions.cs",
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs",
    "src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs",
    "src/backend/Services/Authoring/AuthoringSignedAuditWriter.cs"
];

function fixture()
{
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "article-property-definition-authority-"));
    for (const relative of owned)
    {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, relative), destination);
    }
    return target;
}

function mutate(target, relative, transform)
{
    const absolute = path.join(target, relative);
    fs.writeFileSync(absolute, transform(fs.readFileSync(absolute, "utf8")));
}

test("current article property definition authority satisfies static governance", () =>
{
    assert.deepEqual(checkArticlePropertyDefinitionAuthority(root), []);
});

test("governance rejects a second store and client-side schema authority", () =>
{
    const target = fixture();
    mutate(target, owned[0], (source) => source
        .replace(
            "public sealed class ArticlePropertyDefinitionStore(",
            "public sealed class ArticlePropertyDefinitionReplicaStore { }\n\npublic sealed class ArticlePropertyDefinitionStore("
        )
        .concat("\n// localStorage schema fallback"));
    const errors = checkArticlePropertyDefinitionAuthority(target);
    assert.ok(errors.some((error) => error.includes("exact-one article property definition store")));
    assert.ok(errors.some((error) => error.includes("client-side schema authority")));
});

test("governance rejects opaque JSON, executable policy and display-name references", () =>
{
    const target = fixture();
    mutate(target, owned[2], (source) => source.concat("\n// jsonb formula: eval(fetch(url))\n"));
    let errors = checkArticlePropertyDefinitionAuthority(target);
    assert.ok(errors.some((error) => error.includes("opaque JSON definition state")));
    assert.ok(errors.some((error) => error.includes("formula/rollup/script/eval/fetch")));

    const other = fixture();
    mutate(other, owned[1], (source) => source.concat("\n// article reference by title or slug\n"));
    errors = checkArticlePropertyDefinitionAuthority(other);
    assert.ok(errors.some((error) => error.includes("stable article IDs, not title/slug")));
});

test("governance rejects foreign persistence writes and missing durable elements", () =>
{
    const target = fixture();
    mutate(target, owned[5], (source) => source.concat("\n// UPDATE article SET title = 'unsafe'\n"));
    assert.ok(checkArticlePropertyDefinitionAuthority(target).some((error) => error.includes("non-definition writes")));

    const other = fixture();
    mutate(other, owned[7], (source) => source.replaceAll("article_property_definition_obligation", "removed_obligation"));
    assert.ok(checkArticlePropertyDefinitionAuthority(other).some((error) => error.includes("missing durable definition element article_property_definition_obligation")));
});
