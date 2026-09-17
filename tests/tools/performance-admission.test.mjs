import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { wrapTaskScopedMeasurementCommand } = await import(new URL("../../tools/test/bundles/measurement-step-command.mjs", import.meta.url));
const { bindMeasurementNoiseAuthority, createLinuxMeasurementCollector, evaluateMeasurementObservation, readMeasurementNoiseAuthoritySequence, readMeasurementNoisePolicy, validateMeasurementNoiseReceipt } = await import(new URL("../../tools/test/measurement-noise-envelope.mjs", import.meta.url));
const { collectMeasurementQualificationRequests, finalizeMeasurementQualificationRequests, measurementQualificationRequestEnvironment, registerOrFinalizeMeasurementProduct } = await import(new URL("../../tools/test/measurement-product-conclusion.mjs", import.meta.url));
const { measurementEnvelopeOwnerEnvironment, runWithPerformanceAdmission } = await import(new URL("../../tools/test/performance-admission.mjs", import.meta.url));
const { nativeP99SourceContractErrors, nativeP99TestId, validateNativeP99Bindings, validateNativeP99Evidence } = await import(new URL("../../tools/test/native-p99-producer-contract.mjs", import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskFixture = path.join(root, 'tests/tools/fixtures/measurement-task.mjs');
const qualificationPolicy = readMeasurementNoisePolicy();

function waitForChild(child)
{
    return new Promise((resolve, reject) =>
    {
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) =>
        {
            stdout += chunk;
        });
        child.stderr?.on('data', (chunk) =>
        {
            stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}

function cleanMeasurementRecord()
{
    const metrics = Object.fromEntries(
        Object.entries(qualificationPolicy.metrics).map(([name, declaration]) => [
            name,
      Number.isFinite(declaration.minimum) ? declaration.minimum : 0
        ])
    );
    return {
        observation: { durationMs: 1000, metrics },
        evaluation: evaluateMeasurementObservation({ metrics }, qualificationPolicy)
    };
}

function measurementReceipt(bindings, { noisy = false } = {})
{
    const record = cleanMeasurementRecord();
    const document = noisy
        ? {
        schema: 'fsusblog.measurement-noise-envelope.v1',
        windowId: 'outer/measurement-window',
        status: 'noisy',
        classification: 'infra.noisy-measurement-window',
        qualificationEligible: false,
        productConclusionEligible: false,
        productOutcome: null,
        timing: {
          admissionWaitMs: 1,
          measurementDurationMs: 1000,
          measurementStartedAfterAdmission: true
        },
        phases: {
          preflight: { status: 'clean', attempts: [structuredClone(record)] },
          during: {
            status: 'noisy',
            observations: [structuredClone(record)],
            firstNoisyObservation: {
              collectorError: 'fixture pressure',
              evaluation: {
                status: 'noisy',
                qualificationEligible: false,
                classification: 'infra.noisy-measurement-window'
              }
            }
          },
          post: structuredClone(record)
        }
      }
        : {
        schema: 'fsusblog.measurement-noise-envelope.v1',
        windowId: 'outer/measurement-window',
        status: 'clean',
        classification: null,
        qualificationEligible: true,
        productConclusionEligible: true,
        productOutcome: {
          status: 'completed',
          exitCode: 0,
          qualificationRequests: bindings.map(({ request, productEvidence }) => ({
            requestId: request.requestId,
            kind: request.kind,
            productEvidence
          }))
        },
        timing: {
          admissionWaitMs: 1,
          measurementDurationMs: 1000,
          measurementStartedAfterAdmission: true
        },
        phases: {
          preflight: { status: 'clean', attempts: [structuredClone(record)] },
          during: {
            status: 'clean',
            observations: [structuredClone(record)],
            firstNoisyObservation: null
          },
          post: structuredClone(record)
        }
      };
    return bindMeasurementNoiseAuthority(document, {
        runId: 'outer-run',
        attemptId: 'outer-run:attempt-1',
        attemptSequence: 1
    });
}

test('single outer owner envelopes nested performance execution exactly once', async () =>
{
    let envelopeCount = 0;
    let outerOwner;
    const delegationFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-admission-owner-')), 'nested.json');
    const envelopeFactory = () =>
    {
        envelopeCount += 1;
        return {
            async preflight()
            {
                return { admissionWaitMs: 0, attempts: [] };
            },
            start()
            {},
            async finish()
            {
                return { status: 'clean', qualificationEligible: true, productConclusionEligible: true };
            }
        };
    };
    await runWithPerformanceAdmission({
        windowId: 'outer-window',
        envelopeFactory,
        execute: async (outerEnv) =>
        {
            outerOwner = outerEnv[measurementEnvelopeOwnerEnvironment];
            const nested = await runWithPerformanceAdmission({
                windowId: 'nested-window',
                evidenceFile: delegationFile,
                env: outerEnv,
                envelopeFactory,
                execute: async (nestedEnv) => nestedEnv[measurementEnvelopeOwnerEnvironment]
            });
            assert.equal(nested.nested, true);
            assert.equal(nested.result, outerOwner);
        }
    });
    assert.equal(envelopeCount, 1);
    assert.match(outerOwner, /^outer-window:\d+$/u);
    const delegation = JSON.parse(fs.readFileSync(delegationFile, 'utf8'));
    assert.equal(delegation.collectorStarted, false);
    assert.equal(delegation.owner, outerOwner);
});

test('noisy envelope suppresses product conclusion even when command succeeds', async () =>
{
    await assert.rejects(runWithPerformanceAdmission({
        windowId: 'noisy-window',
        envelopeFactory: () => ({
            async preflight()
            {
                return { admissionWaitMs: 0, attempts: [] };
            },
            start()
            {},
            async finish()
            {
                return {
                    status: 'noisy',
                    classification: 'infra.noisy-measurement-window',
                    qualificationEligible: false,
                    productConclusionEligible: false,
                    productOutcome: null
                };
            }
        }),
        execute: async () => ({ status: 'faster' })
    }), (error) =>
    {
        assert.equal(error.classification, 'infra.noisy-measurement-window');
        assert.equal(error.evidence.productOutcome, null);
        return true;
    });
});

test('nested load and resource consumers publish only after the outer authority is semantically clean', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-qualified-products-'));
    try
    {
        const requestDirectory = path.join(directory, 'requests');
        const owner = 'outer/measurement-window:owner';
        const environment = {
            ...process.env,
            [measurementEnvelopeOwnerEnvironment]: owner,
            [measurementQualificationRequestEnvironment]: requestDirectory
        };
        const loadProduct = path.join(directory, 'load-product.json');
        const loadOutput = path.join(directory, 'load-release.json');
        const resourceProduct = path.join(directory, 'resource-product.json');
        const resourceOutput = path.join(directory, 'resource-release.json');
        fs.writeFileSync(loadProduct, `${JSON.stringify({
            status: 'ok',
            metrics: [{ name: 'rps', value: 100 }],
            thresholdEvaluation: { status: 'ok' },
            sampling: { totalRequests: 60 },
            runtime: { sampleCount: 60, routeIds: ['/api/binary/articles'] }
        })}\n`);
        fs.writeFileSync(resourceProduct, `${JSON.stringify({
            status: 'ok',
            metrics: [{ name: 'rss', delta: 1 }],
            unavailableMetrics: [],
            thresholdEvaluation: { status: 'ok' },
            runtime: { sampleCount: 3, rps: 10, latencyMs: 2 }
        })}\n`);
        fs.writeFileSync(loadOutput, '{"status":"stale-product-pass"}\n');
        fs.writeFileSync(resourceOutput, '{"status":"stale-product-pass"}\n');

        registerOrFinalizeMeasurementProduct({
            kind: 'load-profile',
            windowId: 'load-profile-baseline',
            evidenceFile: path.join(directory, 'delegated-load.json'),
            productFile: loadProduct,
            outputFile: loadOutput,
            profile: 'baseline',
            env: environment
        });
        registerOrFinalizeMeasurementProduct({
            kind: 'release-resource-budget',
            windowId: 'release-resource-budget-memory-leak',
            evidenceFile: path.join(directory, 'delegated-resource.json'),
            productFile: resourceProduct,
            outputFile: resourceOutput,
            mode: 'memory-leak',
            env: environment
        });
        assert.equal(fs.existsSync(loadOutput), false);
        assert.equal(fs.existsSync(resourceOutput), false);

        const bindings = collectMeasurementQualificationRequests(requestDirectory, owner);
        const authority = measurementReceipt(bindings);
        assert.throws(
            () => finalizeMeasurementQualificationRequests(bindings, authority),
            /authority sequence is empty/u
        );
        finalizeMeasurementQualificationRequests(bindings, authority, {
            authoritySequence: [authority]
        });
        const loadConclusion = JSON.parse(fs.readFileSync(loadOutput, 'utf8'));
        const resourceConclusion = JSON.parse(fs.readFileSync(resourceOutput, 'utf8'));
        assert.equal(loadConclusion.status, 'ok');
        assert.equal(loadConclusion.schema, 'fsusblog.qualified-load-profile-summary.v1');
        assert.equal(loadConclusion.qualificationEligible, true);
        assert.deepEqual(loadConclusion.measurementNoiseAuthoritySequence, [authority]);
        assert.deepEqual(loadConclusion.metrics, [{ name: 'rps', value: 100 }]);
        assert.deepEqual(loadConclusion.sampling, { totalRequests: 60 });
        assert.deepEqual(loadConclusion.runtime, {
            sampleCount: 60,
            routeIds: ['/api/binary/articles']
        });
        assert.equal(resourceConclusion.status, 'ok');
        assert.equal(
            resourceConclusion.schema,
            'fsusblog.qualified-release-resource-budget-summary.v1'
        );
        assert.equal(resourceConclusion.productConclusionEligible, true);
        assert.deepEqual(resourceConclusion.metrics, [{ name: 'rss', delta: 1 }]);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('noisy outer authority and a clean retry cannot publish product-pass evidence', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-noisy-products-'));
    try
    {
        const requestDirectory = path.join(directory, 'requests');
        const owner = 'outer/measurement-window:owner';
        const environment = {
            ...process.env,
            [measurementEnvelopeOwnerEnvironment]: owner,
            [measurementQualificationRequestEnvironment]: requestDirectory
        };
        const cases = [
            {
                kind: 'load-profile',
                profile: 'baseline',
                productFile: path.join(directory, 'load.json'),
                outputFile: path.join(directory, 'load-release.json')
            },
            {
                kind: 'release-resource-budget',
                mode: 'open-handle',
                productFile: path.join(directory, 'resource.json'),
                outputFile: path.join(directory, 'resource-release.json')
            }
        ];
        for (const candidate of cases)
        {
            fs.writeFileSync(
                candidate.productFile,
                '{"status":"ok","metrics":[{"name":"forged-pass"}]}\n'
            );
            registerOrFinalizeMeasurementProduct({
                ...candidate,
                windowId: `${candidate.kind}-window`,
                evidenceFile: path.join(directory, `${candidate.kind}.delegated.json`),
                env: environment
            });
        }
        const bindings = collectMeasurementQualificationRequests(requestDirectory, owner);
        const noisyAuthority = measurementReceipt(bindings, { noisy: true });
        finalizeMeasurementQualificationRequests(bindings, noisyAuthority, {
            authoritySequence: [noisyAuthority]
        });
        for (const candidate of cases)
        {
            const conclusion = JSON.parse(fs.readFileSync(candidate.outputFile, 'utf8'));
            assert.equal(conclusion.status, 'infra-no-conclusion');
            assert.equal(conclusion.productConclusionEligible, false);
            assert.equal(Object.hasOwn(conclusion, 'metrics'), false);
            assert.equal(Object.hasOwn(conclusion, 'thresholdEvaluation'), false);
        }
        const cleanRetryDocument = measurementReceipt(bindings);
        delete cleanRetryDocument.authority;
        const cleanRetry = bindMeasurementNoiseAuthority(cleanRetryDocument, {
            runId: noisyAuthority.authority.runId,
            attemptId: 'outer-run:attempt-2',
            attemptSequence: 2,
            previousReceiptDigest: noisyAuthority.authority.contentDigest
        });
        assert.throws(
            () => finalizeMeasurementQualificationRequests(bindings, cleanRetry, {
                authoritySequence: [noisyAuthority, cleanRetry]
            }),
            /cannot replace the first attempt with a retry/u
        );
        for (const candidate of cases)
        {
            assert.equal(
                JSON.parse(fs.readFileSync(candidate.outputFile, 'utf8')).status,
                'infra-no-conclusion'
            );
        }
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('Production physical measurement command kills the shared-runner cgroup path and executes in one task owner', async (t) =>
{
    if (process.platform !== 'linux')
    {
        return t.skip('Linux systemd task contract');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-bundle-task-owner-'));
    const evidenceFile = path.join(directory, 'measurement-noise.json');
    const authorityRoot = path.join(directory, 'authority');
    const productFile = path.join(directory, 'product.json');
    const policyFile = path.join(directory, 'policy.json');
    const policy = structuredClone(readMeasurementNoisePolicy());
    policy.preflightObservationMs = 50;
    policy.postObservationMs = 50;
    policy.sampleIntervalMs = 10;
    policy.admissionDeadlineMs = 200;
    for (const declaration of Object.values(policy.metrics))
    {
        if (declaration.qualification !== 'blocking')
        {
            continue;
        }
        if (declaration.maximum !== undefined)
        {
            declaration.maximum = Number.MAX_SAFE_INTEGER;
        }
        if (declaration.minimum !== undefined)
        {
            declaration.minimum = 0;
        }
    }
    policy.metrics.externalProcessIoEstimate = {
        qualification: 'diagnostic-only',
        unit: policy.metrics.externalProcessIoEstimate.unit
    };
    fs.writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
    const sharedSibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
    });
    t.after(() =>
    {
        if (sharedSibling.exitCode === null && sharedSibling.signalCode === null)
        {
            sharedSibling.kill('SIGKILL');
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(
        () => createLinuxMeasurementCollector({ rootPid: sharedSibling.pid }).collect(),
        /current-run cgroup is shared or incomplete/u
    );

    const wrapped = wrapTaskScopedMeasurementCommand({
        windowId: 'fixture-run/performance-evidence/fixture-step',
        evidenceFile,
        command: [process.execPath, taskFixture, 'cgroup-proof', productFile],
        runId: 'fixture-run',
        attemptSequence: 1,
        authorityRoot,
        policyFile
    });
    const execution = await waitForChild(spawn(wrapped.executable, wrapped.args, {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
    }));
    const failureEvidence = fs.existsSync(evidenceFile)
        ? fs.readFileSync(evidenceFile, 'utf8')
        : 'measurement evidence missing';
    assert.equal(execution.code, 0, `${execution.stderr}\n${failureEvidence}`);
    assert.equal(execution.signal, null);
    const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
    const sharedCgroup = fs.readFileSync(`/proc/${sharedSibling.pid}/cgroup`, 'utf8').trim();
    assert.notEqual(product.cgroup, sharedCgroup);
    assert.match(product.owner, /^fixture-run\/performance-evidence\/fixture-step:/u);
    const sequence = readMeasurementNoiseAuthoritySequence(evidenceFile, {
        authorityRoot,
        expectedRunId: 'fixture-run',
        expectedWindowId: 'fixture-run/performance-evidence/fixture-step',
        policy
    });
    assert.ok(sequence.length >= 2);
    validateMeasurementNoiseReceipt(sequence.at(-1), {
        expectedWindowId: 'fixture-run/performance-evidence/fixture-step',
        policy
    });
});

test('Production measurement steps own the envelope and direct lane wrappers inherit it', () =>
{
    const bundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.match(bundleRunner, /step\.evidencePhase === 'measurement'/u);
    assert.match(bundleRunner, /wrapTaskScopedMeasurementCommand\(\{/u);
    assert.match(bundleRunner, /readMeasurementNoiseAuthoritySequence\(measurementEvidenceFile/u);
    assert.match(bundleRunner, /measurementAuthorityRootFor\(step\.id\)/u);
    assert.match(bundleRunner, /measurementAuthorityManifestRootFor\(step\.id\)/u);
    assert.match(bundleRunner, /priorMeasurementAuthorityRootsFor\(step\.id\)/u);
    assert.doesNotMatch(bundleRunner, /runOutputRoot,\s*'measurement-noise-authority'/u);
    assert.doesNotMatch(bundleRunner, /\.filter\(\(candidate\) => fs\.existsSync\(candidate\)\)/u);
    assert.doesNotMatch(bundleRunner, /createMeasurementNoiseEnvelope\(\{/u);
    assert.doesNotMatch(bundleRunner, /FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER/u);

    for (const file of [
        'tools/test/lanes/load-profile.sh',
        'tools/test/lanes/soak.sh',
        'tools/test/lanes/backend-benchmark-regression.sh',
        'tools/test/lanes/aeds-frame-cost.sh',
        'tools/test/lanes/aeds-compression-profile.sh',
        'tools/test/lanes/public-hot-read-residency-profile.sh',
        'tools/test/lanes/release-resource-budget.sh',
        'tools/test/lanes/perf-regression.sh'
    ])
    {
        assert.match(
            fs.readFileSync(path.join(root, file), 'utf8'),
            /performance-admission\.mjs/u,
            `${file} must enter the sole performance admission owner`
        );
    }

    for (const file of [
        'tools/test/lanes/load-profile.sh',
        'tools/test/lanes/release-resource-budget.sh'
    ])
    {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.match(source, /--product-evidence/u);
        assert.match(source, /measurement-product-conclusion\.mjs/u);
        assert.doesNotMatch(source, /\bjq\s+-n\b/u);
        assert.ok(
            source.indexOf('measurement-product-conclusion.mjs') > source.indexOf('probe_status=$?'),
            `${file} must publish only after performance admission reaches a terminal receipt`
        );
    }
});

function validNativeP99Measurement()
{
    return {
        schema: 'fsusblog.native-groth16-p99-measurement.v1',
        status: 'passed',
        testId: nativeP99TestId,
        warmupCount: 1,
        sampleCount: 32,
        thresholdMs: 50,
        p99Ms: 32,
        samples: Array.from({ length: 32 }, (_, index) => ({ index, elapsedMs: index + 1, verified: true })),
        testAssembly: { sha256: 'assembly-a' }
    };
}

test('native P99 evidence requires 32 verified measurements and the unchanged 50ms budget', () =>
{
    const valid = validNativeP99Measurement();
    assert.deepEqual(validateNativeP99Evidence(valid, { testAssemblySha256: 'assembly-a' }), []);

    const partial = structuredClone(valid);
    partial.samples.length = 31;
    partial.sampleCount = 31;
    assert.match(validateNativeP99Evidence(partial).join('\n'), /exactly 32 samples/u);

    const unverified = structuredClone(valid);
    unverified.samples[7].verified = false;
    assert.match(validateNativeP99Evidence(unverified).join('\n'), /every native P99 sample/u);

    const overBudget = structuredClone(valid);
    overBudget.samples[31].elapsedMs = 51;
    overBudget.p99Ms = 51;
    assert.match(validateNativeP99Evidence(overBudget).join('\n'), /exceeds 50ms/u);

    const emptyPass = structuredClone(valid);
    emptyPass.samples = [];
    emptyPass.sampleCount = 0;
    assert.match(validateNativeP99Evidence(emptyPass).join('\n'), /exactly 32 samples/u);

    assert.match(
        validateNativeP99Evidence(valid, { testAssemblySha256: 'assembly-b' }).join('\n'),
        /assembly identity/u
    );
});

test('native P99 preflight fails closed on build, MCL, fixture, source, or isolation drift', () =>
{
    const files = new Map([
        ['/assembly', 'assembly-a'],
        ['/managed-mcl', 'managed-a'],
        ['/native-mcl', 'native-a'],
        ['/fixture', 'fixture-a']
    ]);
    const preflight = {
        schema: 'fsusblog.native-groth16-p99-preflight.v1',
        status: 'ready',
        source: { commit: 'a'.repeat(40), digest: 'b'.repeat(64) },
        build: { testAssembly: { path: '/assembly', sha256: 'assembly-a' } },
        nativeMcl: {
            managed: { path: '/managed-mcl', sha256: 'managed-a' },
            native: { path: '/native-mcl', sha256: 'native-a' }
        },
        verifyingKeyFixture: { sourcePath: '/fixture', sourceSha256: 'fixture-a' },
        isolation: { measurementEnvelopeOwner: 'local-simulated-owner', exclusiveResource: 'benchmark-window' }
    };
    const options = { exists: (file) => files.has(file), digest: (file) => files.get(file) };
    assert.deepEqual(validateNativeP99Bindings(preflight, options), []);

    files.delete('/native-mcl');
    assert.match(validateNativeP99Bindings(preflight, options).join('\n'), /native MCL library binding is missing/u);
    files.set('/native-mcl', 'native-a');
    files.set('/fixture', 'fixture-drift');
    assert.match(validateNativeP99Bindings(preflight, options).join('\n'), /verifying-key fixture identity drifted/u);
    files.set('/fixture', 'fixture-a');
    assert.match(
        validateNativeP99Bindings({ ...preflight, source: {} }, options).join('\n'),
        /source identity is missing/u
    );
    assert.match(
        validateNativeP99Bindings({ ...preflight, isolation: {} }, options).join('\n'),
        /measurement isolation identity is missing/u
    );
});

test('native P99 member stays exact-one, ordinary-excluded, atomic, and measurement-isolated', () =>
{
    const sources = {
        testSource: '[Trait("Category", "Performance")]\nprivate const int NativeP99SampleCount = 32;\nprivate const double NativeP99BudgetMilliseconds = 50;',
        suiteSource: `Category!=Performance\n${nativeP99TestId}`,
        atomicSource: 'export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release\nRunBackendPerfNativeP99Only backend-perf',
        matrixSource: '\n    - id: backend-perf\n      command: tools/test/lanes/perf-regression.sh\n      executionVariant: performance\n      exclusiveResources: [benchmark-window]\n      coverage: [native-groth16-p99]\n    - id: next',
        workflowSource: './tools/test.sh backend-perf --no-deps'
    };
    assert.deepEqual(nativeP99SourceContractErrors(sources), []);
    assert.match(
        nativeP99SourceContractErrors({ ...sources, testSource: `${sources.testSource}\n// FSUSBLOG_RUN_PERFORMANCE_TESTS` }).join('\n'),
        /still consumes/u
    );
    assert.match(
        nativeP99SourceContractErrors({ ...sources, suiteSource: sources.suiteSource.replace('Category!=Performance', 'Category=Performance') }).join('\n'),
        /ordinary backend filter/u
    );
    assert.match(
        nativeP99SourceContractErrors({ ...sources, suiteSource: `${sources.suiteSource}\n# ${nativeP99TestId}` }).join('\n'),
        /exactly one suite member/u
    );
    assert.match(
        nativeP99SourceContractErrors({ ...sources, suiteSource: `${sources.suiteSource}\nRunBackendPerfOnly() { :; }` }).join('\n'),
        /legacy RunBackendPerfOnly/u
    );
    assert.match(
        nativeP99SourceContractErrors({
            ...sources,
            matrixSource: sources.matrixSource.replace(
                /(\n {4}- id: backend-perf\n[\s\S]*?)exclusiveResources: \[benchmark-window\]/u,
                '$1exclusiveResources: []'
            )
        }).join('\n'),
        /benchmark window/u
    );
    assert.match(
        nativeP99SourceContractErrors({ ...sources, workflowSource: '' }).join('\n'),
        /CI must invoke/u
    );
});
