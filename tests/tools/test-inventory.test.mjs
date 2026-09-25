import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const [
    { ADAPTERS, classifyFile, isInventoryPath },
    { computeInventoryDigest, isInventoryStale, loadCanonicalInventory },
    { canonicalStringify, discoverTestInventory },
    { INVENTORY_SCHEMA, validateInventoryArtifact },
    { groupXunitSources, validateXunitProjectReport, xunitProjects }
] = await Promise.all([
    import(new URL('../../tools/test-inventory/adapters.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/api.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/discovery.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/schema.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/xunit-projects.mjs', import.meta.url))
]);

function writeFile(root, relative, content)
{
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
}

function sha256(value)
{
    return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function workflowJobSource(source, jobId)
{
    const start = source.indexOf(`    ${jobId}:\n`);
    assert.notEqual(start, -1, `${jobId} must exist`);
    const remainder = source.slice(start + 1);
    const next = /^ {4}[a-z][a-z0-9-]*:\s*$/gmu.exec(remainder);
    return source.slice(start, next ? start + 1 + next.index : source.length);
}

function createFixtureRoot()
{
    return mkdtempSync(path.join(os.tmpdir(), 'fsus-test-inventory-'));
}

function removeFixture(root)
{
    rmSync(root, { recursive: true, force: true });
}

function writeMinimalAuthorities(root)
{
    writeFile(root, 'tests/matrix.yml', [
        'tiers:',
        '    - id: fixture-shell',
        '      executionDependsOn: []',
        '      command: tools/test/fixture-entrypoint.sh',
        '      evidence: [tests/tools/check.test.mjs]',
        '      artifacts: []',
        ''
    ].join('\n'));
    writeFile(root, 'tests/coverage-registry.json', JSON.stringify({
        entries: [
            {
                id: 'fixture-coverage',
                evidencePaths: ['tools/test/fixture-entrypoint.sh']
            }
        ]
    }, null, 2));
    writeFile(root, 'tests/backend/Fixtures/backend-test-requirements.json', JSON.stringify({
        profiles: [
            {
                id: 'fixture-profile',
                command: 'node tools/test/fixture-node.mjs',
                evidencePaths: ['tests/backend/Fixtures/seed-data.json']
            }
        ]
    }, null, 2));
}

function writeFullSurfaceFixture(root)
{
    writeMinimalAuthorities(root);
    writeFile(root, 'tests/backend/Unit/FooTests.cs', 'public sealed class FooTests { }\n');
    writeFile(root, 'tests/backend/Unit/BarTest.cs', 'public sealed class BarTest { }\n');
    writeFile(root, 'tests/backend/Helpers/SeedDataFixture.cs', 'public sealed class SeedDataFixture { }\n');
    writeFile(root, 'tests/migration/SchemaMigrationDdlTests.cs', 'public sealed class SchemaMigrationDdlTests { }\n');
    writeFile(root, 'tests/migration/ProviderTest.cs', 'public sealed class ProviderTest { }\n');
    writeFile(root, 'tests/migration/MySqlDdlFixture.cs', 'public sealed class MySqlDdlFixture { }\n');
    writeFile(root, 'tests/backend/Fixtures/seed-data.json', '{ "seed": true }\n');
    writeFile(root, 'tests/frontend/unit/foo.test.ts', "import { describe, it, expect } from 'vitest'\n");
    writeFile(root, 'tests/frontend/unit/node.test.mjs', "import { test } from 'node:test'\n");
    writeFile(root, 'tests/frontend/e2e/acceptance/pw.spec.ts', "import { test, expect } from '@playwright/test'\n");
    writeFile(root, 'tests/tools/check.test.mjs', "import { test } from 'node:test'\n");
    writeFile(root, 'tests/tools/tool.spec.mjs', "import { describe } from 'node:test'\n");
    writeFile(root, 'tests/native/AedsCrc16Fuzz.cpp', 'extern "C" int LLVMFuzzerTestOneInput() { return 0; }\n');
    writeFile(root, 'tests/native/corpus/aeds-crc16/seed.bin', 'corpus-bytes\n');
    writeFile(root, 'tests/tools/readme.txt', 'support text\n');
    writeFile(root, 'tools/test/fixture-entrypoint.sh', '#!/usr/bin/env bash\nset -euo pipefail\n');
    writeFile(root, 'tools/test/fixture-node.mjs', 'console.log("fixture node entrypoint")\n');
}

function inventoryAdapterMap(root)
{
    const artifact = discoverTestInventory(root, { runAdapters: false });
    return new Map(artifact.sourceFiles.map((sourceFile) => [sourceFile.path, sourceFile]));
}

test('xunit project ownership separates compile contexts without changing case identity', () =>
{
    assert.deepEqual(xunitProjects, [
        { project: 'tests/backend/FsusBlog.Server.Tests.csproj', sourceDirectory: 'tests/backend' },
        { project: 'tests/migration/FsusBlog.Migration.Tests.csproj', sourceDirectory: 'tests/migration' }
    ]);
    assert.equal(Object.isFrozen(xunitProjects), true);
    assert.ok(xunitProjects.every(Object.isFrozen));
    const backend = { path: 'tests/backend/Unit/FooTests.cs', adapter: 'xunit' };
    const migration = { path: 'tests/migration/SchemaMigrationDdlTests.cs', adapter: 'xunit' };
    const groups = groupXunitSources([
        backend,
        migration,
        { path: 'tests/migration/MySqlDdlFixture.cs', adapter: 'xunit-support' }
    ]);
    assert.deepEqual(groups.map((owner) => owner.sourceFiles), [[backend], [migration]]);
    for (const owner of groups)
    {
        const ownerFile = owner.sourceFiles[0].path;
        const report = {
            schema: 'fsusblog.test-inventory.xunit-roslyn.v1',
            adapter: 'xunit',
            adapterVersion: 'xunit.v2',
            testCases: [{ adapter: 'xunit', ownerFile, id: `xunit:${ownerFile}#Suite.Method` }],
            diagnostics: []
        };
        assert.equal(validateXunitProjectReport(owner, report), report);
    }
});

test('xunit project ownership rejects unknown duplicate ambiguous and noncanonical sources', () =>
{
    for (const file of [
        'tests/unknown/FooTests.cs',
        'tests/backend-extra/FooTests.cs',
        'tests/backend/../migration/FooTests.cs',
        'tests/backend/./FooTests.cs',
        'tests/backend//FooTests.cs',
        'tests/backend\\FooTests.cs'
    ])
    {
        assert.throws(() => groupXunitSources([{ path: file, adapter: 'xunit' }]), /xunit source/u);
    }
    const source = { path: 'tests/migration/FooTests.cs', adapter: 'xunit' };
    assert.throws(() => groupXunitSources([source, source]), /unique normalized/u);
    for (const projects of [
        [xunitProjects[0], xunitProjects[0]],
        [xunitProjects[0], { ...xunitProjects[0], project: 'tests/backend/Other.Tests.csproj' }],
        [{ project: '../FsusBlog.Server.Tests.csproj', sourceDirectory: 'tests/backend' }],
        [{ project: 'tests/backend/nested/Tests.csproj', sourceDirectory: 'tests/backend' }]
    ])
    {
        assert.throws(() => groupXunitSources([], projects), /unique repository test projects/u);
    }
});

test('xunit project reports reject incomplete diagnostic foreign and duplicate cases', () =>
{
    const ownerFile = 'tests/migration/FooTests.cs';
    const owner = groupXunitSources([{ path: ownerFile, adapter: 'xunit' }])
        .find((entry) => entry.sourceDirectory === 'tests/migration');
    const testCase = { adapter: 'xunit', ownerFile, id: `xunit:${ownerFile}#Suite.Method` };
    const report = {
        schema: 'fsusblog.test-inventory.xunit-roslyn.v1',
        adapter: 'xunit',
        adapterVersion: 'xunit.v2',
        testCases: [testCase],
        diagnostics: []
    };
    for (const invalid of [
        null,
        { ...report, schema: 'unknown' },
        { ...report, adapter: 'node-test' },
        { ...report, adapterVersion: 'xunit.v1' },
        { ...report, testCases: null },
        { ...report, diagnostics: null },
        { ...report, testCases: [] },
        { ...report, diagnostics: [{ severity: 'error', code: 'xunit-compile-context-unavailable' }] },
        { ...report, diagnostics: [{ severity: 'warning', code: 'unresolved-case' }] },
        { ...report, testCases: [testCase, testCase] },
        { ...report, testCases: [null] },
        { ...report, testCases: [{ ...testCase, adapter: 'node-test' }] },
        { ...report, testCases: [{ ...testCase, ownerFile: 'tests/backend/FooTests.cs' }] },
        { ...report, testCases: [{ ...testCase, ownerFile: 'tests/migration/MySqlDdlFixture.cs' }] },
        { ...report, testCases: [{ ...testCase, id: 'xunit:tests/backend/FooTests.cs#Suite.Method' }] },
        { ...report, testCases: [{ ...testCase, id: `xunit:${ownerFile}#` }] },
        { ...report, testCases: [{ ...testCase, id: 1 }] }
    ])
    {
        assert.throws(() => validateXunitProjectReport(owner, invalid), /xunit/u);
    }
    const emptyOwner = groupXunitSources([])[1];
    assert.equal(emptyOwner.project, 'tests/migration/FsusBlog.Migration.Tests.csproj');
    assert.throws(
        () => validateXunitProjectReport(emptyOwner, { ...report, testCases: [] }),
        /returned no cases/u
    );
});

test('xunit discovery fails closed when project or canonical adapter is absent', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeMinimalAuthorities(root);
        writeFile(root, 'tests/migration/FooTests.cs', 'public sealed class FooTests { }\n');
        assert.throws(() => discoverTestInventory(root), /xunit test project is missing: tests\/backend\/FsusBlog.Server.Tests.csproj/u);
        writeFile(root, 'tests/backend/FsusBlog.Server.Tests.csproj', '<Project />\n');
        assert.throws(() => discoverTestInventory(root), /xunit test project is missing: tests\/migration\/FsusBlog.Migration.Tests.csproj/u);
        writeFile(root, 'tests/migration/FsusBlog.Migration.Tests.csproj', '<Project />\n');
        assert.throws(() => discoverTestInventory(root), /xunit adapter project is not present/u);
    }
    finally
    {
        removeFixture(root);
    }
});

