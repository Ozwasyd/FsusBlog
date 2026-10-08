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

test("governance rejects copying preparation projection facts during independent verification", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.Verification.cs", source =>
        source.replace("projectionVerifier.VerifyAsync(\n                        lifecycle, invocation.Binding, cancellationToken)", "projectionVerifier.PrepareAsync(lifecycle, invocation.Binding, cancellationToken)"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some(item => item.includes("reread and match the sealed projection aggregate")));
});

test("governance rejects independent observation without its original sealed aggregate comparison", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.Verification.cs", source =>
        source.replace('"projectionAggregate", "requiredProjectionEdgesVerified"', '"status", "requiredProjectionEdgesVerified"'));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some(item => item.includes("reread and match the sealed projection aggregate")));
});

for (const [id, original, replacement] of [
    ["copied preparation", "projectionVerifier.VerifyAsync(\n                        preparedPublication, invocation.Request, cancellationToken)",
        "projectionVerifier.PrepareAsync(preparedPublication, invocation.Request, cancellationToken)"],
    ["receipt-only invocation", "preparedPublication, invocation.Request, cancellationToken)",
        "preparedPublication, cancellationToken)"],
    ["missing original invocation", "RequirePublicationInvocation(snapshot, id)",
        "DiscoverPublicationInvocation(id)"],
    ["missing sealed aggregate comparison", '"projectionAggregate", "requiredProjectionEdgesVerified"',
        '"status", "requiredProjectionEdgesVerified"']
])
{
    test(`governance rejects publication projection ${id}`, (context) =>
    {
        const target = fixture();
        context.after(() => fs.rmSync(target, { recursive: true, force: true }));
        mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.Verification.cs", source =>
        {
            const start = source.indexOf('else if (original.Fields.ContainsKey("projectionAggregate"))');
            assert.ok(start >= 0);
            assert.ok(source.slice(start).includes(original));
            return source.slice(0, start) + source.slice(start).replace(original, replacement);
        });
        assert.ok(checkCanonicalArticleLifecycleAuthority(target).some(item =>
            item.includes("publication verification must reread and match the sealed projection aggregate")));
    });
}

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

test("governance rejects a second handwritten required edge list", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs", (source) =>
        source.replaceAll("ArticleMutationReplayEdges.Required", "new HashSet<string>()"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
        item.includes("production required edge contract")));
});

test("governance rejects fixture projection rebuild fallback", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs", (source) =>
        `${source}\nconst string fallback = "public-hot-rebuild";\n`);
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
        item.includes("must not repair required projections")));
});

test("governance rejects a lifecycle branch routed through legacy rebuilds", (context) =>
{
    const target = fixture();
    context.after(() => fs.rmSync(target, { recursive: true, force: true }));
    mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs", (source) =>
        source.replaceAll("if (capabilities.Any(IsLifecycleCapability))", "if (false)"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
        item.includes("isolated from non-canonical rebuilds")));
});

test("governance rejects projection verifier writes", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs", (source) =>
        `${source}\nawait projectionStore.UpsertAsync(default);\n`);
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
        item.includes("must remain read-only")));
});

for (const write of ["StringIncrementAsync", "KeyDeleteAsync", "SortedSetAddAsync", "ScriptEvaluateAsync"])
{
    test(`governance rejects manual Redis ${write} in canonical projection verification`, (context) =>
    {
        const target = fixture();
        context.after(() => fs.rmSync(target, { recursive: true, force: true }));
        mutate(target, "src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs", (source) =>
            `${source}\nawait redis.${write}("fixture-key");\n`);
        assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
            item.includes("must not repair required projections")));
        mutate(target, "src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs", (source) =>
            `${source}\nawait redis.${write}("fixture-key");\n`);
        assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
            item.includes("must remain read-only")));
    });
}

test("governance rejects a verifier detached from current-run authority refs", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs", (source) =>
        source.replaceAll("authority.RunId", "string.Empty")
            .replaceAll("authority.Namespace", "string.Empty")
            .replaceAll("authority.ReceiptDigest", "string.Empty"));
    assert.ok(checkCanonicalArticleLifecycleAuthority(target).some((item) =>
        item.includes("bind current-run authority")));
});
