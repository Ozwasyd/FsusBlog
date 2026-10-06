import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    assertReleaseFinalPostRuntimeCandidate,
    verifyReleaseFinalPostRuntimeAuthority
} = await import(new URL('../../tools/release/release-final-domain-evidence.mjs', import.meta.url));
const { sealBrowserContractReceipt } = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const { authorityDigest } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));

import { createBrowserTemporalFixture } from './support/browser-temporal-fixture.mjs';

const digest = (digit) => `sha256:${digit.repeat(64)}`;
const seal = (value) => ({ ...value, contentDigest: governanceContentDigest(value) });

function fixture()
{
    const currentRunContext = seal({
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'release-current', attemptId: 'attempt-current',
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'candidate', digest: digest('c') },
        buildIdentity: { id: 'context-build', digest: digest('d') },
        ownedRoots: ['.tmp/current-run']
    });
    const sourceState = { commit: currentRunContext.sourceCommit, worktreeFingerprint: 'b'.repeat(64) };
    const buildReceipt = { contentDigest: digest('e') };
    const plan = seal({
        schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness',
        evidenceClass: 'browser-contract', qualificationEligible: true, managedExecutable: true,
        browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
        executablePath: '/managed/chromium-123456/chrome', executableSha256: digest('f'),
        playwright: { package: '@playwright/test', version: '1.59.1' },
        launchOptions: { headless: true, executablePath: '/managed/chromium-123456/chrome', args: [] },
        rendering: { fontSetDigest: digest('1'), localeDataDigest: digest('2'), locale: 'zh-CN',
            deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software' }
    });
    const actual = seal({ ...plan, schema: 'fsusblog.playwright-browser-actual.v1',
        planDigest: plan.contentDigest, renderingObservation: {
            locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader fixture renderer'
        } });
    const browserContractReceipt = sealBrowserContractReceipt({
        schema: 'fsusblog.browser-contract-receipt.v2', status: 'success', classification: 'clean',
        sourceState, runIdentity: { runId: currentRunContext.schedulerRunId },
        temporalBinding: createBrowserTemporalFixture({ sourceState, runId: currentRunContext.schedulerRunId }),
        build: { receipt: '.tmp/current-run/build.json', receiptContentDigest: buildReceipt.contentDigest,
            sourceState, profile: 'production' }, fixture: { namespace: 'release-current' },
        playwright: { chromiumRevision: '123456', chromiumVersion: '140.0.0', browserIdentity: { plan, actual } },
        topology: { runner: 'playwright-library', browserType: 'chromium', managedBrowser: true,
            workerPool: false, shard: null, retries: 0, browserLaunchCount: 1,
            maxConcurrentBrowserRoots: 1, contextCount: 1 },
        scenarios: [{ id: 'public-route', status: 'success', classification: 'clean', issues: [], artifacts: [] }],
        publicPreview: {
            schema: 'fsusblog.public-preview-screenshot-verification.v1', status: 'ok',
            sourceCommit: sourceState.commit, releaseId: `20260718000000-${sourceState.commit.slice(0, 12)}`,
            manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1', visualInputDigest: 'c'.repeat(64),
            runtimeAudit: true, layoutAudit: true, sanitizationCheck: true,
            images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`screenshot-${index + 1}`, `${index + 1}`.repeat(64)])),
            differences: [], commandVersion: 'd'.repeat(64), captureContextCount: 9,
            evidencePath: '.tmp/release-evidence/public-preview-screenshots.json', evidenceFileDigest: digest('e')
        }, wallClockMs: 2000, error: null
    });
    const postRuntimeReceipt = { executionIdentity: {
        commit: currentRunContext.sourceCommit, worktreeFingerprint: currentRunContext.worktreeFingerprint,
        schedulerRunId: currentRunContext.schedulerRunId, attemptId: currentRunContext.attemptId,
        candidateIdentityDigest: authorityDigest(currentRunContext.candidateIdentity),
        buildIdentityDigest: authorityDigest(currentRunContext.buildIdentity)
    } };
    return { currentRunContext, buildReceipt, browserContractReceipt, postRuntimeReceipt };
}

test('release candidate adapter accepts distinct context-build and production-receipt digests', () =>
{
    const input = fixture();
    assert.notEqual(input.currentRunContext.buildIdentity.digest, input.buildReceipt.contentDigest);
    assert.doesNotThrow(() => assertReleaseFinalPostRuntimeCandidate(input));
});