test('canonical discovery covers xunit, vitest, node:test, playwright, tests/tools, native fuzz and matrix shell entrypoints', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const byPath = inventoryAdapterMap(root);

        assert.equal(byPath.get('tests/backend/Unit/FooTests.cs')?.adapter, 'xunit');
        assert.equal(byPath.get('tests/backend/Unit/BarTest.cs')?.adapter, 'xunit');
        assert.equal(byPath.get('tests/migration/SchemaMigrationDdlTests.cs')?.adapter, 'xunit');
        assert.equal(byPath.get('tests/migration/ProviderTest.cs')?.adapter, 'xunit');
        assert.equal(byPath.get('tests/migration/MySqlDdlFixture.cs')?.adapter, 'xunit-support');
        assert.equal(byPath.get('tests/migration/MySqlDdlFixture.cs')?.kind, 'fixture');
        assert.equal(byPath.get('tests/frontend/unit/foo.test.ts')?.adapter, 'vitest');
        assert.equal(byPath.get('tests/frontend/unit/node.test.mjs')?.adapter, 'node-test');
        assert.equal(byPath.get('tests/frontend/e2e/acceptance/pw.spec.ts')?.adapter, 'playwright');
        assert.equal(byPath.get('tests/tools/check.test.mjs')?.adapter, 'node-test');
        assert.equal(byPath.get('tests/tools/tool.spec.mjs')?.adapter, 'node-test');
        assert.equal(byPath.get('tests/native/AedsCrc16Fuzz.cpp')?.adapter, 'native-fuzz');
        assert.equal(byPath.get('tools/test/fixture-entrypoint.sh')?.adapter, 'shell');
        assert.equal(byPath.get('tools/test/fixture-node.mjs')?.adapter, 'node-script');

        for (const [file, record] of byPath)
        {
            if (record.kind !== 'discoverable-test')
            {
                continue;
            }
            assert.ok(record.caseIdentity.inventoryObligation, `${file} must carry an inventory obligation`);
            assert.ok(['static', 'dynamic'].includes(record.caseIdentity.mode), `${file} case identity mode must be explicit`);
            if (record.caseIdentity.mode === 'dynamic')
            {
                assert.ok(record.caseIdentity.generationLocation, `${file} dynamic case identity needs a generation location`);
            }
        }

        const diagnostics = discoverTestInventory(root, { runAdapters: false }).diagnostics;
        const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
        assert.ok(!codes.has('case-extraction-deferred'), 'no adapter case extraction may remain deferred');
        assert.ok(codes.has('dynamic-case-obligation'), 'dynamic case obligations must be explicit');
        assert.equal(byPath.get('tests/native/AedsCrc16Fuzz.cpp')?.caseIdentity.extractionStatus, 'ready');
    }
    finally
    {
        removeFixture(root);
    }
});

