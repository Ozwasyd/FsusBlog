import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { digestCanonical, retryPolicyById, sealContentDigest, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { readOutcomeFailureTaxonomy } = await import(new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url));
const { adaptBackendTestSemanticOutcome, backendCaseCatalogSchema } = await import(new URL('../../tools/test-matrix/outcomes/backend-test-adapter.mjs', import.meta.url));
const { buildBackendFrameworkObservationFromXunit, createBackendHeldEvidenceBridge } = await import(new URL('../../tools/test-matrix/outcomes/backend-held-evidence-bridge.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
let nativeMaterial;

function read(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(file, document)
{
    fs.writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
}

function probe()
{
    if (nativeMaterial)
    {
        return nativeMaterial;
    }
    const dotnet = process.env.FSUSBLOG_BACKEND_DOTNET;
    assert.ok(dotnet && fs.existsSync(dotnet), 'native bridge controls require FSUSBLOG_BACKEND_DOTNET; absence is unrun, not a skip/pass');
    const sdkVersion = spawnSync(dotnet, ['--version'], { encoding: 'utf8' });
    assert.equal(sdkVersion.status, 0);
    const runner = path.join(root, 'tools/test/xunit-replay-adapter.mjs');
    const assembly = path.join(root, 'tests/tools/fixtures/backend-outcome-reporter/bin/Release/net10.0/FsusBlog.BackendOutcomeReporterFixture.dll');
    assert.ok(fs.existsSync(assembly), 'build the locked native reporter fixture before running this suite');
    const directory = fs.mkdtempSync(path.join(root, '.tmp/backend-native-bridge-'));
    const observationsDirectory = path.join(directory, 'assertions');
    fs.mkdirSync(observationsDirectory, { mode: 0o700 });
    const context = { buildIdentity: sha256(fs.readFileSync(assembly)), toolchainDigest: sha256(fs.readFileSync(dotnet)),
        executionEnvelopeDigest: digestCanonical({ scope: 'unqualified-native-probe', executable: dotnet, sdkVersion: sdkVersion.stdout.trim() }),
        temporalContextDigest: digestCanonical({ scope: 'unqualified-native-probe', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) };
    const args = [runner, '--assembly', path.relative(root, assembly), '--output-dir', path.relative(root, directory),
        '--root-seed', `seed256:${'17'.repeat(32)}`, '--workers', '1', '--run-id', path.basename(directory), '--producer', 'backend-native-probe'];
    const startedAt = new Date().toISOString();
    const mask = process.umask(0o077);
    let result;
    try
    {
        result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000,
            env: { ...process.env, PATH: `${path.dirname(dotnet)}:${process.env.PATH}`,
                DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
                FSUSBLOG_BACKEND_ASSERTION_OBSERVATIONS: observationsDirectory,
                FSUSBLOG_BACKEND_REPLAY_MATERIAL: directory, FSUSBLOG_BACKEND_OUTCOME_CONTEXT: JSON.stringify(context) } });
    }
    finally
    {
        process.umask(mask);
    }
    const finishedAt = new Date().toISOString();
    write(path.join(directory, 'probe-process.json'), { executable: process.execPath, args, processId: result.pid,
        exitCode: result.status, signal: result.signal, startedAt, finishedAt, sdkVersion: sdkVersion.stdout.trim() });
    fs.writeFileSync(path.join(directory, 'stdout.log'), result.stdout ?? '', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'stderr.log'), result.stderr ?? '', { mode: 0o600 });
    assert.equal(result.status, 1, `controlled native Assert.Equal failure must remain exit1: ${result.stderr}`);
    assert.equal(result.signal, null);
    const plan = read(path.join(directory, 'plan.json'));
    const manifest = read(path.join(directory, 'queue-manifest.json'));
    const actual = read(path.join(directory, 'actual/framework-actual.json'));
    assert.equal(actual.qualificationEligible, false);
    const nativeOutcomes = actual.workers.flatMap((worker) => worker.outcomes);
    assert.equal(nativeOutcomes.filter((entry) => entry.outcome === 'passed').length, 2);
    assert.equal(nativeOutcomes.filter((entry) => entry.outcome === 'failed').length, 1);
    const identity = { ...context, producerId: plan.producer.id, schedulerRunId: plan.run.id,
        sourceCommit: plan.source.commit, worktreeFingerprint: plan.source.worktreeFingerprint, replayPlanDigest: plan.planDigest };
    const queued = manifest.slots.flatMap((slot) => slot.collections.flatMap((collection) => collection.tests));
    const policy = retryPolicyById('correctness-first-attempt');
    const catalog = sealContentDigest({ schema: backendCaseCatalogSchema, identity,
        policyDigests: { retryPolicyDigest: digestCanonical(policy), failureTaxonomyDigest: digestCanonical([...readOutcomeFailureTaxonomy().values()]),
            projectionPolicyDigest: null }, tests: queued.map((entry) => ({ testId: entry.canonicalTestId,
            caseBinding: { kind: entry.canonicalTestId.includes('?case=parameterized:') ? 'parameterized' : 'fact', id: entry.testCaseUniqueId },
            assertionIds: ['assert:equal'], coverageIds: [], artifactIds: [], stateIds: [] })) });
    const reference = (id, relative) => ({ id, path: relative, digest: sha256(fs.readFileSync(path.join(directory, relative))) });
    const queueManifestReference = reference('native-queue', 'queue-manifest.json');
    const slotExecutionReferences = actual.workers.map((worker) => ({ slotId: worker.slotId, processId: worker.processId,
        exitCode: worker.exitCode, signal: worker.signal, reference: reference(`slot:${worker.slotId}`, `actual/slots/${worker.slotId}.json`) }));
    const assertionObservationReferences = fs.readdirSync(observationsDirectory).sort().map((file) =>
        reference(`assertion:${file.slice(0, -5)}`, `assertions/${file}`));
    const rawReferences = [queueManifestReference, ...slotExecutionReferences.map((entry) => entry.reference), ...assertionObservationReferences];
    const artifactDigests = Object.fromEntries([...rawReferences.map((entry) => [entry.path, entry.digest]),
        ['stdout.log', sha256(fs.readFileSync(path.join(directory, 'stdout.log')))],
        ['stderr.log', sha256(fs.readFileSync(path.join(directory, 'stderr.log')))] ]);
    const outcomes = actual.workers.flatMap((worker) => worker.outcomes);
    const attempt = sealContentDigest({ schema: 'fsusblog.test-attempt-receipt.v1', producerId: identity.producerId,
        attemptNumber: 1, maxAttempts: 1, sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint,
        schedulerRunId: identity.schedulerRunId, command: [process.execPath, ...args], commandDigest: digestCanonical([process.execPath, ...args]),
        executionEnvelopeDigest: identity.executionEnvelopeDigest, replayPlanDigest: plan.planDigest, temporalContextDigest: identity.temporalContextDigest,
        authorityReferences: [], startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        exitCode: result.status, signal: result.signal, failureClass: 'product', failureKind: 'product.assertion',
        executedTestIds: outcomes.filter((entry) => ['passed', 'failed'].includes(entry.outcome)).map((entry) => entry.canonicalTestId).sort(),
        failedTestIds: outcomes.filter((entry) => entry.outcome === 'failed').map((entry) => entry.canonicalTestId).sort(),
        stdoutPath: 'stdout.log', stderrPath: 'stderr.log', artifactPaths: Object.keys(artifactDigests).sort(), artifactDigests,
        firstFailure: true, retryDecision: 'policy-denied', retryPolicyId: policy.id, status: 'failed-no-retry' });
    const aggregateAttempt = sealContentDigest({ schema: 'fsusblog.test-attempt-aggregate-receipt.v1', producerId: identity.producerId,
        schedulerRunId: identity.schedulerRunId, sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint,
        retryPolicyId: policy.id, attempts: [{ attemptNumber: 1, path: 'attempt.json', digest: attempt.contentDigest }],
        firstAttemptStatus: attempt.status, finalAttemptStatus: attempt.status, finalClassification: attempt.status,
        cleanFirstAttempt: false, qualificationEligible: false });
    const buildInputs = { identity, plan, catalog, attempt, queueManifest: manifest,
        slotExecutions: slotExecutionReferences.map((execution) => ({ ...execution, receipt: read(path.join(directory, execution.reference.path)) })),
        assertionObservations: assertionObservationReferences.map((reference) => ({ reference, document: read(path.join(directory, reference.path)) })),
        evidenceRefs: rawReferences, artifactSemanticDigests: {}, stateSemanticDigests: {} };
    const report = buildBackendFrameworkObservationFromXunit(buildInputs);
    for (const [file, document] of [['catalog.json', catalog], ['report.json', report], ['attempt.json', attempt], ['aggregate.json', aggregateAttempt]])
    {
        write(path.join(directory, file), document);
    }
    const inputAuthorityRefs = [['replay-plan', 'plan.json', plan.planDigest], ['backend-catalog', 'catalog.json', catalog.contentDigest],
        ['backend-report', 'report.json', report.contentDigest], ['attempt', 'attempt.json', attempt.contentDigest],
        ['aggregate-attempt', 'aggregate.json', aggregateAttempt.contentDigest]].map(([kind, path, digest]) => ({ kind, path, digest }));
    const options = { evidenceRoot: directory, expectedIdentity: identity, inputAuthorityRefs, queueManifestReference,
        slotExecutionReferences, assertionObservationReferences, artifactSemanticReferences: [], stateSemanticReferences: [],
        verificationReceiptPath: 'held-verification.json', maximumBytes: 16 * 1024 * 1024 };
    nativeMaterial = { directory, identity, plan, catalog, report, attempt, aggregateAttempt, inputAuthorityRefs, buildInputs, options };
    return nativeMaterial;
}

test('actual original xUnit reporter joins native theory rows and a real assertion failure', () =>
{
    const material = probe();
    assert.equal(material.report.tests.length, 3);
    assert.equal(material.report.tests.filter((entry) => entry.status === 'passed').length, 2);
    assert.equal(material.report.tests.filter((entry) => entry.status === 'failed').length, 1);
    const failure = material.report.tests.find((entry) => entry.status === 'failed').assertions[0].failure;
    assert.equal(failure.kind, 'product.assertion');
    const bridge = createBackendHeldEvidenceBridge(material.options);
    const verification = bridge.verifyBackendEvidence({ identity: material.identity, inputAuthorityRefs: material.inputAuthorityRefs });
    assert.equal(verification.verified, true);
    assert.equal(read(path.join(material.directory, 'held-verification.json')).qualificationGranted, false);
    assert.throws(() => adaptBackendTestSemanticOutcome({ ...material, ...bridge }), /external authority verifier|external authority references/u);
});

test('native missing duplicate foreign case collection process and terminal material is refused', () =>
{
    const { buildInputs } = probe();
    const changes = [
        (v) =>
        {
            v.assertionObservations.pop();
        },
        (v) =>
        {
            v.assertionObservations.push(structuredClone(v.assertionObservations[0]));
        },
        (v) =>
        {
            v.slotExecutions[0].receipt.outcomes[0].testCaseUniqueId = 'foreign';
        },
        (v) =>
        {
            v.slotExecutions[0].receipt.outcomes[0].testCollectionUniqueId = 'foreign';
        },
        (v) =>
        {
            v.slotExecutions[0].processId += 1;
        },
        (v) =>
        {
            v.slotExecutions[0].receipt.outcomes[0].outcome = 'not-run';
        },
        (v) =>
        {
            v.slotExecutions[0].signal = 'SIGKILL';
        },
        (v) =>
        {
            v.slotExecutions[0].receipt.starts.pop();
        },
        (v) =>
        {
            v.assertionObservations[0].document.identity.schedulerRunId = 'foreign';
        },
        (v) =>
        {
            v.assertionObservations[0].document.cases[0].caseId = 'foreign';
        },
        (v) =>
        {
            v.assertionObservations[0].document.assertions[0].caseId = 'foreign';
        },
        (v) =>
        {
            v.assertionObservations[0].document.assertions[0].id = 'foreign';
        },
        (v) =>
        {
            v.assertionObservations[0].document.assertions.push(structuredClone(v.assertionObservations[0].document.assertions[0]));
        },
        (v) =>
        {
            v.assertionObservations[0].document.coverageIds = ['foreign'];
        },
        (v) =>
        {
            v.assertionObservations.find((entry) => entry.document.assertions[0].failure).document.assertions[0].failure.identity.testId = 'foreign';
        },
        (v) =>
        {
            v.assertionObservations.find((entry) => entry.document.assertions[0].failure).document.assertions[0].failure.kind = 'product.guessed';
        }
    ];
    for (const change of changes)
    {
        const mutated = structuredClone(buildInputs);
        change(mutated);
        assert.throws(() => buildBackendFrameworkObservationFromXunit(mutated));
    }
});

test('held verification rejects resealed report edits and independent reference replacements', () =>
{
    const material = probe();
    const bridge = createBackendHeldEvidenceBridge(material.options);
    const request = { identity: material.identity, inputAuthorityRefs: material.inputAuthorityRefs };
    const changedRefs = structuredClone(material.inputAuthorityRefs);
    changedRefs[0].path = 'another-plan.json';
    assert.throws(() => bridge.verifyBackendEvidence({ ...request, inputAuthorityRefs: changedRefs }));
    const reportFile = path.join(material.directory, 'report.json');
    const original = fs.readFileSync(reportFile);
    try
    {
        const report = structuredClone(material.report);
        report.tests[0].status = report.tests[0].status === 'failed' ? 'passed' : 'failed';
        write(reportFile, sealContentDigest(report));
        assert.throws(() => bridge.verifyBackendEvidence(request));
    }
    finally
    {
        fs.writeFileSync(reportFile, original);
    }
});

test('actual held files are rechecked for byte drift symlink and path escape on every call', () =>
{
    const material = probe();
    const bridge = createBackendHeldEvidenceBridge(material.options);
    const request = { identity: material.identity, inputAuthorityRefs: material.inputAuthorityRefs };
    const reference = material.options.assertionObservationReferences[0];
    const file = path.join(material.directory, reference.path);
    const original = fs.readFileSync(file);
    const saved = `${file}.saved`;
    try
    {
        fs.writeFileSync(file, '{}');
        assert.equal(bridge.verifyArtifact(reference.path, reference.digest), false);
        assert.throws(() => bridge.verifyBackendEvidence(request));
        fs.writeFileSync(file, original);
        fs.renameSync(file, saved);
        fs.symlinkSync(saved, file);
        assert.throws(() => bridge.verifyBackendEvidence(request));
        assert.equal(bridge.verifyArtifact('../foreign.json', reference.digest), false);
    }
    finally
    {
        if (fs.lstatSync(file).isSymbolicLink())
        {
            fs.unlinkSync(file);
            fs.renameSync(saved, file);
        }
        else
        {
            fs.writeFileSync(file, original);
        }
    }
    assert.equal(bridge.verifyBackendEvidence(request).verified, true);
});


test('held bridge applies explicit byte bounds before reading native or canonical material', () =>
{
    const material = probe();
    for (const maximumBytes of [undefined, 0, Infinity, 16 * 1024 * 1024 + 1])
    {
        assert.throws(() => createBackendHeldEvidenceBridge({ ...material.options, maximumBytes }));
    }
    const limited = createBackendHeldEvidenceBridge({ ...material.options, maximumBytes: 32 });
    const reference = material.options.queueManifestReference;
    assert.equal(limited.verifyArtifact(reference.path, reference.digest), false);
    assert.throws(() => limited.verifyBackendEvidence({ identity: material.identity,
        inputAuthorityRefs: material.inputAuthorityRefs }));
});
