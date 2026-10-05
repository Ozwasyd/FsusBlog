import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { checkCanonicalArticleLifecycleAuthority, requiredAuthorityFiles } = await import(
    new URL("../../tools/governance/check-canonical-article-lifecycle-authority.mjs", import.meta.url)
);
const root = path.resolve(import.meta.dirname, "../..");

function fixture()
{
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-lifecycle-authority-"));
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

test("current canonical article lifecycle authority satisfies static governance", () =>
{
    assert.deepEqual(checkCanonicalArticleLifecycleAuthority(root), []);
});

test("governance rejects missing lifecycle authority file", () =>
{
    const target = fixture();
    fs.rmSync(path.join(target, "src/backend/Services/Fixtures/CanonicalArticleLifecycleVerifier.cs"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("required authority file missing")));
});

test("governance rejects lifecycle fixture direct article SQL", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleLifecycleFixturePort.cs", (source) =>
        `${source}\nawait db.Ado.ExecuteCommand("UPDATE article SET status = 0");\n`);
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("directly mutate article lifecycle tables")));
});

test("governance rejects scheduled completion using the future due time as now", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleLifecycleFixturePort.cs", (source) =>
        source.replace(/(scheduledReceipt\.CurrentRevisionId,\s*)now,/u, "$1dueAt,"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("observed business clock")));
});

test("governance rejects a verifier that trusts future transition timestamps", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleLifecycleVerifier.cs", (source) =>
        source.replace("operation.TransitionedAtUtc > now", "false"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("future authority facts")));
});

test("governance rejects lifecycle port without rollback history", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs", (source) =>
        source.replaceAll("RollbackSourceRevisionId", "HistoricalRevisionId"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("rollback coordinates")));
});

test("governance rejects unconditional lifecycle port registration", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs", (source) =>
        `${source}\nservices.AddScoped<ICanonicalArticleLifecycleFixturePort, CanonicalArticleLifecycleFixturePort>();\n`);
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) => item.includes("not be registered for production")));
});