test('xunit files outside .test.* globs and tests/tools test/spec files are not missed', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const byPath = inventoryAdapterMap(root);
        assert.ok(byPath.has('tests/backend/Unit/FooTests.cs'), '*Tests.cs must be inventoried');
        assert.ok(byPath.has('tests/backend/Unit/BarTest.cs'), '*Test.cs must be inventoried');
        assert.ok(byPath.has('tests/tools/check.test.mjs'), 'tests/tools .test.mjs must be inventoried');
        assert.ok(byPath.has('tests/tools/tool.spec.mjs'), 'tests/tools .spec.mjs must be inventoried');
    }
    finally
    {
        removeFixture(root);
    }
});

test('support, fixture and corpus surfaces are distinguished from discoverable cases', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const byPath = inventoryAdapterMap(root);
        assert.equal(byPath.get('tests/backend/Helpers/SeedDataFixture.cs')?.kind, 'fixture');
        assert.equal(byPath.get('tests/backend/Fixtures/seed-data.json')?.kind, 'fixture');
        assert.equal(byPath.get('tests/native/corpus/aeds-crc16/seed.bin')?.kind, 'corpus');
        assert.equal(byPath.get('tests/tools/readme.txt')?.kind, 'support');
        assert.equal(byPath.get('tests/tools/readme.txt')?.caseIdentity.extractionStatus, 'not-applicable');
        assert.equal(byPath.get('tests/backend/Unit/FooTests.cs')?.kind, 'discoverable-test');
        assert.equal(byPath.get('tests/native/AedsCrc16Fuzz.cpp')?.kind, 'discoverable-test');
        assert.equal(byPath.get('tools/test/fixture-entrypoint.sh')?.kind, 'discoverable-test');
    }
    finally
    {
        removeFixture(root);
    }
});