test('release candidate adapter rejects resealed execution identity and browser drift', () =>
{
    for (const key of ['commit', 'worktreeFingerprint', 'schedulerRunId', 'attemptId', 'candidateIdentityDigest', 'buildIdentityDigest'])
    {
        const input = fixture();
        input.postRuntimeReceipt.executionIdentity[key] = 'other';
        assert.throws(() => assertReleaseFinalPostRuntimeCandidate(input), new RegExp(`identity mismatch: ${key}`, 'u'));
    }
    for (const field of ['run', 'build', 'source', 'diagnostic'])
    {
        const input = fixture();
        const browser = input.browserContractReceipt;
        if (field === 'run')
        {
            browser.runIdentity.runId = 'other';
        }
        if (field === 'build')
        {
            browser.build.receiptContentDigest = digest('9');
        }
        if (field === 'source')
        {
            browser.sourceState.commit = '9'.repeat(40);
        }
        if (field === 'diagnostic')
        {
            browser.classification = 'infra';
        }
        input.browserContractReceipt = sealBrowserContractReceipt(browser);
        assert.throws(() => assertReleaseFinalPostRuntimeCandidate(input), /mismatch|failureClass/u);
    }
});

test('legacy candidate fields cannot replace current execution identity', () =>
{
    const input = fixture();
    input.postRuntimeReceipt = { candidateIdentity: {
        buildReceiptDigest: input.buildReceipt.contentDigest,
        browserContractDigest: input.browserContractReceipt.contentDigest
    } };
    assert.throws(() => assertReleaseFinalPostRuntimeCandidate(input), /execution identity mismatch/u);
});

test('release replay requires the independent current-run context before receipt consumption', () =>
{
    assert.throws(() => verifyReleaseFinalPostRuntimeAuthority({
        directEvidence: {}, repositoryRoot: process.cwd(), environment: {}
    }), /current-run context schema mismatch/u);
});


const schedulerReplay = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const schedulerOwner = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { joinBehaviorEvidencePostRuntime } = await import(new URL('../../tools/test-matrix/behavior-evidence-post-runtime.mjs', import.meta.url));

function replayDataFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-completed-data-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/matrix.yml'), 'tiers: []\n');
    fs.writeFileSync(path.join(root, 'tests/coverage-registry.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'input.txt'), 'original-input\n');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const tier = { id: 'behavior-evidence-post-runtime', command: 'true',
        cacheInputs: ['input.txt'], artifacts: [], evidence: [], executionDependsOn: [] };
    const options = { runId: 'current-run', targetTierId: 'release-final', namespace: 'current',
        sourceState, tiers: [tier] };
    const context = schedulerReplay.createSchedulerVerificationContext(options);
    return { root, tier, context, sourceState };
}

test('completed replay input identity binds source bytes and SDK closure without persisting secrets', (t) =>
{
    const { root, tier } = replayDataFixture(t);
    const input = schedulerReplay.schedulerTierInputIdentity(tier, root, {
        env: { FSUSBLOG_JWT_SECRET: 'task-private-secret' }
    });
    assert.deepEqual(Object.keys(input).sort(),
        ['cacheInputsDigest', 'commandDigest', 'executionKey', 'inputsDigest', 'runtime', 'schema']);
    assert.equal(JSON.stringify(input).includes('task-private-secret'), false);
    assert.notDeepEqual(input.runtime,
        schedulerReplay.schedulerTierInputIdentity(tier, root, {
            env: { FSUSBLOG_JWT_SECRET: 'changed-secret' }
        }).runtime);
    const original = schedulerReplay.tierInputFingerprint(tier, root, { env: {} });
    fs.writeFileSync(path.join(root, 'input.txt'), 'changed-input\n');
    assert.notEqual(schedulerReplay.tierInputFingerprint(tier, root, { env: {} }), original);
    const sdkA = schedulerReplay.schedulerTierInputIdentity({ ...tier,
        nugetSdkIdentity: { sourceClosureDigest: digest('1') } }, root, { env: {} });
    const sdkB = schedulerReplay.schedulerTierInputIdentity({ ...tier,
        nugetSdkIdentity: { sourceClosureDigest: digest('2') } }, root, { env: {} });
    assert.notEqual(sdkA.commandDigest, sdkB.commandDigest);
});

