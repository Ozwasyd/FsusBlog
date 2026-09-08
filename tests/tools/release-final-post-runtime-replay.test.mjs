import assert from 'node:assert/strict';
import test from 'node:test';

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
