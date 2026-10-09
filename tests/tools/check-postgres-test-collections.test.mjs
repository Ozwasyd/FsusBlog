import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const checkerPath = path.join(
    root,
    "tools/check-postgres-test-collections.mjs"
);
const sourceMaskPath = path.join(root, "tools/test/csharp-source-mask.mjs");
const searchIndexUtf8ScalarGovernancePath = path.join(
    root,
    "tools/test/search-index-utf8-scalar-governance.mjs"
);
const backendRoot = path.join(root, "tests/backend");
const manifestPath = path.join(
    backendRoot,
    "Fixtures/postgres-test-collections.json"
);

function createFixture()
{
    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "fsusblog-postgres-collections-")
    );
    const fixtureBackendRoot = path.join(fixtureRoot, "tests/backend");
    const fixtureToolsRoot = path.join(fixtureRoot, "tools");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    fs.mkdirSync(fixtureToolsRoot, { recursive: true });
    fs.mkdirSync(path.join(fixtureToolsRoot, "test"), { recursive: true });
    fs.mkdirSync(path.join(fixtureBackendRoot, "Fixtures"), {
        recursive: true
    });
    fs.copyFileSync(
        checkerPath,
        path.join(fixtureToolsRoot, "check-postgres-test-collections.mjs")
    );
    fs.copyFileSync(
        sourceMaskPath,
        path.join(fixtureToolsRoot, "test/csharp-source-mask.mjs")
    );
    fs.copyFileSync(
        searchIndexUtf8ScalarGovernancePath,
        path.join(
            fixtureToolsRoot,
            "test/search-index-utf8-scalar-governance.mjs"
        )
    );
    fs.copyFileSync(
        path.join(backendRoot, "Fixtures/SchemaMigrationPostgresCollection.cs"),
        path.join(
            fixtureBackendRoot,
            "Fixtures/SchemaMigrationPostgresCollection.cs"
        )
    );
    fs.copyFileSync(
        manifestPath,
        path.join(
            fixtureBackendRoot,
            "Fixtures/postgres-test-collections.json"
        )
    );

    for (const entry of manifest.collections.flatMap(
        (collection) => collection.tests
    ))
    {
        const source = path.join(backendRoot, entry.path);
        const destination = path.join(fixtureBackendRoot, entry.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
    }

    return {
        root: fixtureRoot,
        backendRoot: fixtureBackendRoot,
        manifestPath: path.join(
            fixtureBackendRoot,
            "Fixtures/postgres-test-collections.json"
        )
    };
}

function runChecker(fixtureRoot)
{
    return spawnSync(
        process.execPath,
        ["tools/check-postgres-test-collections.mjs"],
        {
            cwd: fixtureRoot,
            encoding: "utf8"
        }
    );
}

test("accepts the checked-in PostgreSQL collection manifest", () =>
{
    const fixture = createFixture();
    const result = runChecker(fixture.root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
        result.stdout,
        /collections=2 classes=124 estimatedCases=978/u
    );
    assert.match(result.stdout, /SchemaMigrationPostgresCollectionA:430/u);
    assert.match(result.stdout, /SchemaMigrationPostgresCollectionB:548/u);
});