test('completed admission DATA requires a whole closed captured plan and rejects unknown fields', (t) =>
{
    const { root, tier, context, sourceState } = replayDataFixture(t);
    const fields = { runId: context.runId, targetTierId: context.targetTierId,
        currentTierId: tier.id, namespace: context.namespace, mode: 'fresh', sourceState,
        schedulerCandidateIdentityDigest: context.expectedCandidateIdentityDigest,
        schedulerOwnerToken: 'not-a-live-owner', schedulerCheckpointRevision: 1,
        admissionSequence: 1, activeTierIds: [], releaseFinalSpawnCountBeforeAdmission: 0,
        inputIdentity: schedulerReplay.schedulerTierInputIdentity(tier, root, { env: {} }),
        outputDeclarations: [], dependencyAdmissions: {} };
    const data = schedulerOwner.createSchedulerTierAdmission(fields);
    assert.deepEqual(data.inputIdentity, fields.inputIdentity);
    assert.deepEqual(data.outputDeclarations, []);
    assert.deepEqual(data.dependencyAdmissions, {});
    for (const field of ['inputIdentity', 'outputDeclarations', 'dependencyAdmissions'])
    {
        const incomplete = { ...fields };
        delete incomplete[field];
        assert.throws(() => schedulerOwner.createSchedulerTierAdmission(incomplete), /input\/output plan/u);
    }
    assert.throws(() => schedulerOwner.createSchedulerTierAdmission({ ...fields, grant: true }), /unsupported/u);
    assert.throws(() => schedulerOwner.createSchedulerTierAdmission({ ...fields,
        inputIdentity: { ...fields.inputIdentity, qualificationEligible: true } }), /input\/output plan/u);
    assert.throws(() => schedulerOwner.createSchedulerTierAdmission({ ...fields,
        outputDeclarations: [{ declaration: 'result', path: '../foreign/result' }] }), /input\/output plan/u);
});

test('sealed or copied context DATA never supplies the independently retained completed replay capability', (t) =>
{
    const { context } = replayDataFixture(t);
    let getterCalls = 0;
    const unissued = { get contentDigest()
    {
        getterCalls += 1;
        return context.contentDigest;
    } };
    assert.throws(() => schedulerReplay.assertSchedulerVerificationContext(unissued), /independently verified/u);
    assert.equal(getterCalls, 0);
    const proxy = new Proxy({}, {
        get()
        {
            getterCalls += 1;
            return context.contentDigest;
        }
    });
    assert.throws(() => schedulerReplay.assertSchedulerVerificationContext(proxy), /independently verified/u);
    assert.equal(getterCalls, 0);
    for (const candidate of [context, structuredClone(context), { ...context, qualificationEligible: true }])
    {
        assert.throws(() => schedulerReplay.assertSchedulerVerificationContext(candidate), /independently verified/u);
        assert.throws(() => joinBehaviorEvidencePostRuntime({
            completedSchedulerContext: candidate,
            preRuntimeReceipt: 'never-read', observationReceipts: ['never-read', 'never-read'],
            schedulerEvidence: 'never-read'
        }), /independently verified/u);
    }
});

test('independent retained context compares the consumed source and candidate before journal access', (t) =>
{
    const { root, context, sourceState } = replayDataFixture(t);
    const runsRoot = path.join(root, '.tmp/test-runs');
    const directory = path.join(runsRoot, context.runId);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `verification-context-${context.contentDigest}.json`);
    fs.writeFileSync(file, `${JSON.stringify(context)}\n`);
    const args = { root, runsRoot, file, expectedContentDigest: context.contentDigest,
        expectedRunId: context.runId, expectedSourceState: sourceState,
        expectedCandidateIdentityDigest: context.expectedCandidateIdentityDigest };
    assert.throws(() => schedulerReplay.readSchedulerVerificationContext({ ...args,
        expectedSourceState: { ...sourceState, commit: 'c'.repeat(40) } }), /identity or content mismatch/u);
    assert.throws(() => schedulerReplay.readSchedulerVerificationContext({ ...args,
        expectedCandidateIdentityDigest: digest('9') }), /identity or content mismatch/u);
    assert.throws(() => schedulerReplay.readSchedulerVerificationContext({ ...args,
        expectedRunId: 'other-run' }), /outside caller run authority/u);
    assert.throws(() => schedulerReplay.readSchedulerVerificationContext(args), /read-only|missing|ENOENT/u);
    assert.throws(() => schedulerReplay.assertSchedulerVerificationContext(context), /independently verified/u);
});

