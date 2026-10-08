import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createBrowserContractObservationFixture } from './support/browser-contract-observation-fixture.mjs';

const { readBrowserContractOutcomeRunnerBinding, adaptBrowserContractRunnerSemanticOutcome,
    adaptBrowserContractRunnerSemanticOutcomeWithCustody } = await import(new URL('../../tools/test-matrix/outcomes/browser-contract-runner-binding.mjs', import.meta.url));
const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { readCorrectnessProducerTemporalAuthority } = await import(new URL('../../tools/test/temporal-producer-bindings.mjs', import.meta.url));
const { sealBrowserContractReceipt } = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { projectBrowserContractRaw } = await import(new URL('../../tools/test-evidence/browser-contract-observation-raw.mjs', import.meta.url));
const { finalizeBrowserContractReceipt } = await import(new URL('../browser-contract/contract.mjs', import.meta.url));
const { sealDocument } = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const fileDigest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;

// Original source fixtures exercise native readers and publication contracts;
// their synthetic observations do not qualify a browser or a release run.
function fixture(t)
{
    const preview = path.resolve(import.meta.dirname, '../../.tmp/release-evidence/public-preview-screenshots.json');
    assert.equal(fs.existsSync(preview), false, 'the unit fixture may not replace an existing preview owner output');
    const value = createBrowserContractObservationFixture(t);
    const reseal = (status = 'success') =>
    {
        delete value.browser.finalization;
        finalizeBrowserContractReceipt(value.browser, {
            primary: status === 'success' ? { status, classification: 'clean', error: null }
                : { status, classification: 'infra', error: { name: 'BrowserContractFailure', message: 'structured fixture interruption', failureClass: 'infra' } },
            cleanup: { status: 'success', error: null },
            finishedAt: '2026-08-30T00:00:01.000Z', wallClockMs: 1000
        });
        value.browser.finalization.persistence.attemptCount = 1;
        value.browser = sealBrowserContractReceipt(value.browser);
        fs.writeFileSync(value.browserFile, `${JSON.stringify(value.browser, null, 2)}\n`);
        return { path: value.relative(value.browserFile), digest: fileDigest(value.browserFile) };
    };
    const runnerReference = reseal();
    const raw = projectBrowserContractRaw({ candidatePlan: value.relative(value.planFile),
        browserContractReceipt: value.relative(value.browserFile), repositoryRoot: value.repositoryRoot });
    const rawFile = path.join(value.repositoryRoot, value.rawPath);
    fs.mkdirSync(path.dirname(rawFile), { recursive: true });
    fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 2)}\n`);
    const expected = {
        identity: { producerId: 'browser-contract-semantic-outcome', sourceCommit: value.browser.sourceState.commit,
            worktreeFingerprint: `sha256:${value.browser.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')}`,
            buildIdentity: value.browser.buildBinding.receiptContentDigest,
            schedulerRunId: value.browser.runIdentity.runId,
            temporalContextDigest: digestCanonical(value.browser.temporalBinding.plan.temporalContext),
            executionEnvelopeDigest: digest('1'), replayPlanDigest: digest('2'), toolchainDigest: digest('3') },
        attemptId: value.browser.runIdentity.attemptId, fixtureNamespace: value.browser.fixtureNamespace,
        browserPlanDigest: value.browser.playwright.browserIdentity.plan.contentDigest,
        browserActualDigest: value.browser.playwright.browserIdentity.actual.contentDigest,
        fixtureCapabilities: structuredClone(value.browser.fixture.capabilities)
    };
    const options = { repositoryRoot: value.repositoryRoot, runnerReference, expected,
        temporalAuthority: readCorrectnessProducerTemporalAuthority(), releaseReliability: null,
        rawObservationReferences: { candidatePlan: { path: value.relative(value.planFile), digest: fileDigest(value.planFile) },
            receipt: { path: value.rawPath, digest: fileDigest(rawFile) } } };
    const fail = () =>
    {
        value.browser.scenarios[0].status = 'failure';
        value.browser.scenarios[0].classification = 'infra';
        value.browser.scenarios[0].error = { name: 'BrowserContractFailure', message: 'opaque fixture text', failureClass: 'infra' };
        for (const scenario of value.browser.scenarios.slice(1))
        {
            Object.assign(scenario, { status: 'pending', classification: null, startedAt: null, finishedAt: null, durationMs: null,
                issues: [], artifacts: [], error: null });
        }
        options.runnerReference = reseal('failure');
        options.rawObservationReferences = null;
    };
    return { value, options, rawFile, reseal, fail, read: () => readBrowserContractOutcomeRunnerBinding(options) };
}

