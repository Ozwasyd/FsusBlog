import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { checkCanonicalArticlePublicationAuthority, requiredAuthorityFiles } = await import(
    new URL("../../tools/governance/check-canonical-article-publication-authority.mjs", import.meta.url)
);
const root = path.resolve(import.meta.dirname, "../..");

function fixture()
{
    const target = fs.mkdtempSync(
        path.join(os.tmpdir(), "canonical-pub-authority-")
    );
    for (const relative of requiredAuthorityFiles)
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

test("current canonical article publication authority satisfies static governance", () =>
{
    assert.deepEqual(checkCanonicalArticlePublicationAuthority(root), []);
});

test("governance rejects missing authority file", () =>
{
    const target = fixture();
    fs.rmSync(path.join(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationVerifier.cs"));
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("required authority file missing")));
});

test("governance rejects fixture port registered unconditionally outside fixture block", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs", (source) =>
        source + "\nservices.AddScoped<ICanonicalArticlePublicationFixturePort, CanonicalArticlePublicationFixturePort>();\n"
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("outside fixture block")));
});

test("governance rejects direct SQL in fixture port", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs", (source) =>
        source + '\nawait db.Ado.ExecuteCommand("INSERT INTO article values (1)");\n'
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("direct raw SQL execution prohibited")));
});

test("governance rejects manual Redis in fixture port", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs", (source) =>
        source + "\n// Redis connection\nvar redis = ConnectionMultiplexer.Connect();\n"
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("manual Redis usage prohibited")));
});

test("governance rejects removing admin 0 rejection", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs", (source) =>
        source.replace("AdminPrincipalId <= 0", "AdminPrincipalId < 0")
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("AdminPrincipalId <= 0")));
});

test("governance rejects removing recompute sentinel rejection", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs", (source) =>
        source.replace('contains prohibited recompute sentinel.', 'sentinel')
              .replace('"rights_recompute_sentinel_forbidden"', '"other"')
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("recompute sentinel")));
});

test("governance rejects production not calling shared seams", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/ArticleService.cs", (source) =>
        source
            .replaceAll("ArticleProductionNormalizers.NormalizeArticleRights", "NormalizeArticleRightsLocal")
            .replaceAll("ArticleRightsSnapshotBuilder.Build", "BuildRightsLocal")
            .replaceAll("ArticleRightsPolicyPersistence.UpsertAsync", "UpsertRightsLocal")
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("ArticleProductionNormalizers.NormalizeArticleRights")
        || v.includes("ArticleRightsSnapshotBuilder.Build")
        || v.includes("ArticleRightsPolicyPersistence.UpsertAsync")));
});

test("governance rejects fixture port without create mutation authority call", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs", (source) =>
        source.replaceAll("ArticleCreateMutationAuthority.ExecuteAsync", "LegacyFixtureCreateAsync")
    );
    const violations = checkCanonicalArticlePublicationAuthority(target);
    assert.ok(violations.some((v) => v.includes("ArticleCreateMutationAuthority.ExecuteAsync")));
});