test('matrix-referenced unknown executable entrypoint fails closed', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeMinimalAuthorities(root);
        writeFile(root, 'tests/backend/Unit/FooTests.cs', 'public sealed class FooTests { }\n');
        writeFile(root, 'tools/test/unknown.ps1', 'Write-Host "unknown"\n');
        writeFile(root, 'tests/matrix.yml', [
            'tiers:',
            '    - id: fixture-unknown',
            '      executionDependsOn: []',
            '      command: tools/test/unknown.ps1',
            '      evidence: []',
            '      artifacts: []',
            ''
        ].join('\n'));
        assert.throws(
            () => discoverTestInventory(root, { runAdapters: false }),
            /fail closed|no adapter record|instead of a discoverable test/u
        );
    }
    finally
    {
        removeFixture(root);
    }
});

test('duplicate adapter ownership fails closed', () =>
{
    const duplicate = {
        id: 'xunit-duplicate',
        version: 'xunit-duplicate.v1',
        kind: 'discoverable-test',
        caseIdentity: () => ({ mode: 'static', owner: 'xunit-duplicate' }),
        matches: (file) => /^tests\/backend\/.*(?:Tests|Test)\.cs$/u.test(file)
    };
    ADAPTERS.push(duplicate);
    try
    {
        assert.throws(
            () => classifyFile('tests/backend/Unit/FooTests.cs', 'public class FooTests { }\n'),
            /duplicate adapter ownership/u
        );
    }
    finally
    {
        const index = ADAPTERS.indexOf(duplicate);
        if (index !== -1)
        {
            ADAPTERS.splice(index, 1);
        }
    }
});

test('source, path and adapter changes make a stored inventory stale', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const artifact = discoverTestInventory(root, { runAdapters: false });

        writeFile(root, 'tests/backend/Unit/FooTests.cs', 'public sealed class FooTests { public void Changed() { } }\n');
        let stale = isInventoryStale(root, artifact, { runAdapters: false });
        assert.equal(stale.stale, true);
        assert.match(stale.reason, /source digest changed/u);

        writeFile(root, 'tests/backend/Unit/FooTests.cs', 'public sealed class FooTests { }\n');
        rmSync(path.join(root, 'tests/tools/check.test.mjs'));
        stale = isInventoryStale(root, artifact, { runAdapters: false });
        assert.equal(stale.stale, true);
        assert.match(stale.reason, /no longer exists/u);

        writeFile(root, 'tests/tools/check.test.mjs', "import { test } from 'node:test'\n");
        const flippedSource = "import { describe, it, expect } from 'vitest'\n";
        writeFile(root, 'tests/tools/check.test.mjs', flippedSource);
        const flippedArtifact = structuredClone(artifact);
        const entry = flippedArtifact.sourceFiles.find((sourceFile) => sourceFile.path === 'tests/tools/check.test.mjs');
        entry.sourceDigest = sha256(flippedSource);
        flippedArtifact.inventoryDigest = computeInventoryDigest(flippedArtifact);
        stale = isInventoryStale(root, flippedArtifact, { runAdapters: false });
        assert.equal(stale.stale, true);
        assert.match(stale.reason, /adapter membership changed/u);
    }
    finally
    {
        removeFixture(root);
    }
});

