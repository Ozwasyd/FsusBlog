import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    bindExecutionEnvelope,
    buildExecutionEnvelope,
    sealExecutionEnvelopeReceipt,
    verifyExecutionEnvelopeConsumerBindings,
    verifyExecutionEnvelopeReceipt
} from '../../tools/test/execution-envelope-receipt.mjs';
import {
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy,
    executionEnvelopeDigest,
    resolveExecutionEnvelopeProducer
} from '../../tools/test-matrix/execution-envelope-policy.mjs';
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs';
import { verifyExecutionEnvelopeFiles } from '../../tools/test/verify-execution-envelope.mjs';

const policy = loadExecutionEnvelopePolicy();
const catalog = loadExecutionEnvelopeApplicability();
const applicability = resolveExecutionEnvelopeProducer('backend-source-file-size', catalog);
const executable = {
    requestedName: 'node',
    absolutePath: '/managed/bin/node',
    realPath: '/managed/bin/node',
    version: 'v25.0.0',
    sha256: `sha256:${'1'.repeat(64)}`
};
const environment = {
    admission: 'planned-actual-exact',
    environment: {
        producerAllowlist: ['PATH'],
        variables: [
            {
                name: 'SECRET_TOKEN',
                present: true,
                type: 'string',
                sensitive: true,
                value: null,
                valueDigest: `sha256:${'2'.repeat(64)}`,
                notApplicableReason: null
            }
        ],
        pathEntries: [{ index: 0, absolutePath: '/managed/bin', realPath: '/managed/bin' }]
    },
    plannedExecutable: executable,
    actualExecutable: executable
};
const directories = {
    ownership: 'current-run-current-attempt',
    permissions: '0700',
    aliasAdmission: 'realpath-contained',
    directories: { home: '/run/home', temp: '/run/tmp' },
    externalRoots: { userHome: '/host/home', systemTemp: '/tmp' },
    externalWriteObservation: { enforcement: 'landlock-default-deny-write' },
    cleanup: { status: 'complete', removedOwnedRoot: true }
};
const network = {
    qualificationEligible: true,
    defaultPolicy: 'deny',
    sandbox: {
        observer: { ...executable, requestedName: 'strace' },
        networkNamespace: 'systemd-private-network-per-attempt',
        filesystem: {
            enforcement: 'landlock-default-deny-write',
            compiler: { ...executable, requestedName: 'cc', absolutePath: '/managed/bin/cc', realPath: '/managed/bin/cc' },
            helper: { ...executable, requestedName: 'landlock', absolutePath: '/run/landlock', realPath: '/run/landlock' }
        }
    },
    planned: { endpoints: [], dns: [], proxy: {}, certificates: {} },
    actual: { connections: [], dns: [], proxy: {}, certificates: {}, deniedAttempts: [] },
    admission: 'planned-actual-exact'
};
const hostFacts = {
    platform: 'linux',
    architecture: 'x64',
    kernel: 'Linux fixture',
    libc: 'glibc-2.40',
    cgroupLimits: { cpuMax: '100000 100000', memoryMax: '1073741824' },
    cpuModel: 'fixture-cpu',
    cpuCount: 4,
    memoryLimit: 1073741824,
    umask: '0022',
    filesystemCaseSensitivity: 'sensitive',
    fontSetDigest: `sha256:${'3'.repeat(64)}`,
    localeDataDigest: `sha256:${'4'.repeat(64)}`
};
const identity = {
    producerId: 'backend-source-file-size',
    schedulerRunId: 'run-a',
    attemptId: 'attempt-a',
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: `sha256:${'5'.repeat(64)}`,
    worktreeFingerprint: `sha256:${'6'.repeat(64)}`,
    workingDirectory: '/worktree'
};

function envelope(phase, overrides = {})
{
    return buildExecutionEnvelope({
        phase,
        identity,
        applicability,
        policy,
        catalog,
        environment,
        directories,
        network,
        hostFacts,
        ...overrides
    });
}

function resealEnvelope(value, mutate)
{
    const envelopeValue = structuredClone(value);
    mutate(envelopeValue);
    delete envelopeValue.envelopeDigest;
    envelopeValue.envelopeDigest = executionEnvelopeDigest(envelopeValue);
    return envelopeValue;
}