test('retained scheduler DATA reader accepts owned bytes and rejects symbolic and hardlink aliases', (t) =>
{
    const { root } = replayDataFixture(t);
    const file = path.join(root, 'retained.json');
    fs.writeFileSync(file, '{"value":"original"}\n');
    assert.equal(schedulerOwner.readSchedulerAuthorityBytes(file, root).bytes.toString(),
        '{"value":"original"}\n');
    const alias = path.join(root, 'alias.json');
    fs.symlinkSync(file, alias);
    assert.throws(() => schedulerOwner.readSchedulerAuthorityBytes(alias, root), /single-link regular/u);
    fs.unlinkSync(alias);
    fs.linkSync(file, alias);
    assert.throws(() => schedulerOwner.readSchedulerAuthorityBytes(file, root), /single-link regular/u);
    fs.unlinkSync(alias);
    fs.writeFileSync(file, '');
    assert.throws(() => schedulerOwner.readSchedulerAuthorityBytes(file, root), /single-link regular/u);
});

test('completed post-runtime join keeps all four legacy authority inputs forbidden', () =>
{
    for (const field of ['acceptedClaimsReceipts', 'executionContext', 'verificationMode', 'schedulerVerificationContext'])
    {
        assert.throws(() => joinBehaviorEvidencePostRuntime({ [field]: {} }), /legacy or unknown/u);
    }
});


test('retained scheduler DATA observation refuses same-byte replacement and in-place epochs', (t) =>
{
    const { root } = replayDataFixture(t);
    const file = path.join(root, 'original.json');
    const bytes = '{"data":"same-bytes"}\n';
    fs.writeFileSync(file, bytes);
    const original = schedulerOwner.readSchedulerAuthorityBytes(file, root);
    const repeated = schedulerOwner.readSchedulerAuthorityBytes(file, root);
    assert.doesNotThrow(() => schedulerOwner.requireSchedulerAuthorityObservation(
        original.observation, repeated.observation));
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, bytes);
    fs.renameSync(replacement, file);
    const replaced = schedulerOwner.readSchedulerAuthorityBytes(file, root);
    assert.deepEqual(original.bytes, replaced.bytes);
    assert.throws(() => schedulerOwner.requireSchedulerAuthorityObservation(
        original.observation, replaced.observation), /original physical observation changed/u);
    fs.writeFileSync(file, bytes);
    const updated = schedulerOwner.readSchedulerAuthorityBytes(file, root);
    assert.equal(updated.observation.epoch.ino, replaced.observation.epoch.ino);
    assert.throws(() => schedulerOwner.requireSchedulerAuthorityObservation(
        replaced.observation, updated.observation), /original physical observation changed/u);
});


test('sealed scheduler replay plan omits private environment and retains actual execution options', (t) =>
{
    const { tier, sourceState } = replayDataFixture(t);
    const originalTier = { ...tier, env: { FSUSBLOG_JWT_SECRET: 'must-not-persist' },
        environment: { arbitrarySecret: 'also-must-not-persist' },
        privateLaunchOwner: { value: 'private-owner-data' }, minCpuUnits: 2 };
    const context = schedulerReplay.createSchedulerVerificationContext({
        runId: 'current-run', targetTierId: 'release-final', namespace: 'current',
        sourceState, tiers: [originalTier]
    });
    for (const value of ['must-not-persist', 'also-must-not-persist', 'private-owner-data'])
    {
        assert.equal(JSON.stringify(context).includes(value), false);
    }
    assert.equal(Object.hasOwn(context.tiers[0], 'env'), false);
    assert.equal(Object.hasOwn(context.tiers[0], 'environment'), false);
    assert.equal(context.tiers[0].command, originalTier.command);
    assert.deepEqual(context.tiers[0].cacheInputs, originalTier.cacheInputs);
    assert.equal(originalTier.env.FSUSBLOG_JWT_SECRET, 'must-not-persist');
    assert.equal(originalTier.environment.arbitrarySecret, 'also-must-not-persist');
    assert.equal(originalTier.minCpuUnits, 2);
});
