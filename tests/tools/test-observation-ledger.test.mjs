import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* eslint-disable import-x/no-relative-parent-imports */
import {
    aggregateObservationArtifacts,
    compactObservationStore,
    computeSourceClosureDigest,
    createObservationArtifact,
    failureSignature,
    ingestObservationArtifact,
    observationArtifactSchema,
    rebuildObservationIndex,
    sha256,
    validateObservationArtifact
} from '../../tools/test-observations/ledger.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(repositoryRoot, 'tests/fixtures/test-observations');
const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: `sha256:${'b'.repeat(64)}`
};
const closureDigest = `sha256:${'c'.repeat(64)}`;

function metadata({
    runId = 'fixture-run-1',
    runtime = 'node-v24.16.0',
    browser = null,
    project = null
} = {})
{
    return {
        sourceState,
        sourceClosureDigest: closureDigest,
        runner: { os: 'linux', arch: 'x64', runtime, browser, project },
        run: { id: runId, attemptKind: 'primary', evidenceClass: 'correctness' }
    };
}

function artifact(framework, file, overrides = {})
{
    return createObservationArtifact({
        framework,
        reportFile: path.join(fixtures, file),
        evidenceReference: `tests/fixtures/test-observations/${file}`,
        suite: overrides.suite ?? `${framework}-fixture`,
        partition: overrides.partition ?? 'fixture',
        metadata: metadata(overrides),
        observedAt: overrides.observedAt ?? '2026-07-23T00:00:00.000Z'
    });
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('TRX, Vitest, Node TAP and Playwright adapters emit one source-bound schema', () =>
{
    const artifacts = [
        artifact('xunit-trx', 'xunit.trx', { runtime: 'dotnet-10.0.100' }),
        artifact('vitest', 'vitest.json'),
        artifact('node-tap', 'node.tap'),
        artifact('playwright', 'playwright.json', {
            runtime: 'node-v24.16.0/playwright-1.55.0',
            browser: 'chromium-140',
            project: 'multi-project'
        })
    ];

    assert.ok(artifacts.every((entry) => entry.schema === observationArtifactSchema));
    assert.deepEqual(artifacts.map((entry) => entry.observations.length), [3, 3, 3, 3]);
    assert.deepEqual(
        [...new Set(artifacts.flatMap((entry) => entry.observations.map((observation) => observation.outcome)))].sort(),
        ['blocked', 'failed', 'passed', 'skipped']
    );
    assert.ok(artifacts.flatMap((entry) => entry.observations)
        .some((entry) => entry.testId.includes('Adds(value: 1)')));
    assert.ok(artifacts.flatMap((entry) => entry.observations)
        .some((entry) => entry.testId.includes('adds [1, 2, 3]')));

    const duplicateVitestNames = artifacts[1].observations
        .filter((entry) => entry.testId.includes('duplicate name'))
        .map((entry) => entry.testId);
    assert.equal(new Set(duplicateVitestNames).size, 2, 'suite identity must distinguish duplicate names');

    const playwrightAttempts = artifacts[3].observations
        .filter((entry) => entry.testId.includes('opens parameterized destination'));
    assert.equal(new Set(playwrightAttempts.map((entry) => entry.testId)).size, 1);
    assert.deepEqual(playwrightAttempts.map((entry) => entry.partition).sort(), ['chromium', 'mobile-chromium']);

    for (const entry of artifacts)
    {
        assert.deepEqual(validateObservationArtifact(entry, { evidenceRoot: repositoryRoot }), []);
        for (const observation of entry.observations)
        {
            assert.deepEqual(observation.sourceState, sourceState);
            assert.equal(observation.sourceClosureDigest, closureDigest);
            assert.equal(observation.producer.digest, entry.producer.digest);
            assert.equal(observation.run.id, 'fixture-run-1');
        }
    }
});

test('adapters fail closed for malformed reports, unknown outcomes and invalid durations', () =>
{
    assert.throws(
        () => artifact('vitest', 'malformed-vitest.json'),
        /outcome is unknown/u
    );
    assert.throws(() => createObservationArtifact({
        framework: 'node-tap',
        reportFile: path.join(fixtures, 'node.tap'),
        evidenceReference: '../outside/node.tap',
        suite: 'unsafe-reference',
        metadata: metadata()
    }), /producer reference must stay within the evidence root/u);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-observation-malformed-'));
    try
    {
        const file = path.join(directory, 'invalid-duration.json');
        writeJson(file, {
            testResults: [{
                name: 'duration.test.ts',
                assertionResults: [{
                    ancestorTitles: ['duration'],
                    title: 'negative duration',
                    status: 'passed',
                    duration: -1,
                    failureMessages: []
                }]
            }]
        });
        assert.throws(() => createObservationArtifact({
            framework: 'vitest',
            reportFile: file,
            evidenceReference: 'invalid-duration.json',
            suite: 'duration',
            metadata: metadata()
        }), /duration must be a finite non-negative number/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('failure signatures remove run path, port and timestamp noise without merging distinct failures', () =>
{
    const first = `Xunit.Sdk.EqualException: expected 1\n`
        + `at /tmp/run-aaaaaaaa/tests/ValueTests.cs:42:9\n`
        + `endpoint http://127.0.0.1:43127 at 2026-07-23T01:02:03.456Z`;
    const noisyEquivalent = `Xunit.Sdk.EqualException: expected 1\n`
        + `at /var/tmp/run-bbbbbbbb/tests/ValueTests.cs:42:9\n`
        + `endpoint http://127.0.0.1:51999 at 2026-07-24T04:05:06.000Z`;
    const differentException = noisyEquivalent.replace('Xunit.Sdk.EqualException', 'System.InvalidOperationException');
    const differentAssertionLocation = noisyEquivalent.replace('ValueTests.cs:42:9', 'ValueTests.cs:43:9');

    assert.equal(failureSignature(first), failureSignature(noisyEquivalent));
    assert.notEqual(failureSignature(first), failureSignature(differentException));
    assert.notEqual(failureSignature(first), failureSignature(differentAssertionLocation));
});

test('aggregator rejects source, closure and producer digest mismatches', () =>
{
    const valid = artifact('node-tap', 'node.tap');
    assert.doesNotThrow(() => aggregateObservationArtifacts([valid], {
        evidenceRoot: repositoryRoot,
        expectedSourceState: sourceState,
        expectedClosureDigest: closureDigest
    }));

    const wrongSource = structuredClone(valid);
    wrongSource.observations[0].sourceState = {
        ...wrongSource.observations[0].sourceState,
        commit: 'd'.repeat(40)
    };
    assert.throws(() => aggregateObservationArtifacts([wrongSource]), /source identity mismatch/u);

    const wrongClosure = structuredClone(valid);
    wrongClosure.observations[0].sourceClosureDigest = `sha256:${'d'.repeat(64)}`;
    assert.throws(() => aggregateObservationArtifacts([wrongClosure]), /source closure digest mismatch/u);

    assert.throws(() => aggregateObservationArtifacts([valid], {
        expectedSourceState: { ...sourceState, commit: 'e'.repeat(40) }
    }), /artifact source identity mismatch/u);
    assert.throws(() => aggregateObservationArtifacts([valid], {
        expectedClosureDigest: `sha256:${'e'.repeat(64)}`
    }), /artifact source closure digest mismatch/u);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-observation-producer-'));
    try
    {
        const producer = path.join(directory, 'node.tap');
        fs.copyFileSync(path.join(fixtures, 'node.tap'), producer);
        const bound = createObservationArtifact({
            framework: 'node-tap',
            reportFile: producer,
            evidenceReference: 'node.tap',
            suite: 'producer',
            metadata: metadata()
        });
        fs.appendFileSync(producer, '\n# changed after projection\n');
        assert.throws(
            () => aggregateObservationArtifacts([bound], { evidenceRoot: directory }),
            /producer report digest mismatch/u
        );
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('append-only history is idempotent and index rebuild survives index deletion', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-observation-history-'));
    try
    {
        const evidenceRoot = path.join(directory, 'evidence');
        const store = path.join(directory, 'history');
        fs.mkdirSync(evidenceRoot, { recursive: true });

        const reports = [
            {
                name: 'run-1.json',
                runId: 'run-1',
                duration: 10,
                status: 'passed',
                failureMessages: []
            },
            {
                name: 'run-2.json',
                runId: 'run-2',
                duration: 90,
                status: 'failed',
                failureMessages: ['AssertionError: expected true\n at /tmp/run-deadbeef/tests/stable.test.ts:17:4']
            }
        ];
        const artifactFiles = reports.map((report, index) =>
        {
            const producer = path.join(evidenceRoot, report.name);
            writeJson(producer, {
                testResults: [{
                    name: 'tests/stable.test.ts',
                    assertionResults: [{
                        ancestorTitles: ['ledger'],
                        title: 'tracks history',
                        status: report.status,
                        duration: report.duration,
                        failureMessages: report.failureMessages
                    }]
                }]
            });
            const projected = createObservationArtifact({
                framework: 'vitest',
                reportFile: producer,
                evidenceReference: report.name,
                suite: 'ledger',
                metadata: metadata({ runId: report.runId }),
                observedAt: `2026-07-23T00:00:0${index}.000Z`
            });
            const artifactFile = path.join(directory, `artifact-${index}.json`);
            writeJson(artifactFile, projected);
            return artifactFile;
        });

        assert.equal(ingestObservationArtifact({
            artifactFile: artifactFiles[0], storeDirectory: store, evidenceRoot
        }).added, true);
        assert.equal(ingestObservationArtifact({
            artifactFile: artifactFiles[0], storeDirectory: store, evidenceRoot
        }).added, false);
        assert.equal(ingestObservationArtifact({
            artifactFile: artifactFiles[1], storeDirectory: store, evidenceRoot
        }).added, true);

        const first = rebuildObservationIndex({ storeDirectory: store, evidenceRoot });
        assert.equal(first.coldStart, false);
        assert.equal(first.artifactCount, 2);
        assert.equal(first.observationCount, 2);
        assert.equal(first.tests[0].durationMs.p50, 10);
        assert.equal(first.tests[0].durationMs.p95, 90);
        assert.deepEqual(first.tests[0].outcomeCounts, {
            passed: 1, failed: 1, skipped: 0, blocked: 0
        });
        assert.equal(Object.values(first.tests[0].signatureCounts)[0], 1);

        fs.rmSync(path.join(store, 'index.json'));
        const rebuilt = rebuildObservationIndex({ storeDirectory: store, evidenceRoot });
        assert.deepEqual(rebuilt, first);

        const compacted = compactObservationStore({
            storeDirectory: store,
            maxArtifacts: 1,
            maxAgeDays: 365,
            now: new Date('2026-07-24T00:00:00.000Z')
        });
        assert.equal(compacted.kept.length, 1);
        assert.equal(compacted.removed.length, 1);
        assert.equal(fs.existsSync(path.join(store, 'index.json')), false);
        const afterCompaction = rebuildObservationIndex({ storeDirectory: store, evidenceRoot });
        assert.equal(afterCompaction.artifactCount, 1);
        assert.equal(afterCompaction.tests[0].durationMs.p50, 90);

        const emptyStore = path.join(directory, 'cold-start');
        const coldStart = rebuildObservationIndex({ storeDirectory: emptyStore });
        assert.equal(coldStart.coldStart, true);
        assert.equal(coldStart.observationCount, 0);
        assert.deepEqual(coldStart.tests, []);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('checked-in schema declares the source and producer bindings enforced by the runtime validator', () =>
{
    const schema = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'config/schemas/test-observation-artifact.schema.json'),
        'utf8'
    ));
    assert.equal(schema.properties.schema.const, observationArtifactSchema);
    assert.ok(schema.required.includes('sourceClosureDigest'));
    assert.ok(schema.required.includes('producer'));
    assert.ok(schema.$defs.observation.required.includes('sourceState'));
    assert.ok(schema.$defs.observation.required.includes('producer'));
    assert.equal(schema.$defs.observation.properties.durationMs.minimum, 0);
    assert.equal(sha256(Buffer.from('fixture')), 'sha256:f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d');

    const firstClosure = computeSourceClosureDigest({
        root: repositoryRoot,
        paths: [
            'tools/test-observations/adapters.mjs',
            'tools/test-observations/source-identity.mjs',
            'tools/test-observations/validation.mjs',
            'tools/test-observations/ledger.mjs',
            'tests/fixtures/test-observations/node.tap'
        ]
    });
    const reorderedClosure = computeSourceClosureDigest({
        root: repositoryRoot,
        paths: [
            'tests/fixtures/test-observations/node.tap',
            'tools/test-observations/ledger.mjs',
            'tools/test-observations/source-identity.mjs',
            'tools/test-observations/validation.mjs',
            'tools/test-observations/adapters.mjs'
        ]
    });
    assert.match(firstClosure, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(reorderedClosure, firstClosure);
});

test('local CLI builds, ingests and rebuilds a fixture ledger without network services', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-observation-cli-'));
    try
    {
        const artifactFile = path.join(directory, 'vitest-observations.json');
        const store = path.join(directory, 'history');
        const cli = path.join(repositoryRoot, 'tools/test-observations/cli.mjs');
        const run = (arguments_) => spawnSync(process.execPath, [cli, ...arguments_], {
            cwd: repositoryRoot,
            encoding: 'utf8'
        });
        const adapted = run([
            'adapt',
            '--framework', 'vitest',
            '--input', 'tests/fixtures/test-observations/vitest.json',
            '--output', artifactFile,
            '--root', repositoryRoot,
            '--evidence-reference', 'tests/fixtures/test-observations/vitest.json',
            '--suite', 'frontend-unit',
            '--partition', 'fixture',
            '--source-commit', sourceState.commit,
            '--worktree-fingerprint', sourceState.worktreeFingerprint,
            '--closure-path', 'tests/fixtures/test-observations',
            '--closure-path', 'tools/test-observations',
            '--run-id', 'fixture-cli',
            '--runner-os', 'linux',
            '--runner-arch', 'x64',
            '--runner-runtime', 'node-v24',
            '--observed-at', '2026-07-23T00:00:00.000Z'
        ]);
        assert.equal(adapted.status, 0, adapted.stderr || adapted.stdout);
        assert.match(adapted.stdout, /observations=3/u);

        const ingested = run([
            'ingest',
            '--artifact', artifactFile,
            '--store', store,
            '--evidence-root', repositoryRoot
        ]);
        assert.equal(ingested.status, 0, ingested.stderr || ingested.stdout);

        const rebuilt = run([
            'rebuild',
            '--store', store,
            '--evidence-root', repositoryRoot
        ]);
        assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
        assert.match(rebuilt.stdout, /artifacts=1 observations=3 tests=3 coldStart=false/u);
        fs.rmSync(path.join(store, 'index.json'));
        const reconstructed = run([
            'rebuild',
            '--store', store,
            '--evidence-root', repositoryRoot
        ]);
        assert.equal(reconstructed.status, 0, reconstructed.stderr || reconstructed.stdout);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