function browserFragment()
{
    const base = {
        executionClass: 'correctness',
        evidenceClass: 'browser-contract',
        qualificationEligible: true,
        managedExecutable: true,
        browserName: 'chromium',
        browserVersion: '147.0.0.0',
        revision: '1217',
        executablePath: '/managed/chromium-1217/chrome',
        executableSha256: `sha256:${'7'.repeat(64)}`,
        playwright: {
            package: '@playwright/test',
            version: '1.59.1',
            packageDigest: `sha256:${'8'.repeat(64)}`,
            browserCatalogDigest: `sha256:${'9'.repeat(64)}`
        },
        launchOptions: {
            headless: true,
            executablePath: '/managed/chromium-1217/chrome',
            args: ['--use-angle=swiftshader']
        },
        rendering: {
            fontSetDigest: `sha256:${'a'.repeat(64)}`,
            localeDataDigest: `sha256:${'b'.repeat(64)}`,
            locale: 'en-US',
            deviceScaleFactor: 1,
            renderingMode: 'headless',
            colorScheme: 'light',
            gpuMode: 'software'
        }
    };
    const planPayload = {
        schema: 'fsusblog.playwright-browser-identity.v1',
        ...base
    };
    const plan = { ...planPayload, contentDigest: executionEnvelopeDigest(planPayload) };
    const actualPayload = {
        schema: 'fsusblog.playwright-browser-actual.v1',
        ...base,
        planDigest: plan.contentDigest,
        renderingObservation: {
            locale: 'en-US',
            deviceScaleFactor: 1,
            colorScheme: 'light',
            renderer: 'SwiftShader'
        }
    };
    return {
        plan,
        actual: { ...actualPayload, contentDigest: executionEnvelopeDigest(actualPayload) }
    };
}

test('exact planned and actual envelope seals one independently verifiable receipt', () =>
{
    const plan = envelope('planned');
    const actual = envelope('actual');
    const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
    const binding = verifyExecutionEnvelopeReceipt(receipt);
    const schema = JSON.parse(fs.readFileSync(new URL(
        '../../config/schemas/test-execution-envelope-receipt.schema.json',
        import.meta.url
    ), 'utf8'));
    assert.deepEqual(validateJsonSchema(receipt, schema), []);
    assert.equal(binding.envelopeDigest, plan.envelopeDigest);
    assert.equal(receipt.verdict, 'pass');
    assert.equal(receipt.mismatchPaths.length, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /plaintext-secret-value/u);
    assert.equal(receipt.plan.notApplicableFields.browserName,
        applicability.fieldApplicability.browserRendering.notApplicableReason);
    assert.equal(receipt.plan.notApplicableFields.containerRuntime,
        applicability.fieldApplicability.services.notApplicableReason);
});

test('mismatch, fragment tamper, and cross-run splice fail with a location', () =>
{
    const plan = envelope('planned');
    for (const mutate of [
        (actual) => { actual.cpuCount = 8; },
        (actual) => { actual.fragmentDigests.network = `sha256:${'f'.repeat(64)}`; },
        (actual) => { actual.schedulerRunId = 'run-b'; }
    ])
    {
        const actual = structuredClone(envelope('actual'));
        mutate(actual);
        const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
        assert.equal(receipt.verdict, 'fail');
        assert.throws(() => verifyExecutionEnvelopeReceipt(receipt),
            /execution envelope/u);
        assert.ok(receipt.mismatchPaths.some((entry) => entry.startsWith('/')));
    }
});

test('required observer absence and diagnostic fragment injection fail closed', () =>
{
    const browserApplicability = structuredClone(applicability);
    browserApplicability.fieldApplicability.browserRendering = {
        status: 'required',
        observerId: 'browser-rendering-runtime',
        notApplicableReason: null
    };
    assert.throws(() => envelope('planned', { applicability: browserApplicability }),
        /required observer is missing/u);
    assert.throws(() => envelope('planned', {
        browser: {
            qualificationEligible: false,
            plan: {},
            actual: {},
            admission: 'planned-actual-exact'
        }
    }), /diagnostic fragment/u);
    assert.throws(() => envelope('planned', { browser: browserFragment() }),
        /not-applicable observer is present/u);
});

test('managed browser plan, actual binary, and rendering observation enter aggregate identity', () =>
{
    const browserApplicability = resolveExecutionEnvelopeProducer('browser-contract', catalog);
    const browserIdentity = { ...identity, producerId: browserApplicability.producerId };
    const browserEnvironment = {
        ...environment,
        environment: {
            ...environment.environment,
            producerAllowlist: browserApplicability.allowedEnvironment
        }
    };
    const browser = browserFragment();
    const plan = envelope('planned', {
        applicability: browserApplicability,
        identity: browserIdentity,
        environment: browserEnvironment,
        browser
    });
    const actual = envelope('actual', {
        applicability: browserApplicability,
        identity: browserIdentity,
        environment: browserEnvironment,
        browser
    });
    const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
    assert.equal(verifyExecutionEnvelopeReceipt(receipt).envelopeDigest,
        plan.envelopeDigest);
    assert.equal(plan.browserName, 'chromium');
    assert.equal(plan.gpuMode, 'software');
    assert.equal(plan.browserRenderingObservation.renderer, 'SwiftShader');
});