function memberInputs(f, failure = false, attemptOverrides = {})
{
    const authority = { identity: f.options.expected.identity,
        attemptEligibility: { aggregateDigest: digest('4'), attemptDigest: digest('5'), attemptNumber: 1,
            cleanFirstAttempt: !failure, firstFailure: failure, qualificationEligible: !failure, ...attemptOverrides },
        policyDigest: digest('6'), runtimeIdentities: [{ projectId: 'browser-contract', browserId: 'chromium',
            runtimeDigest: f.options.expected.browserActualDigest }], inputAuthorityRefs: [] };
    const members = f.value.browser.scenarios.map((scenario) => ({
        id: `member:${scenario.id}`, projectId: 'browser-contract', browserId: 'chromium',
        testId: `browser-contract:${scenario.id}`, assertionId: `held-assertion:${scenario.id}`, required: true, artifacts: []
    }));
    const common = { identity: authority.identity, attemptEligibility: authority.attemptEligibility,
        policyDigest: authority.policyDigest, runtimeIdentities: authority.runtimeIdentities };
    const catalog = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-catalog.v1', ...common, members });
    const plan = sealContentDigest({ schema: 'fsusblog.browser-contract-outcome-plan.v1', ...common, members, catalogDigest: catalog.contentDigest });
    const interruption = failure ? { kind: 'infra.browser-crash', identity: { producerId: authority.identity.producerId, attemptNumber: 1 } } : null;
    const report = { schema: 'fsusblog.browser-contract-outcome-report.v1', ...common,
        catalogDigest: catalog.contentDigest, planDigest: plan.contentDigest,
        groupStatus: failure ? 'failed' : 'success', interruption,
        diagnostics: { runnerReceipt: f.options.runnerReference }, artifacts: [],
        members: members.map(({ required, artifacts, ...member }, index) =>
        {
            void required;
            void artifacts;
            const status = failure ? index === 0 ? 'failed' : 'blocked' : 'passed';
            const identity = { producerId: authority.identity.producerId, projectId: member.projectId,
                browserId: member.browserId, testId: member.testId, assertionId: member.assertionId, attemptNumber: 1 };
            return { ...member, status, executed: status !== 'blocked', artifactIds: [],
                failures: status === 'failed' ? [{ kind: 'infra.browser-crash', identity }] : [] };
        }) };
    const write = () =>
    {
        authority.inputAuthorityRefs = [catalog, plan, sealContentDigest(report)].map((document, index) =>
        {
            const kind = ['catalog', 'plan', 'report'][index];
            const file = path.join(f.value.directory, `outcome-${kind}.json`);
            fs.writeFileSync(file, JSON.stringify(document));
            return { kind: `browser-contract-${kind}`, path: f.value.relative(file), digest: fileDigest(file) };
        });
    };
    return { authority, report, adapt: () =>
    {
        write();
        return adaptBrowserContractRunnerSemanticOutcome({ repositoryRoot: f.value.repositoryRoot, authority, runnerBinding: f.options });
    } };
}

test('production bridge reopens original runner and independently verified raw observation', (t) =>
{
    const f = fixture(t);
    const source = f.read();
    assert.equal(source.receipt.schema, 'fsusblog.browser-contract-receipt.v2');
    assert.equal(source.rawObservation.schema, 'fsusblog.browser-contract-receipt.v2');
    assert.equal(source.terminals.length, 6);
    assert.ok(source.terminals.every((terminal) => terminal.status === 'success' && terminal.executed));
    assert.equal(source.inputAuthorityRefs.length, 3);
    assert.equal(source.reliabilityBinding, null);
});