test('quality and retention consumers no longer own private walk or file-discovery authority', async () =>
{
    for (const consumer of ['tools/ci/check-test-quality.mjs', 'tools/check-test-retention.mjs'])
    {
        const source = readFileSync(path.join(repositoryRoot, consumer), 'utf8');
        assert.doesNotMatch(source, /function\s+walk\s*\(/u, `${consumer} must not define a private walker`);
        assert.doesNotMatch(source, /testFilePattern/u, `${consumer} must not own a test-file regex`);
    }
    const qualitySource = readFileSync(path.join(repositoryRoot, 'tools/ci/check-test-quality.mjs'), 'utf8');
    assert.match(
        qualitySource,
        /loadCanonicalInventory\(root,\s*\{\s*requireArtifact:\s*true,\s*runAdapters:\s*false\s*\}\)/u
    );
    const retentionSource = readFileSync(path.join(repositoryRoot, 'tools/check-test-retention.mjs'), 'utf8');
    assert.match(retentionSource, /inventorySourceFiles\(root\)/u);
    const auditSource = readFileSync(path.join(repositoryRoot, 'tools/test-retention/audit.mjs'), 'utf8');
    assert.match(auditSource, /return isInventoryPath\(file\)/u);
    const { isTestInventoryPath } = await import(new URL('../../tools/test-retention/audit.mjs', import.meta.url));
    for (const file of [
        'tests/backend/Unit/FooTests.cs',
        'tests/migration/FooTests.cs',
        'tests/migration/MySqlDdlFixture.cs',
        'tests/tools/check.test.mjs',
        'src/migration/Program.cs'
    ])
    {
        assert.equal(isTestInventoryPath(file), isInventoryPath(file), file);
    }
    const probePath = 'tests/migration/OwnershipProbeTests.cs';
    const dispatch = new Error('canonical adapter dispatch observed');
    ADAPTERS.push({
        id: 'retention-delegation-probe',
        matches: (file) =>
        {
            if (file === probePath)
            {
                throw dispatch;
            }
            return false;
        }
    });
    try
    {
        assert.throws(() => isTestInventoryPath(probePath), (error) => error === dispatch);
    }
    finally
    {
        ADAPTERS.pop();
    }
});

test('identical inputs produce byte-stable inventory artifacts', () =>
{
    const first = path.join(os.tmpdir(), `fsus-test-inventory-first-${process.pid}.json`);
    const second = path.join(os.tmpdir(), `fsus-test-inventory-second-${process.pid}.json`);
    try
    {
        execFileSync(process.execPath, ['tools/test-inventory/produce.mjs', '--out', first], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        execFileSync(process.execPath, ['tools/test-inventory/produce.mjs', '--out', second], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
        const artifact = JSON.parse(readFileSync(first, 'utf8'));
        assert.equal(artifact.schema, INVENTORY_SCHEMA);
        validateInventoryArtifact(artifact);
        assert.ok(artifact.inventoryDigest.startsWith('sha256:'));
    }
    finally
    {
        for (const file of [first, second])
        {
            if (existsSync(file))
            {
                rmSync(file);
            }
        }
    }
});

test('inventory schema is closed: runtime metadata and unknown fields are rejected', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const artifact = discoverTestInventory(root, { runAdapters: false });
        assert.equal(computeDigestWithoutMetadata(artifact), artifact.inventoryDigest);

        const withGeneratedAt = { ...artifact, generatedAt: new Date().toISOString() };
        assert.throws(() => validateInventoryArtifact(withGeneratedAt), /unknown field: generatedAt/u);

        const mutated = structuredClone(artifact);
        mutated.inventoryDigest = 'not-a-digest';
        assert.throws(() => validateInventoryArtifact(mutated), /must be a sha256 digest|inventoryDigest/u);
    }
    finally
    {
        removeFixture(root);
    }
});

function computeDigestWithoutMetadata(artifact)
{
    const content = { ...artifact };
    delete content.inventoryDigest;
    return `sha256:${createHash('sha256').update(canonicalStringify(content)).digest('hex')}`;
}

test('loadCanonicalInventory fails closed on stale artifacts and missing required artifacts', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const artifact = discoverTestInventory(root, { runAdapters: false });
        const artifactPath = '.tmp/fixture-inventory.json';
        writeFile(root, artifactPath, JSON.stringify(artifact, null, 2));

        assert.equal(loadCanonicalInventory(root, { artifactPath, runAdapters: false }).schema, INVENTORY_SCHEMA);

        const reordered = structuredClone(artifact);
        reordered.discoverySources = Object.fromEntries(
            Object.entries(reordered.discoverySources).toReversed()
        );
        reordered.inventoryDigest = computeInventoryDigest(reordered);
        writeFile(root, artifactPath, JSON.stringify(reordered, null, 2));
        assert.equal(
            loadCanonicalInventory(root, { artifactPath, runAdapters: false }).inventoryDigest,
            reordered.inventoryDigest
        );

        const tampered = structuredClone(artifact);
        tampered.sourceFiles[0].sourceDigest = sha256('tampered');
        writeFile(root, artifactPath, JSON.stringify(tampered, null, 2));
        assert.throws(
            () => loadCanonicalInventory(root, { artifactPath, runAdapters: false }),
            /content digest does not match/u
        );

        writeFile(root, artifactPath, JSON.stringify(artifact, null, 2));
        writeFile(root, 'tests/backend/Unit/FooTests.cs', 'public sealed class FooTests { public void Changed() { } }\n');
        assert.throws(
            () => loadCanonicalInventory(root, { artifactPath, runAdapters: false }),
            /artifact is stale/u
        );

        const missingPath = '.tmp/does-not-exist.json';
        assert.throws(
            () => loadCanonicalInventory(root, { artifactPath: missingPath, requireArtifact: true, runAdapters: false }),
            /artifact missing/u
        );
    }
    finally
    {
        removeFixture(root);
    }
});