test('declared host facts affect identity while undeclared perturbation does not', () =>
{
    const baseline = envelope('planned');
    const undeclared = envelope('planned', {
        hostFacts: { ...hostFacts, ignoredAmbientHostValue: 'different' }
    });
    const declared = envelope('planned', {
        hostFacts: { ...hostFacts, cpuModel: 'different-cpu' }
    });
    assert.equal(undeclared.envelopeDigest, baseline.envelopeDigest);
    assert.notEqual(declared.envelopeDigest, baseline.envelopeDigest);
});

test('producer, replay, and release consumers must bind the same receipt identity', () =>
{
    const receipt = sealExecutionEnvelopeReceipt({
        plan: envelope('planned'),
        actual: envelope('actual')
    });
    const producerReceipt = bindExecutionEnvelope({ schema: 'producer' }, receipt);
    const replayPlan = bindExecutionEnvelope({ schema: 'replay' }, receipt);
    const releaseEvidence = bindExecutionEnvelope({ schema: 'release' }, receipt);
    assert.equal(verifyExecutionEnvelopeConsumerBindings({
        receipt,
        producerReceipt,
        replayPlan,
        releaseEvidence
    }), true);
    assert.throws(() => verifyExecutionEnvelopeConsumerBindings({
        receipt,
        producerReceipt,
        replayPlan: { ...replayPlan, executionEnvelopeDigest: `sha256:${'0'.repeat(64)}` },
        releaseEvidence
    }), /replay plan execution envelope binding mismatch/u);
});

test('unsupported schema and self-digest drift fail independently', () =>
{
    const receipt = structuredClone(sealExecutionEnvelopeReceipt({
        plan: envelope('planned'),
        actual: envelope('actual')
    }));
    receipt.plan.schema = 'fsusblog.test-execution-envelope.v0';
    assert.throws(() => verifyExecutionEnvelopeReceipt(receipt), /schema validation failed/u);
});

test('self-consistent receipts cannot omit a current schema field', () =>
{
    const plan = resealEnvelope(envelope('planned'), (value) =>
    {
        delete value.cpuCount;
    });
    const actual = resealEnvelope(envelope('actual'), (value) =>
    {
        delete value.cpuCount;
    });
    const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
    assert.equal(receipt.verdict, 'pass');
    assert.throws(() => verifyExecutionEnvelopeReceipt(receipt),
        /schema validation failed.*cpuCount/u);
});

test('reissued envelopes cannot replace the current policy, catalog, or schema identity', () =>
{
    for (const field of ['policyDigest', 'catalogDigest', 'schemaIdentity'])
    {
        const replacement = `sha256:${'0'.repeat(64)}`;
        const plan = resealEnvelope(envelope('planned'), (value) =>
        {
            value[field] = replacement;
        });
        const actual = resealEnvelope(envelope('actual'), (value) =>
        {
            value[field] = replacement;
        });
        const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
        assert.equal(receipt.verdict, 'pass');
        assert.throws(() => verifyExecutionEnvelopeReceipt(receipt),
            /current contract identity mismatch/u);
    }
});

test('reissued envelopes cannot omit a required structured fragment', () =>
{
    const plan = resealEnvelope(envelope('planned'), (value) =>
    {
        delete value.fragmentDigests.network;
    });
    const actual = resealEnvelope(envelope('actual'), (value) =>
    {
        delete value.fragmentDigests.network;
    });
    const receipt = sealExecutionEnvelopeReceipt({ plan, actual });
    assert.equal(receipt.verdict, 'pass');
    assert.throws(() => verifyExecutionEnvelopeReceipt(receipt),
        /fragment set is incomplete/u);
});

test('independent file verifier rejects a plan from another attempt', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-envelope-verifier-'));
    try
    {
        const receipt = sealExecutionEnvelopeReceipt({
            plan: envelope('planned'),
            actual: envelope('actual')
        });
        const planFile = path.join(directory, 'plan.json');
        const receiptFile = path.join(directory, 'receipt.json');
        fs.writeFileSync(planFile, JSON.stringify(receipt.plan));
        fs.writeFileSync(receiptFile, JSON.stringify(receipt));
        assert.equal(verifyExecutionEnvelopeFiles({ planFile, receiptFile }).attemptId,
            'attempt-a');
        const otherPlan = structuredClone(receipt.plan);
        otherPlan.attemptId = 'attempt-b';
        fs.writeFileSync(planFile, JSON.stringify(otherPlan));
        assert.throws(() => verifyExecutionEnvelopeFiles({ planFile, receiptFile }),
            /plan\/receipt binding failed/u);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
