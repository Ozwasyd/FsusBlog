// Imported by release-domain-projections.test.mjs so the mechanical acceptance command runs every case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { sealProjectionDocument } = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/evidence-projection.mjs')
).href);
const {
    collectReleaseFinalDomainProjectionReceipts,
    releaseFinalDomainProjectionTierIds,
    sha256File,
    validateNativeAssertionEvidence
} = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/release-domain-evidence.mjs')
).href);
const { loadCommandGroup } = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/command-groups.mjs')
).href);

const domains = [
    'release-admin-console', 'release-aot-consumption', 'release-aot-generation',
    'release-auth-flow', 'release-authoring-flow', 'release-error-boundary',
    'release-private-preview', 'release-rbac-negative',
    'release-static-asset-digest-coherence'
];
const producers = [
    'browser-diagnostics-manual',
    'frontend-unit-shard',
    'release-evidence',
    'test-quality-lint'
];
const releaseFinalProjectionDomains = [...releaseFinalDomainProjectionTierIds];
const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};
const identityEnvironment = {
    FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
    FSUSBLOG_TEST_RUN_ID: 'release-run',
    FSUSBLOG_TEST_NAMESPACE: 'release-namespace'
};
const ledger = JSON.parse(fs.readFileSync(
    path.join(root, 'config/testing/release-domain-assertion-dispositions.json'),
    'utf8'
));

