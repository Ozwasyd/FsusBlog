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
    { ADAPTERS, classifyFile },
    { computeInventoryDigest, isInventoryStale, loadCanonicalInventory },
    { canonicalStringify, discoverTestInventory },
    { INVENTORY_SCHEMA, validateInventoryArtifact }
] = await Promise.all([
    import(new URL('../../tools/test-inventory/adapters.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/api.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/discovery.mjs', import.meta.url)),
    import(new URL('../../tools/test-inventory/schema.mjs', import.meta.url))
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

test('canonical discovery covers xunit, vitest, node:test, playwright, tests/tools, native fuzz and matrix shell entrypoints', () =>
{
    const root = createFixtureRoot();
    try
    {
        writeFullSurfaceFixture(root);
        const byPath = inventoryAdapterMap(root);

        assert.equal(byPath.get('tests/backend/Unit/FooTests.cs')?.adapter, 'xunit');
        assert.equal(byPath.get('tests/backend/Unit/BarTest.cs')?.adapter, 'xunit');
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

test('quality and retention consumers no longer own private walk or file-discovery authority', () =>
{
    for (const consumer of ['tools/ci/check-test-quality.mjs', 'tools/check-test-retention.mjs'])
    {
        const source = readFileSync(path.join(repositoryRoot, consumer), 'utf8');
        assert.doesNotMatch(source, /function\s+walk\s*\(/u, `${consumer} must not define a private walker`);
        assert.doesNotMatch(source, /testFilePattern/u, `${consumer} must not own a test-file regex`);
    }
    const qualitySource = readFileSync(path.join(repositoryRoot, 'tools/ci/check-test-quality.mjs'), 'utf8');
    assert.match(qualitySource, /loadCanonicalInventory\(root\)/u);
    const retentionSource = readFileSync(path.join(repositoryRoot, 'tools/check-test-retention.mjs'), 'utf8');
    assert.match(retentionSource, /inventorySourceFiles\(root\)/u);
    const auditSource = readFileSync(path.join(repositoryRoot, 'tools/test-retention/audit.mjs'), 'utf8');
    assert.match(auditSource, /import\s*\{[^}]*isInventoryPath[^}]*\}\s*from\s*'\.\.\/test-inventory\/adapters\.mjs'/u);
    assert.match(auditSource, /return isInventoryPath\(file\)/u);
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
        /const backendTestProject = 'tests\/backend\/FsusBlog\.Server\.Tests\.csproj'/u,
        'the canonical producer must own the backend test project'
    );
    assert.match(
        producer,
        /spawnSync\(\s*'dotnet',\s*\[\s*'build',\s*path\.join\(root,\s*backendTestProject\)/u,
        'the canonical producer must create the xUnit compile context'
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