test('failed bridge binds held individual report without turning source scenario status into assertions', (t) =>
{
    const f = fixture(t);
    f.fail();
    const inputs = memberInputs(f, true);
    const result = inputs.adapt();
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.inputAuthorityRefs.length, 4);
    assert.ok(result.outcome.membership.plannedAssertionIds.every((id) => id.startsWith('held-assertion:')));
    const withoutReport = { ...inputs.authority, inputAuthorityRefs: inputs.authority.inputAuthorityRefs.filter((ref) => ref.kind !== 'browser-contract-report') };
    assert.throws(() => adaptBrowserContractRunnerSemanticOutcome({ repositoryRoot: f.value.repositoryRoot,
        authority: withoutReport, runnerBinding: f.options }), /held member report is required/u);
});

test('actual failure terminals preserve pending members and cannot reuse a successful raw observation', (t) =>
{
    const f = fixture(t);
    const oldRaw = f.options.rawObservationReferences;
    f.fail();
    const source = f.read();
    assert.equal(source.terminals.find((terminal) => terminal.scenarioId === f.value.browser.scenarios[0].id).status, 'failure');
    assert.equal(source.terminals.filter((terminal) => terminal.executed).length, 1);
    assert.equal(source.terminals.filter((terminal) => terminal.status === 'pending').length, 5);
    assert.equal(source.rawObservation, null);
    f.options.rawObservationReferences = oldRaw;
    assert.throws(f.read, /failed native runner cannot consume/u);
});

test('failed native run remains a failed candidate with blocked members and first-failure provenance', (t) =>
{
    const f = fixture(t);
    f.fail();
    const result = memberInputs(f, true).adapt();
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.membership.failedMemberIds.length, 1);
    assert.equal(result.outcome.membership.blockedMemberIds.length, 5);
    assert.equal(result.attemptEligibility.firstFailure, true);
});

test('native receipt and raw observation tamper fail before membership admission', (t) =>
{
    const f = fixture(t);
    fs.appendFileSync(f.rawFile, ' ');
    assert.throws(f.read, /artifact content digest mismatch/u);
    f.options.rawObservationReferences.receipt.digest = fileDigest(f.rawFile);
    fs.appendFileSync(f.value.browserFile, ' ');
    assert.throws(f.read, /artifact content digest mismatch/u);
});

test('held run attempt source build and browser identities reject cross-cohort evidence', (t) =>
{
    const f = fixture(t);
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'buildIdentity', 'schedulerRunId'])
    {
        const original = f.options.expected.identity[field];
        f.options.expected.identity[field] = field === 'sourceCommit' ? 'f'.repeat(40) : digest('f');
        assert.throws(f.read, /native receipt rejected|native source\/run\/attempt\/fixture mismatch/u);
        f.options.expected.identity[field] = original;
    }
    f.options.expected.attemptId = 'attempt-0002';
    assert.throws(f.read, /native source\/run\/attempt\/fixture mismatch/u);
    f.options.expected.attemptId = f.value.browser.runIdentity.attemptId;
    f.options.expected.browserActualDigest = digest('f');
    assert.throws(f.read, /held browser runtime mismatch/u);
});

test('successful native receipt requires original raw source verification and independent temporal authority', (t) =>
{
    const f = fixture(t);
    f.options.rawObservationReferences = null;
    assert.throws(f.read, /held raw observation references/u);
    f.options.temporalAuthority = null;
    assert.throws(f.read, /native receipt rejected|independent temporal authority/u);
});

test('pending native scenario cannot gain fabricated executed assertion members', (t) =>
{
    const f = fixture(t);
    f.fail();
    const inputs = memberInputs(f, true);
    inputs.report.members[1].status = 'passed';
    inputs.report.members[1].executed = true;
    assert.throws(inputs.adapt, /pending native scenario has fabricated/u);
});