function catalog(domain)
{
    return JSON.parse(fs.readFileSync(
        path.join(root, 'tests/fixtures/evidence-projection', `${domain}.json`),
        'utf8'
    ));
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nativeExecutionFixture()
{
    const directory =
        fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-execution-'));
    const catalogDirectory = path.join(directory, 'catalogs');
    fs.mkdirSync(catalogDirectory, { recursive: true });
    writeJson(path.join(directory, 'ledger.json'), ledger);
    fs.mkdirSync(path.join(directory, 'tests'), { recursive: true });
    fs.copyFileSync(
        path.join(root, 'tests/matrix.yml'),
        path.join(directory, 'tests/matrix.yml')
    );
    for (const domain of domains)
    {
        const value = structuredClone(catalog(domain));
        value.dispositionLedger = 'ledger.json';
        writeJson(path.join(catalogDirectory, `${domain}.json`), value);
        for (const declaration of value.requiredArtifactDeclarations)
        {
            const file = path.join(directory, declaration.path);
            if (!fs.existsSync(file))
            {
                writeJson(file, {
                    schema: `fixture.${declaration.id}`,
                    status: 'success'
                });
            }
        }
    }

    const vitestFiles = [...new Set(ledger.entries.flatMap((entry) =>
    {
        if (entry.producerEvidence.kind === 'vitest-file')
        {
            return [entry.producerEvidence.file];
        }
        if (entry.producerEvidence.kind === 'vitest-file-set')
        {
            return entry.producerEvidence.files;
        }
        return [];
    }))].sort();
    const vitestPath =
        '.tmp/test-results/vitest/frontend-unit-shard-release-run/unsharded.json';
    writeJson(path.join(directory, vitestPath), {
        testResults: vitestFiles.map((file) => ({
            name: path.join(directory, file),
            status: 'passed',
            assertionResults: [{ status: 'passed', fullName: file }]
        }))
    });

    const frontendStatic = loadCommandGroup(root, 'frontend-static-governance');
    const selectedChildren = [...new Set(ledger.entries
        .filter((entry) =>
            entry.producerEvidence.kind === 'live-grant-child'
            && entry.producerEvidence.lane === 'frontend-static-governance')
        .map((entry) => entry.producerEvidence.childId))].sort();
    const liveGrantPath =
        '.tmp/test-results/live-grant/release-run/frontend-static-governance.json';
    writeJson(path.join(directory, liveGrantPath), {
        schema: 'fsusblog.live-grant-execution.v1',
        lane: 'frontend-static-governance',
        schedulerRunId: 'release-run',
        status: 'success',
        children: selectedChildren.map((id) =>
        {
            const command =
                frontendStatic.commands.find((candidate) => candidate.id === id);
            return {
                id,
                status: 'success',
                ...((command?.localCommands?.length ?? 0) > 0
                    ? {
                        nestedAssertions: command.localCommands.map((child) => ({
                            id: child.id,
                            status: 'success'
                        })).sort((left, right) =>
                            left.id.localeCompare(right.id))
                    }
                    : {})
            };
        })
    });
    const collectGrantPath =
        '.tmp/test-results/live-grant/release-run/collect-release-evidence-precollect.json';
    writeJson(path.join(directory, collectGrantPath), {
        schema: 'fsusblog.live-grant-execution.v1',
        lane: 'collect:release-evidence-precollect',
        schedulerRunId: 'release-run',
        status: 'success',
        children: [{ id: 'artifact-slimness', status: 'success' }]
    });

    const policyIdentity = sha256File(path.join(directory, 'ledger.json'));
    const buildReceiptDigest = `sha256:${'c'.repeat(64)}`;
    const diagnosticsAssertions = {
        'release-aot-consumption': [
            'check:distribution-version-coherence',
            'check:pow-runtime',
            'check:public-hydration'
        ],
        'release-rbac-negative': [
            'check:security:attack-matrix',
            'check:security:permissions'
        ]
    };
    for (const [probeId, assertionIds] of Object.entries(diagnosticsAssertions))
    {
        writeJson(
            path.join(
                directory,
                `.tmp/browser-diagnostics-runtime/release-runtime/${probeId}.json`
            ),
            sealProjectionDocument({
                schema: 'fsusblog.browser-diagnostics-release-assertions.v1',
                status: 'success',
                categoryId: 'release-runtime',
                probeId,
                diagnosticsRunId: 'release-run',
                schedulerRunId: 'release-run',
                projectionNamespace: 'release-namespace',
                sourceState,
                buildReceiptDigest,
                policyIdentity,
                assertions: assertionIds.map((id) => ({
                    id,
                    outcome: 'success'
                })),
                generatedAt: '2026-07-26T00:00:00.000Z'
            })
        );
    }
    const probes = Object.entries(diagnosticsAssertions)
        .map(([probeId, assertionIds]) =>
        {
            const assertionArtifactPath =
                `.tmp/browser-diagnostics-runtime/release-runtime/${probeId}.json`;
            const testIds = [`release-runtime/${probeId}`, ...assertionIds].sort();
            return {
                id: probeId,
                status: 'success',
                finalStatus: 'success',
                testIds,
                attempts: [{ status: 'success', testIds }],
                artifactContract: {
                    status: 'success',
                    declaredPaths: [assertionArtifactPath],
                    materializedPaths: [assertionArtifactPath],
                    missingPaths: []
                },
                copiedArtifacts: [assertionArtifactPath]
            };
        });
    writeJson(
        path.join(
            directory,
            '.tmp/browser-diagnostics/release-runtime-receipt.json'
        ),
        sealProjectionDocument({
            schema: 'fsusblog.browser-diagnostics-release-runtime-receipt.v1',
            status: 'success',
            runId: 'release-run',
            sourceState,
            buildBinding: {
                sourceState,
                receiptContentDigest: buildReceiptDigest
            },
            category: {
                id: 'release-runtime',
                status: 'success',
                plannedProbeIds: Object.keys(diagnosticsAssertions).sort(),
                probes
            }
        })
    );
    return {
        directory,
        catalogDirectory,
        vitestPath,
        liveGrantPath
    };
}

function runTool(fixture, args)
{
    return spawnSync(process.execPath, args, {
        cwd: root,
        env: { ...process.env, ...identityEnvironment },
        encoding: 'utf8'
    });
}

function finalReceiptOptions(repositoryRoot, expectedTierIds = releaseFinalProjectionDomains)
{
    return {
        repositoryRoot,
        expectedTierIds,
        sourceState,
        runId: 'release-run',
        namespace: 'release-namespace',
        ledgerPath: 'ledger.json',
        catalogDirectory: 'catalogs'
    };
}

function projectionArgs(fixture, catalogFile, outputFile)
{
    return [
        'tools/test/project-evidence.mjs',
        '--catalog', path.join(fixture.catalogDirectory, catalogFile),
        '--producer-directory',
        path.join(fixture.directory, '.tmp/test-results/evidence-producers'),
        '--output', outputFile,
        '--root', fixture.directory,
        '--commit', sourceState.commit,
        '--worktree-fingerprint', sourceState.worktreeFingerprint,
        '--run-id', 'release-run',
        '--namespace', 'release-namespace'
    ];
}

test('all four physical producers normalize existing structured artifacts before receipt and projection', () =>
{
    const fixture = nativeExecutionFixture();
    try
    {
        for (const producer of producers)
        {
            const receiptArgs = ['tools/test/produce-release-domain-receipt.mjs',
                '--root', fixture.directory, '--producer', producer,
                '--ledger', 'ledger.json', '--catalog-directory', 'catalogs'];
            const early = runTool(fixture, receiptArgs);
            assert.notEqual(
                early.status,
                0,
                `${producer} receipt must not precede native artifact normalization`
            );
            const report = runTool(fixture,
                ['tools/test/write-release-domain-assertion-report.mjs',
                    '--root', fixture.directory, '--producer', producer,
                    '--ledger', 'ledger.json', '--catalog-directory', 'catalogs']);
            assert.equal(report.status, 0, report.stderr);
            const receipt = runTool(fixture, receiptArgs);
            assert.equal(receipt.status, 0, receipt.stderr);
            for (const entry of ledger.entries.filter((candidate) =>
                candidate.canonicalProducer === producer))
            {
                const domain = entry.tierId;
                const projected = runTool(fixture, projectionArgs(
                    fixture,
                    `${domain}.json`,
                    path.join(fixture.directory,
                        `.tmp/release-evidence/projections/${domain}.json`)
                ));
                assert.equal(projected.status, 0, projected.stderr);
            }
        }
        const finalBindings = collectReleaseFinalDomainProjectionReceipts(
            finalReceiptOptions(fixture.directory)
        );
        assert.deepEqual(
            finalBindings.map((binding) => binding.tierId),
            releaseFinalProjectionDomains
        );
        const projectionOnlyRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'fsusblog-release-final-projections-')
        );
        try
        {
            fs.copyFileSync(
                path.join(fixture.directory, 'ledger.json'),
                path.join(projectionOnlyRoot, 'ledger.json')
            );
            fs.cpSync(
                path.join(fixture.directory, 'catalogs'),
                path.join(projectionOnlyRoot, 'catalogs'),
                { recursive: true }
            );
            for (const tierId of releaseFinalProjectionDomains)
            {
                const relativeReceipt =
                    `.tmp/release-evidence/projections/${tierId}.json`;
                const target = path.join(projectionOnlyRoot, relativeReceipt);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(
                    path.join(fixture.directory, relativeReceipt),
                    target
                );
            }
            assert.equal(
                fs.existsSync(path.join(projectionOnlyRoot, '.tmp/test-results')),
                false
            );
            const projectionOnlyBindings =
                collectReleaseFinalDomainProjectionReceipts(
                    finalReceiptOptions(projectionOnlyRoot)
                );
            assert.deepEqual(projectionOnlyBindings, finalBindings);
        }
        finally
        {
            fs.rmSync(projectionOnlyRoot, { recursive: true, force: true });
        }
        for (const unexpectedSet of [
            releaseFinalProjectionDomains.slice(1),
            [...releaseFinalProjectionDomains, 'release-rbac-negative'].sort(),
            releaseFinalProjectionDomains.map((tierId, index) =>
                index === 0 ? 'release-aot-consumption' : tierId).sort()
        ])
        {
            assert.throws(
                () => collectReleaseFinalDomainProjectionReceipts(
                    finalReceiptOptions(fixture.directory, unexpectedSet)
                ),
                /do not exactly match the canonical release-domain set/u
            );
        }
        const adminProjection = path.join(
            fixture.directory,
            '.tmp/release-evidence/projections/release-admin-console.json'
        );
        const duplicateProjection = path.join(
            fixture.directory,
            '.tmp/release-evidence/projections/duplicates/release-admin-console.json'
        );
        fs.mkdirSync(path.dirname(duplicateProjection), { recursive: true });
        fs.copyFileSync(adminProjection, duplicateProjection);
        assert.throws(
            () => collectReleaseFinalDomainProjectionReceipts(
                finalReceiptOptions(fixture.directory)
            ),
            /requires exactly one projection receipt/u
        );
        fs.rmSync(duplicateProjection);
        const originalAdminProjection = fs.readFileSync(adminProjection);
        fs.rmSync(adminProjection);
        assert.throws(
            () => collectReleaseFinalDomainProjectionReceipts(
                finalReceiptOptions(fixture.directory)
            ),
            /requires exactly one projection receipt/u
        );
        fs.writeFileSync(adminProjection, originalAdminProjection);
        const tamperedAdminProjection =
            JSON.parse(originalAdminProjection.toString('utf8'));
        tamperedAdminProjection.generatedAt = 'tampered';
        writeJson(adminProjection, tamperedAdminProjection);
        assert.throws(
            () => collectReleaseFinalDomainProjectionReceipts(
                finalReceiptOptions(fixture.directory)
            ),
            /schema, status, mode, or digest is invalid/u
        );
        fs.writeFileSync(adminProjection, originalAdminProjection);
        const resealedBuildTamper =
            JSON.parse(originalAdminProjection.toString('utf8'));
        resealedBuildTamper.buildIdentity = `sha256:${'f'.repeat(64)}`;
        writeJson(
            adminProjection,
            sealProjectionDocument(resealedBuildTamper)
        );
        assert.throws(
            () => collectReleaseFinalDomainProjectionReceipts(
                finalReceiptOptions(fixture.directory)
            ),
            /build identity does not match its declared artifact/u
        );
        fs.writeFileSync(adminProjection, originalAdminProjection);

        const frontendReceiptPath = path.join(
            fixture.directory,
            '.tmp/test-results/evidence-producers/frontend-unit-shard/release-run/release-auth-flow.json'
        );
        const forgedReceipt =
            JSON.parse(fs.readFileSync(frontendReceiptPath, 'utf8'));
        forgedReceipt.assertions[0].sourceTestIds = ['vitest:forged'];
        writeJson(frontendReceiptPath, sealProjectionDocument(forgedReceipt));
        const forgedProjection = runTool(fixture, projectionArgs(
            fixture,
            'release-auth-flow.json',
            path.join(fixture.directory,
                'projections/release-auth-flow-forged.json')
        ));
        assert.notEqual(forgedProjection.status, 0);
        assert.match(
            forgedProjection.stderr,
            /do not exactly match executed assertion report/u
        );

        const nativeVitest = JSON.parse(fs.readFileSync(
            path.join(fixture.directory, fixture.vitestPath),
            'utf8'
        ));
        nativeVitest.testResults[0].assertionResults[0].status = 'failed';
        writeJson(path.join(fixture.directory, fixture.vitestPath), nativeVitest);
        const tamperedProjection = runTool(fixture, projectionArgs(
            fixture,
            'release-admin-console.json',
            path.join(fixture.directory,
                'projections/release-admin-console-tampered.json')
        ));
        assert.notEqual(tamperedProjection.status, 0);
        assert.match(
            tamperedProjection.stderr,
            /native source artifact digest mismatch/u
        );

        const logOnly = path.join(
            fixture.directory,
            '.tmp/test-results/release-domain-assertions/browser-diagnostics-manual/release-run.json'
        );
        writeJson(logOnly, { log: 'all tests passed' });
        const rejected = runTool(fixture,
            ['tools/test/produce-release-domain-receipt.mjs',
                '--root', fixture.directory,
                '--producer', 'browser-diagnostics-manual',
                '--ledger', 'ledger.json', '--catalog-directory', 'catalogs']);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /schema or digest is invalid/u);
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('browser diagnostics all-of evidence rejects missing, extra, failed and tampered probe assertions', () =>
{
    const fixture = nativeExecutionFixture();
    try
    {
        const entry = ledger.entries.find((candidate) =>
            candidate.producerEvidence.kind
                === 'browser-diagnostics-release-assertion'
            && candidate.producerEvidence.assertionId
                === 'check:security:permissions');
        const selector = entry.producerEvidence;
        const sourceArtifactPaths =
            [selector.assertionArtifactPath, selector.receiptPath].sort();
        const policyIdentity =
            sha256File(path.join(fixture.directory, 'ledger.json'));
        const validate = () => validateNativeAssertionEvidence({
            repositoryRoot: fixture.directory,
            entry,
            sourceArtifactPaths,
            sourceState,
            runId: 'release-run',
            namespace: 'release-namespace',
            policyIdentity
        });
        assert.deepEqual(validate(), sourceArtifactPaths);
        const assertionFile =
            path.join(fixture.directory, selector.assertionArtifactPath);
        const receiptFile =
            path.join(fixture.directory, selector.receiptPath);
        const originalAssertion =
            JSON.parse(fs.readFileSync(assertionFile, 'utf8'));
        const originalReceipt =
            JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        const mutateAssertion = (change, { reseal = true } = {}) =>
        {
            const value = structuredClone(originalAssertion);
            change(value);
            writeJson(
                assertionFile,
                reseal ? sealProjectionDocument(value) : value
            );
        };
        mutateAssertion((value) => value.assertions.pop());
        assert.throws(validate, /all-of set is invalid/u);
        mutateAssertion((value) => value.assertions.push({
            id: 'check:security:unknown',
            outcome: 'success'
        }));
        assert.throws(validate, /all-of set is invalid/u);
        mutateAssertion((value) => value.assertions.find((assertion) =>
            assertion.id === selector.assertionId).outcome = 'failure');
        assert.throws(validate, /all-of set is invalid/u);
        mutateAssertion(
            (value) => value.generatedAt = 'tampered',
            { reseal: false }
        );
        assert.throws(validate, /all-of set is invalid/u);
        writeJson(assertionFile, originalAssertion);

        const mutateReceipt = (change, { reseal = true } = {}) =>
        {
            const value = structuredClone(originalReceipt);
            change(value);
            writeJson(
                receiptFile,
                reseal ? sealProjectionDocument(value) : value
            );
        };
        mutateReceipt((value) => value.category.probes.pop());
        assert.throws(validate, /probe IDs or outcomes are incomplete/u);
        mutateReceipt((value) => value.category.probes.push({
            ...structuredClone(value.category.probes[0]),
            id: 'release-extra'
        }));
        assert.throws(validate, /probe IDs or outcomes are incomplete/u);
        mutateReceipt((value) => value.category.probes.find((probe) =>
            probe.id === selector.probeId).status = 'failure');
        assert.throws(validate, /did not pass exactly once/u);
        mutateReceipt((value) => value.runId = 'tampered', { reseal: false });
        assert.throws(validate, /source, run, build, or digest is invalid/u);
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('nested live-grant assertions reject deleted, extra, duplicate and failed execution IDs', () =>
{
    const fixture = nativeExecutionFixture();
    try
    {
        const entry =
            ledger.entries.find((candidate) => candidate.producerEvidence.nestedId);
        const sourceArtifactPaths = [fixture.liveGrantPath];
        const validate = () => validateNativeAssertionEvidence({
            repositoryRoot: fixture.directory,
            entry,
            sourceArtifactPaths,
            sourceState,
            runId: 'release-run'
        });
        assert.deepEqual(validate(), sourceArtifactPaths);
        const file = path.join(fixture.directory, fixture.liveGrantPath);
        const original = JSON.parse(fs.readFileSync(file, 'utf8'));
        const mutate = (change) =>
        {
            const value = structuredClone(original);
            const child = value.children.find((candidate) =>
                candidate.id === entry.producerEvidence.childId);
            change(child.nestedAssertions);
            writeJson(file, value);
        };
        mutate((nested) => nested.pop());
        assert.throws(
            validate,
            /nested assertion IDs do not exactly match/u
        );
        mutate((nested) => nested.push({
            id: 'views-constraints:unknown',
            status: 'success'
        }));
        assert.throws(
            validate,
            /nested assertion IDs do not exactly match/u
        );
        mutate((nested) => nested.push(structuredClone(nested[0])));
        assert.throws(
            validate,
            /nested assertion IDs do not exactly match/u
        );
        mutate((nested) => nested.find((candidate) =>
            candidate.id === entry.producerEvidence.nestedId).status = 'failure');
        assert.throws(
            validate,
            /nested assertion is missing or unsuccessful/u
        );
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});
