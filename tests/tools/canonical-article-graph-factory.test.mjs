import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { checkCanonicalArticleGraphFactoryAuthority, requiredAuthorityFiles } = await import(
    new URL("../../tools/governance/check-canonical-article-graph-factory.mjs", import.meta.url)
);
const root = path.resolve(import.meta.dirname, "../..");

function fixture()
{
    const target = fs.mkdtempSync(
        path.join(os.tmpdir(), "canonical-graph-factory-")
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

test("current canonical article graph factory satisfies static governance", () =>
{
    assert.deepEqual(checkCanonicalArticleGraphFactoryAuthority(root), []);
});

test("governance rejects missing authority file", () =>
{
    const target = fixture();
    fs.rmSync(path.join(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphVerifier.cs"));
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("required authority file missing")));
});

test("governance rejects direct SQL in factory", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs", (source) =>
        source + '\n// direct sql\nvar q = "SELECT * FROM article";\n'
    );
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("direct SQL statement prohibited")));
});

test("governance rejects database provider dependencies in factory", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs", (source) =>
        "using Npgsql;\n" + source
    );
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("database provider dependencies prohibited")));
});

test("governance rejects database writes in factory", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs", (source) =>
        source + "\n// db write\nawait db.InsertAsync(article);\n"
    );
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("database writes prohibited")));
});

test("governance rejects sentinel hashes in factory", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs", (source) =>
        source.replace("ArticleRightsSnapshotBuilder.Build", '("sentinel", "placeholder", "recompute");\nArticleRightsSnapshotBuilder.Build')
    );
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("sentinel or placeholder hashes prohibited")));
});

test("governance rejects cache writes in factory", () =>
{
    const target = fixture();
    mutate(target, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs", (source) =>
        source + "\n// cache write\nawait cache.SetAsync(key, value);\n"
    );
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("cache writes prohibited")));
});

test("governance rejects second graph factory", () =>
{
    const target = fixture();
    const fakeFactoryPath = path.join(target, "src/backend/Services/Fixtures/DataScale/AlternativeArticleGraphFactory.cs");
    fs.writeFileSync(fakeFactoryPath, `
namespace FsusBlog.Server.Services.Fixtures.DataScale;
public class AlternativeArticleGraphFactory
{
    public ArticleScaleArticleGraph Generate() => null!;
}
`);
    const violations = checkCanonicalArticleGraphFactoryAuthority(target);
    assert.ok(violations.some((v) => v.includes("second article graph factory prohibited")));
});
