import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
    assertReleaseFinalPostRuntimeCandidate,
    verifyReleaseFinalPostRuntimeAuthority
} from '../../tools/release/release-final-domain-evidence.mjs';
import { sealBrowserContractReceipt } from '../../tools/release/test-evidence-receipts.mjs';
import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import { authorityDigest } from '../../tools/test-matrix/post-runtime-producer-registry.mjs';

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
        if (field === 'run') browser.runIdentity.runId = 'other';
        if (field === 'build') browser.build.receiptContentDigest = digest('9');
        if (field === 'source') browser.sourceState.commit = '9'.repeat(40);
        if (field === 'diagnostic') browser.classification = 'infra';
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

// Exact original caller body with controlled dependencies: interface/order
// components only, not persisted replay, scheduler terminal or native authority.
function replayCallerComponent(dependencies)
{
    const source = readFileSync(new URL(
        '../../tools/release/release-final-domain-evidence.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export function verifyReleaseFinalPostRuntimeAuthority(');
    const end = source.indexOf('\nexport function assertReleaseFinalBehaviorAuthorityBinding(', start);
    assert.ok(start >= 0 && end > start, 'original caller source boundaries must be present');
    return runInNewContext(`${source.slice(start, end).replace(/^export /u, '')}\n`
        + 'verifyReleaseFinalPostRuntimeAuthority;', dependencies);
}

function replayCallerInput()
{
    const receipt = {
        contentDigest: digest('1'),
        observationRefs: [
            { producerId: 'alpha-producer', scope: 'application', path: '.tmp/current-run/alpha-application.json' },
            { producerId: 'alpha-producer', scope: 'release-deployment', path: '.tmp/current-run/alpha-release.json' },
            { producerId: 'beta-producer', scope: 'application', path: '.tmp/current-run/beta-application.json' },
            { producerId: 'beta-producer', scope: 'release-deployment', path: '.tmp/current-run/beta-release.json' }
        ],
        acceptedClaimsRefs: {
            'alpha-producer': { path: '.tmp/current-run/alpha-claims.json' },
            'beta-producer': { path: '.tmp/current-run/beta-claims.json' }
        },
        schedulerEvidence: { path: '.tmp/current-run/scheduler-admission.json' }
    };
    return {
        currentRunContext: { component: 'independent-current-context' },
        repositoryRoot: '/component-repository',
        directEvidence: {
            behaviorPostRuntime: { file: '.tmp/current-run/post.json', receipt },
            behaviorPreRuntime: { file: '.tmp/current-run/pre.json' },
            browserContract: { receipt: { component: 'original-browser' } },
            productionBuild: { receipt: { component: 'original-build' } }
        }
    };
}

test('release v2 caller component forwards exact original persisted replay inputs', () =>
{
    const input = replayCallerInput();
    const post = input.directEvidence.behaviorPostRuntime.receipt;
    const order = [];
    const caller = replayCallerComponent({
        validateCurrentRunEvidenceContext: (value) => { order.push('context'); return value; },
        validatePostRuntimeReceipt: (value) => { order.push('post'); assert.equal(value, post); return value; },
        verifyBehaviorEvidencePostRuntime: (options) => {
            order.push('replay');
            assert.deepEqual(Object.keys(options).sort(), [
                'receipt', 'preRuntimeReceipt', 'catalog', 'registry',
                'observationReceipts', 'schedulerEvidence', 'repositoryRoot'
            ].sort());
            assert.equal(options.receipt, input.directEvidence.behaviorPostRuntime.file);
            assert.equal(options.preRuntimeReceipt, input.directEvidence.behaviorPreRuntime.file);
            assert.equal(options.catalog, 'config/contracts/behavior-contracts.json');
            assert.equal(options.registry, 'config/testing/post-runtime-producer-registry.json');
            assert.deepEqual(Array.from(options.observationReceipts), post.observationRefs.map(({ path }) => path));
            assert.equal(options.schedulerEvidence, post.schedulerEvidence.path);
            assert.equal(options.repositoryRoot, input.repositoryRoot);
            return post;
        },
        assertReleaseFinalPostRuntimeCandidate: (options) => {
            order.push('candidate');
            assert.equal(options.postRuntimeReceipt, post);
            assert.equal(options.currentRunContext, input.currentRunContext);
            assert.equal(options.browserContractReceipt, input.directEvidence.browserContract.receipt);
            assert.equal(options.buildReceipt, input.directEvidence.productionBuild.receipt);
        }
    });
    assert.equal(caller(input), post);
    assert.deepEqual(order, ['context', 'post', 'replay', 'candidate']);
});

test('release v2 caller component retains replay failures and located digest binding', () =>
{
    for (const boundary of ['post-validator', 'independent-replay', 'replay-digest'])
    {
        const input = replayCallerInput();
        const post = input.directEvidence.behaviorPostRuntime.receipt;
        const failure = new Error(`original ${boundary} refusal`);
        let candidateCalls = 0;
        const caller = replayCallerComponent({
            validateCurrentRunEvidenceContext: (value) => value,
            validatePostRuntimeReceipt: (value) => {
                if (boundary === 'post-validator') throw failure;
                return value;
            },
            verifyBehaviorEvidencePostRuntime: () => {
                if (boundary === 'independent-replay') throw failure;
                return { ...post, contentDigest: digest('2') };
            },
            assertReleaseFinalPostRuntimeCandidate: () => { candidateCalls += 1; }
        });
        if (boundary === 'replay-digest')
            assert.throws(() => caller(input), /post-runtime replay differs from located receipt/u);
        else assert.throws(() => caller(input), (error) => error === failure);
        assert.equal(candidateCalls, 0);
    }
});