test('native/member report source reference mismatch is refused after both documents are resealed', (t) =>
{
    const f = fixture(t);
    f.fail();
    const inputs = memberInputs(f, true);
    inputs.report.diagnostics.runnerReceipt.digest = digest('f');
    // Replace the diagnostic object rather than the independently held reference.
    f.options.runnerReference = { path: f.value.relative(f.value.browserFile), digest: fileDigest(f.value.browserFile) };
    assert.throws(inputs.adapt, /member report\/native source binding mismatch/u);
});

test('original Release Reliability identity API binds the same Browser source build and run without qualifying exact-seven', (t) =>
{
    const f = fixture(t);
    f.fail();
    const invocationId = `browser-bridge-${path.basename(f.value.directory)}`;
    const identityPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    const identityFile = path.join(f.value.repositoryRoot, identityPath);
    fs.mkdirSync(path.dirname(identityFile), { recursive: true });
    t.after(() => fs.rmSync(path.dirname(identityFile), { recursive: true, force: true }));
    const identity = sealDocument({ schema: 'fsusblog.release-reliability-run-identity.v1', status: 'complete',
        invocationId, runId: f.options.expected.identity.schedulerRunId,
        sourceState: { commit: f.options.expected.identity.sourceCommit, worktreeFingerprint: f.options.expected.identity.worktreeFingerprint,
            dirtyPathCount: 0, hashedPathCount: 1 }, build: { contentDigest: f.options.expected.identity.buildIdentity } });
    fs.writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    f.options.releaseReliability = { identityReference: { path: identityPath, digest: fileDigest(identityFile) }, environment: {
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: invocationId,
        FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: identity.runId,
        FSUSBLOG_RELEASE_RELIABILITY_SCENARIO_ID: 'release-load-peak',
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH: identityPath,
        FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_DIGEST: identity.contentDigest
    } };
    const source = f.read();
    assert.equal(source.reliabilityBinding.identityContentDigest, identity.contentDigest);
    assert.equal(source.reliabilityBinding.scenarioId, 'release-load-peak');
    assert.equal(source.inputAuthorityRefs.length, 2);
    f.options.releaseReliability.environment.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID = 'other-run';
    assert.throws(f.read, /run identity is incomplete or mismatched/u);
    f.options.releaseReliability.environment.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID = identity.runId;
    const originalReader = fs.readFileSync;
    try
    {
        fs.readFileSync = function (file, ...args)
        {
            const bytes = originalReader.call(this, file, ...args);
            if (file === identityFile && args[0] === 'utf8')
            {
                fs.appendFileSync(identityFile, ' ');
            }
            return bytes;
        };
        assert.throws(f.read, /artifact content digest mismatch/u);
    }
    finally
    {
        fs.readFileSync = originalReader;
    }
});

test('native failed scenario cannot be replaced by passing individual assertions', (t) =>
{
    const f = fixture(t);
    f.fail();
    const inputs = memberInputs(f, true);
    Object.assign(inputs.report.members[0], { status: 'passed', failures: [] });
    assert.throws(inputs.adapt, /failed native scenario was replaced by passing members/u);
});

test('native failed attempt cannot erase first-failure qualification provenance', (t) =>
{
    const f = fixture(t);
    f.fail();
    const inputs = memberInputs(f, true, { firstFailure: false, cleanFirstAttempt: true, qualificationEligible: true });
    assert.throws(inputs.adapt, /failed native attempt provenance was erased/u);
});

test('composed bridge pins the caller repository root over a runner options override', (t) =>
{
    const f = fixture(t);
    f.fail();
    f.options.repositoryRoot = path.join(f.value.directory, 'unavailable-other-repository');
    assert.equal(memberInputs(f, true).adapt().outcome.status, 'failed');
});

test('custody composition preserves native byte refusal before evaluating downstream held context', async (t) =>
{
    const f = fixture(t);
    fs.appendFileSync(f.value.browserFile, ' ');
    await assert.rejects(() => adaptBrowserContractRunnerSemanticOutcomeWithCustody({
        repositoryRoot: f.value.repositoryRoot, authority: {}, runnerBinding: f.options,
        encodedExpected: '{}', custodyOptions: {}
    }), /artifact content digest mismatch/u);
});
