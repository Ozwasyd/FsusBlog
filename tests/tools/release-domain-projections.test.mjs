import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

await import('./release-domain-native-evidence.cases.mjs');

const root = path.resolve(import.meta.dirname, '../..');
const {
    createEvidenceProducerReceipt,
    projectEvidence,
    sealProjectionDocument
} = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/evidence-projection.mjs')
).href);
const {
    createAssertionReport,
    evidenceSelectorDigest,
    releaseDomainReportSchema,
    sha256File,
    validateAssertionReport,
    validateCatalogAgainstLedger,
    validateDispositionLedger,
    validateReleaseDomainMatrix
} = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/release-domain-evidence.mjs')
).href);
const { parseMatrix } = await import(pathToFileURL(
    path.join(root, 'tools/test-matrix/parse-matrix.mjs')
).href);

const domains = [
    'release-admin-console',
    'release-aot-consumption',
    'release-aot-generation',
    'release-auth-flow',
    'release-authoring-flow',
    'release-error-boundary',
    'release-private-preview',
    'release-rbac-negative',
    'release-static-asset-digest-coherence'
];
const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
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

function strictFixture(domain)
{
    const directory =
        fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-projection-'));
    const value = catalog(domain);
    const ledgerPath = path.join(directory, value.dispositionLedger);
    writeJson(ledgerPath, ledger);
    const entries = validateCatalogAgainstLedger(value, ledger);
    const artifacts = value.requiredArtifactDeclarations.map((declaration) =>
    {
        const file = path.join(directory, declaration.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${declaration.id}\n`);
        return { ...declaration, digest: sha256File(file) };
    });
    const buildIdentity = artifacts
        .find((artifact) => artifact.id === value.buildIdentityArtifactId).digest;
    const policyIdentity = sha256File(ledgerPath);
    const reportPath = path.join(directory, 'reports', `${domain}.json`);
    writeJson(reportPath, { schema: releaseDomainReportSchema });
    const receipt = createEvidenceProducerReceipt({
        producerId: value.projectFrom,
        logicalTierId: domain,
        sourceState,
        runId: 'release-run',
        namespace: 'release-namespace',
        buildIdentity,
        policyIdentity,
        assertionReport: {
            path: path.relative(directory, reportPath),
            digest: sha256File(reportPath)
        },
        assertions: entries.map((entry) => ({
            id: entry.requiredTestId,
            outcome: 'Passed',
            sourceTestIds: entry.sourceTestIds,
            coverageIds: value.requiredCoverageIds,
            artifactIds: entry.requiredArtifactIds
        })),
        artifacts,
        generatedAt: '2026-07-26T00:00:00.000Z'
    });
    const project = (candidate = receipt, overrides = {}) => projectEvidence({
        catalog: value,
        producerReceipt: candidate,
        producerReceiptPath: `evidence/${domain}.json`,
        sourceState,
        runId: 'release-run',
        namespace: 'release-namespace',
        buildIdentity,
        policyIdentity,
        repositoryRoot: directory,
        generatedAt: '2026-07-26T00:01:00.000Z',
        ...overrides
    });
    return {
        directory,
        value,
        receipt,
        project,
        buildIdentity,
        policyIdentity,
        reportPath
    };
}

test('machine-readable disposition ledger maps every historical assertion exactly once into nine catalogs', () =>
{
    const entries = validateDispositionLedger(ledger);
    assert.equal(entries.length, 24);
    assert.deepEqual(
        [...new Set(entries.map((entry) => entry.tierId))].sort(),
        domains
    );
    assert.ok(entries.every((entry) => !Object.hasOwn(entry, 'command')));
    assert.ok(entries.every((entry) =>
        entry.replacementProof.kind === 'structured-producer-assertion'));
    assert.ok(entries.every((entry) =>
        entry.outputReceiptPath
            === `.tmp/release-evidence/projections/${entry.tierId}.json`));
    assert.ok(entries.every((entry) =>
        entry.producerEvidence.kind !== 'browser-contract-scenarios'));
    const diagnosticSelectors = entries.filter((entry) =>
        entry.producerEvidence.kind === 'browser-diagnostics-release-assertion');
    assert.equal(diagnosticSelectors.length, 5);
    assert.deepEqual(
        [...new Set(diagnosticSelectors.flatMap(
            (entry) => entry.producerEvidence.assertionIds
        ))].sort(),
        [
            'check:distribution-version-coherence',
            'check:pow-runtime',
            'check:public-hydration',
            'check:security:attack-matrix',
            'check:security:permissions'
        ]
    );
    for (const domain of domains)
    {
        const entriesForDomain =
            validateCatalogAgainstLedger(catalog(domain), ledger);
        assert.ok(entriesForDomain.length > 0);
        assert.ok(entriesForDomain.every((entry) =>
            entry.replacementProof.reportSchema === releaseDomainReportSchema));
    }
    const duplicate = structuredClone(ledger);
    duplicate.entries.push(structuredClone(duplicate.entries[0]));
    assert.throws(
        () => validateDispositionLedger(duplicate),
        /sorted and unique/u
    );
    const executable = structuredClone(ledger);
    executable.entries[0].command = { file: 'node', args: [] };
    assert.throws(
        () => validateDispositionLedger(executable),
        /must not contain an executable command/u
    );
    const wrongOutput = structuredClone(ledger);
    wrongOutput.entries[0].outputReceiptPath =
        '.tmp/release-evidence/projections/other.json';
    assert.throws(
        () => validateDispositionLedger(wrongOutput),
        /outputReceiptPath must be/u
    );
    const missing = structuredClone(catalog('release-auth-flow'));
    missing.dispositionIds = [];
    assert.throws(
        () => validateCatalogAgainstLedger(missing, ledger),
        /disposition IDs do not exactly match/u
    );
    const obsolete = structuredClone(ledger);
    obsolete.entries[0].obsolete = true;
    obsolete.entries[0].disposition = 'obsolete-duplicate';
    assert.throws(
        () => validateDispositionLedger(obsolete),
        /requires replacement proof/u
    );
    const targetOnly = structuredClone(ledger);
    targetOnly.entries[0].targetOnly = true;
    targetOnly.entries[0].disposition =
        'target-environment-release-closeout';
    assert.throws(
        () => validateDispositionLedger(targetOnly),
        /must belong to release-closeout/u
    );
});

test('nine domains accept exact receipts and projection execution boundary launches no producer', () =>
{
    for (const domain of domains)
    {
        const fixture = strictFixture(domain);
        try
        {
            const receipt = fixture.project();
            assert.equal(receipt.tierId, domain);
            assert.equal(receipt.executionBoundary.childProcessCount, 0);
            assert.deepEqual(receipt.testIds, fixture.value.requiredTestIds);
        }
        finally
        {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    }
});

test('projection rejects every missing, duplicate, extra, failed and cancelled producer set mutation', () =>
{
    for (const domain of domains)
    {
        const fixture = strictFixture(domain);
        try
        {
            const mutated = (mutate) =>
            {
                const value = structuredClone(fixture.receipt);
                mutate(value);
                return sealProjectionDocument(value);
            };
            assert.throws(
                () => fixture.project(mutated((value) => value.assertions = [])),
                /non-empty array|test IDs do not exactly match/u,
                domain
            );
            assert.throws(() => fixture.project(mutated((value) =>
                value.assertions.push(structuredClone(value.assertions[0])))),
            /duplicate IDs/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.assertions.push({
                    ...structuredClone(value.assertions[0]),
                    id: 'unknown/test'
                }))),
            /test IDs do not exactly match/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.assertions[0].coverageIds = [])),
            /non-empty array/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.assertions[0].coverageIds.push(
                    value.assertions[0].coverageIds[0]
                ))),
            /duplicate IDs/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.assertions[0].coverageIds.push('unknown/coverage'))),
            /coverage IDs do not exactly match/u, domain);
            assert.throws(
                () => fixture.project(mutated((value) => value.artifacts = [])),
                /non-empty array|artifact IDs do not exactly match/u,
                domain
            );
            assert.throws(() => fixture.project(mutated((value) =>
                value.artifacts.push(structuredClone(value.artifacts[0])))),
            /duplicate IDs/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.artifacts.push({
                    id: 'unknown-artifact',
                    path: 'unknown',
                    digest: `sha256:${'0'.repeat(64)}`
                }))),
            /artifact IDs do not exactly match/u, domain);
            assert.throws(
                () => fixture.project(mutated((value) => value.status = 'failed')),
                /status must be success/u,
                domain
            );
            assert.throws(
                () => fixture.project(mutated((value) => value.status = 'cancelled')),
                /status must be success/u,
                domain
            );
            assert.throws(() => fixture.project(mutated((value) =>
                value.sourceState.commit = 'e'.repeat(40))),
            /commit does not match/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.sourceState.worktreeFingerprint = 'f'.repeat(64))),
            /worktree fingerprint does not match/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.runId = 'another-run')),
            /another run/u, domain);
            assert.throws(() => fixture.project(mutated((value) =>
                value.namespace = 'another-namespace')),
            /another namespace/u, domain);
            assert.throws(
                () => fixture.project(fixture.receipt, {
                    buildIdentity: `sha256:${'c'.repeat(64)}`
                }),
                /build identity/u,
                domain
            );
            assert.throws(
                () => fixture.project(fixture.receipt, {
                    policyIdentity: `sha256:${'d'.repeat(64)}`
                }),
                /policy identity/u,
                domain
            );
            writeJson(
                fixture.reportPath,
                { schema: releaseDomainReportSchema, tampered: true }
            );
            assert.throws(
                () => fixture.project(),
                /assertion report digest mismatch/u,
                domain
            );
            writeJson(fixture.reportPath, { schema: releaseDomainReportSchema });
            fs.writeFileSync(
                path.join(
                    fixture.directory,
                    fixture.value.requiredArtifactDeclarations[0].path
                ),
                'tampered\n'
            );
            assert.throws(
                () => fixture.project(),
                /artifact digest mismatch/u,
                domain
            );
        }
        finally
        {
            fs.rmSync(fixture.directory, { recursive: true, force: true });
        }
    }
});

test('receipt builder revalidates run-bound native artifact digests and producer selectors', () =>
{
    const directory =
        fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-report-'));
    try
    {
        const entry = ledger.entries.find((candidate) =>
            candidate.producerEvidence.kind === 'vitest-file');
        const sourcePath =
            '.tmp/test-results/vitest/frontend-unit-shard-release-run/result.json';
        const sourceFile = path.join(directory, sourcePath);
        writeJson(sourceFile, {
            testResults: [{
                name: path.join(directory, entry.producerEvidence.file),
                status: 'passed',
                assertionResults: [{ status: 'passed' }]
            }]
        });
        const expected = {
            producerId: entry.canonicalProducer,
            entries: [entry],
            sourceState,
            runId: 'release-run',
            namespace: 'release-namespace',
            buildIdentity: `sha256:${'c'.repeat(64)}`,
            policyIdentity: `sha256:${'d'.repeat(64)}`,
            repositoryRoot: directory
        };
        const assertion = {
            id: entry.requiredTestId,
            dispositionId: entry.id,
            executed: true,
            outcome: 'Passed',
            sourceTestIds: entry.sourceTestIds,
            producerEvidenceDigest:
                evidenceSelectorDigest(entry.producerEvidence),
            sourceArtifactPaths: [sourcePath]
        };
        const sourceArtifacts =
            [{ path: sourcePath, digest: sha256File(sourceFile) }];
        const report = (
            assertions,
            status = 'success',
            artifacts = sourceArtifacts
        ) => createAssertionReport({
            ...expected,
            assertions,
            sourceArtifacts: artifacts,
            status
        });
        assert.deepEqual(
            validateAssertionReport({ report: report([assertion]), ...expected }),
            [assertion]
        );
        assert.throws(
            () => validateAssertionReport({ report: report([]), ...expected }),
            /IDs do not exactly match/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report([assertion, assertion]),
                ...expected
            }),
            /IDs do not exactly match/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report([{ ...assertion, id: 'unknown' }]),
                ...expected
            }),
            /IDs do not exactly match/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report([{ ...assertion, outcome: 'Failed' }], 'failed'),
                ...expected
            }),
            /status must be success/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report(
                    [{ ...assertion, outcome: 'Cancelled' }],
                    'cancelled'
                ),
                ...expected
            }),
            /status must be success/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report([{
                    ...assertion,
                    sourceTestIds: ['forged']
                }]),
                ...expected
            }),
            /source test IDs mismatch/u
        );
        assert.throws(
            () => validateAssertionReport({
                report: report([{
                    ...assertion,
                    producerEvidenceDigest: `sha256:${'0'.repeat(64)}`
                }]),
                ...expected
            }),
            /producer evidence identity mismatch/u
        );
        const stalePath = '.tmp/test-results/vitest/stale-run/result.json';
        const staleFile = path.join(directory, stalePath);
        fs.mkdirSync(path.dirname(staleFile), { recursive: true });
        fs.copyFileSync(sourceFile, staleFile);
        assert.throws(
            () => validateAssertionReport({
                report: report(
                    [{ ...assertion, sourceArtifactPaths: [stalePath] }],
                    'success',
                    [{ path: stalePath, digest: sha256File(staleFile) }]
                ),
                ...expected
            }),
            /not bound to the current run/u
        );
        fs.writeFileSync(sourceFile, '{"testResults":[]}\n');
        assert.throws(
            () => validateAssertionReport({
                report: report([assertion]),
                ...expected
            }),
            /native source artifact digest mismatch/u
        );
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('same-tier duplicate producer receipts are ambiguous even when both are sealed', () =>
{
    const fixture = strictFixture('release-auth-flow');
    try
    {
        const producerDirectory = path.join(fixture.directory, 'producers');
        fs.mkdirSync(producerDirectory);
        fs.writeFileSync(
            path.join(producerDirectory, 'one.json'),
            JSON.stringify(fixture.receipt)
        );
        fs.writeFileSync(
            path.join(producerDirectory, 'two.json'),
            JSON.stringify(fixture.receipt)
        );
        const run = spawnSync(process.execPath, [
            'tools/test/project-evidence.mjs',
            '--catalog',
            path.join(
                root,
                'tests/fixtures/evidence-projection/release-auth-flow.json'
            ),
            '--producer-directory',
            producerDirectory,
            '--output',
            path.join(fixture.directory, 'projection.json'),
            '--root',
            fixture.directory,
            '--commit',
            sourceState.commit,
            '--worktree-fingerprint',
            sourceState.worktreeFingerprint,
            '--run-id',
            'release-run',
            '--namespace',
            'release-namespace'
        ], { cwd: root, encoding: 'utf8' });
        assert.notEqual(run.status, 0);
        assert.match(
            run.stderr,
            /expected exactly one canonical producer receipt/u
        );
    }
    finally
    {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('matrix and catalogs consume the ledger with zero issue-specific validator diagnostics', () =>
{
    const matrix =
        parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    assert.deepEqual(validateReleaseDomainMatrix(root, matrix), []);
    for (const domain of domains)
    {
        const tier = matrix.tiers.find((candidate) => candidate.id === domain);
        assert.equal(tier.executionMode, 'projection');
        assert.deepEqual(tier.executionDependsOn, []);
        assert.doesNotMatch(
            tier.command,
            /(?:vitest|playwright|dotnet|npm|build|aggregate)/iu
        );
    }
    for (const file of [
        'tools/test/write-browser-diagnostics-release-assertions.mjs',
        'tools/test/write-release-domain-assertion-report.mjs',
        'tools/test/produce-release-domain-receipt.mjs',
        'tools/test/project-evidence.mjs'
    ])
    {
        assert.doesNotMatch(
            fs.readFileSync(path.join(root, file), 'utf8'),
            /node:child_process|spawn(?:Sync)?\(|execFile|fork\(/u
        );
    }
    assert.equal(
        fs.existsSync(
            path.join(root, 'tools/test/run-release-domain-assertions.mjs')
        ),
        false
    );
    for (const lane of [
        'browser-diagnostics.sh',
        'frontend-unit-shard.sh',
        'release-evidence.sh',
        'test-quality-lint.sh'
    ])
    {
        const source =
            fs.readFileSync(path.join(root, 'tools/test/lanes', lane), 'utf8');
        assert.ok(
            source.indexOf('write-release-domain-assertion-report.mjs')
                < source.indexOf('produce-release-domain-receipt.mjs')
        );
    }
    const browserLane = fs.readFileSync(
        path.join(root, 'tools/test/lanes/browser-diagnostics.sh'),
        'utf8'
    );
    assert.ok(
        browserLane.indexOf('tests/browser-diagnostics/run.mjs')
            < browserLane.indexOf('write-release-domain-assertion-report.mjs')
    );
});