test("rejects omission of the current content-asset and runtime-rollup PostgreSQL classes", () =>
{
    for (const className of [
        "ContentAssetCutoverAcceptanceTests",
        "CurrentSchemaRuntimeRollupTablesDatabaseTests"
    ])
    {
        const fixture = createFixture();
        const manifest = JSON.parse(
            fs.readFileSync(fixture.manifestPath, "utf8")
        );
        const collection = manifest.collections.find((item) =>
            item.tests.some((entry) => entry.class === className)
        );
        collection.tests = collection.tests.filter(
            (entry) => entry.class !== className
        );
        fs.writeFileSync(
            fixture.manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`
        );

        const result = runChecker(fixture.root);

        assert.notEqual(result.status, 0);
        assert.match(
            result.stderr,
            new RegExp(
                `${className}.*missing from the PostgreSQL manifest`,
                "u"
            )
        );
    }
});

test("rejects omission of the existing lifecycle class even after its case total is repaired", () =>
{
    const fixture = createFixture();
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    const collection = manifest.collections.find(
        (item) => item.id === "SchemaMigrationPostgresCollectionA"
    );
    collection.tests = collection.tests.filter(
        (entry) => entry.class !== "CanonicalArticleLifecycleFixturePortIntegrationTests"
    );
    collection.estimatedFacts -= 26;
    fs.writeFileSync(
        fixture.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CanonicalArticleLifecycleFixturePortIntegrationTests.*missing from the PostgreSQL manifest/u
    );
    assert.doesNotMatch(result.stderr, /estimatedFacts mismatch/u);
});

test("rejects a fixture-backed test class that is absent from the manifest", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Unit/UnclassifiedPostgresTests.cs"
    );
    fs.writeFileSync(
        sourcePath,
        `
using FsusBlog.Tests.Fixtures;
using Xunit;

namespace FsusBlog.Tests.Unit;

public sealed class UnclassifiedPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void UsesFixture() => Assert.NotNull(fixture);
}
`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /UnclassifiedPostgresTests.*missing from the PostgreSQL manifest/u
    );
});

test("validates collection membership per class when one file declares multiple fixture tests", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Integration/SchemaMigrationIntegrationTests.cs"
    );
    fs.appendFileSync(
        sourcePath,
        `

[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class UndeclaredSiblingPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void UsesFixture() => Assert.NotNull(fixture);
}
`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /UndeclaredSiblingPostgresTests.*missing from the PostgreSQL manifest/u
    );
});

test("rejects a per-class annotation that disagrees with its manifest collection", () =>
{
    const fixture = createFixture();
    const relativePath = "Unit/ManifestAnnotationMismatchTests.cs";
    const sourcePath = path.join(fixture.backendRoot, relativePath);
    fs.writeFileSync(
        sourcePath,
        `
using FsusBlog.Tests.Fixtures;
using Xunit;

namespace FsusBlog.Tests.Unit;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ManifestAnnotationMismatchTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void UsesFixture() => Assert.NotNull(fixture);
}
`
    );
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    manifest.collections[0].tests.push({
        path: relativePath,
        class: "ManifestAnnotationMismatchTests"
    });
    manifest.collections[0].estimatedFacts += 1;
    fs.writeFileSync(
        fixture.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /ManifestAnnotationMismatchTests is assigned to SchemaMigrationPostgresCollectionB, expected SchemaMigrationPostgresCollectionA/u
    );
});

test("rejects estimatedFacts drift using Fact and InlineData execution semantics", () =>
{
    const fixture = createFixture();
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    manifest.collections[0].estimatedFacts += 1;
    fs.writeFileSync(
        fixture.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /SchemaMigrationPostgresCollectionA estimatedFacts mismatch: manifest=\d+ source=\d+/u
    );
});

test("rejects deletion of a required Theory case even when the aggregate count is repaired", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Unit/CommentServiceValidationTests.cs"
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(
        sourcePath,
        source.replace('    [InlineData("zero", "0")]\n', "")
    );
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    const collection = manifest.collections.find((item) =>
        item.tests.some(
            (entry) => entry.class === "CommentServiceValidationTests"
        )
    );
    collection.estimatedFacts -= 1;
    fs.writeFileSync(
        fixture.manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CreateComment_ParentIdBoundary_ReturnsFalseWithoutSideEffects required Theory cases mismatch/u
    );
});

test("rejects drift in a required Theory case label without relying on case count", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Unit/CommentServiceValidationTests.cs"
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(
        sourcePath,
        source.replace(
            '[InlineData("not-numeric", "not-a-number")]',
            '[InlineData("not_numeric", "not-a-number")]'
        )
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CreateComment_ParentIdBoundary_ReturnsFalseWithoutSideEffects required Theory cases mismatch/u
    );
});

test("rejects deletion of a required root ID Theory case", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Unit/CommentServiceValidationTests.cs"
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(
        sourcePath,
        source.replace('    [InlineData("negative", "-5")]\n', "")
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CreateComment_RootIdBoundary_ReturnsFalseWithoutSideEffects required Theory cases mismatch/u
    );
});

test("rejects drift in a required root ID Theory input", () =>
{
    const fixture = createFixture();
    const sourcePath = path.join(
        fixture.backendRoot,
        "Unit/CommentServiceValidationTests.cs"
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(
        sourcePath,
        source.replace(
            '[InlineData("not-numeric", "abc")]',
            '[InlineData("not-numeric", "not-a-root-id")]'
        )
    );

    const result = runChecker(fixture.root);

    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /CreateComment_RootIdBoundary_ReturnsFalseWithoutSideEffects required Theory cases mismatch/u
    );
});