test('CI produces one sealed inventory and static governance only consumes it', () =>
{
    const lane = readFileSync(path.join(repositoryRoot, 'tools/test/lanes/test-inventory.sh'), 'utf8');
    assert.match(
        lane,
        /npm --prefix "\$ROOT_DIR\/tools\/test-inventory\/ts-ast-adapter"[\s\S]*?\bci\b/u,
        'the canonical tier must install the lockfile-pinned TypeScript adapter'
    );
    assert.match(
        lane,
        /exec node "\$ROOT_DIR\/tools\/test-inventory\/produce\.mjs"/u,
        'the canonical tier must execute the sole inventory producer'
    );

    const producer = readFileSync(path.join(repositoryRoot, 'tools/test-inventory/produce.mjs'), 'utf8');
    assert.match(
        producer,
        /import \{ xunitProjects \} from '\.\/xunit-projects\.mjs'/u,
        'the canonical producer must consume the closed project ownership registry'
    );
    assert.match(
        producer,
        /spawnSync\(\s*'dotnet',\s*\[\s*'build',\s*path\.join\(root,\s*testProject\)/u,
        'the canonical producer must create the xUnit compile context'
    );
    assert.match(
        producer,
        /for \(const owner of xunitProjects\)\s*\{\s*prepareXunitCompileContext\(owner\.project\)/u,
        'each registered test assembly requires its own compile context'
    );

    const governanceRunner = readFileSync(
        path.join(repositoryRoot, 'tools/test/run-governance-suites.mjs'),
        'utf8'
    );
    assert.match(
        governanceRunner,
        /loadCanonicalInventory\(root,\s*\{\s*requireArtifact:\s*true,\s*runAdapters:\s*false\s*\}\)/u,
        'static governance must consume the sealed artifact without rerunning adapters'
    );

    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/quality-gate.yml'), 'utf8');
    const producerJob = workflowJobSource(workflow, 'validate-matrix');
    const consumerJob = workflowJobSource(workflow, 'fast-static-governance');
    assert.ok(
        producerJob.indexOf('actions/setup-dotnet@') < producerJob.indexOf('ci-tier test-inventory'),
        'validate-matrix must set up .NET before producing the inventory'
    );
    assert.match(
        consumerJob,
        /needs:\s*\[validate-matrix,\s*behavior-doc-static-admission\]/u,
        'static governance must depend on the inventory producer'
    );
    assert.ok(
        consumerJob.indexOf('name: validate-matrix') < consumerJob.indexOf('static-governance --no-deps'),
        'static governance must download the producer artifact before execution'
    );
});
