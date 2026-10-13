/* eslint-disable import-x/no-relative-parent-imports -- Test the domain DATA_ONLY contracts through their original candidate authority. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { readOutcomeAdapterCatalog, validateOutcomeAdapterCandidateData } from '../../tools/test-matrix/outcomes/outcome-adapter-profile-contract.mjs';
import { sealProducerSemanticOutcomeCandidate, validateOutcomeFieldDispositions } from '../../tools/test-matrix/outcomes/outcome-contract.mjs';
import { analyzeProducerSemanticOutcomeCandidate } from '../../tools/test-matrix/outcomes/producer-outcome-analysis.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const d = (digit = '1') => `sha256:${digit.repeat(64)}`;
const shapes = JSON.parse(fs.readFileSync(new URL('../../config/schemas/outcome-adapter-membership.schema.json', import.meta.url)));

function valueFor(schema)
{
    if (schema.const !== undefined)
    {
        return schema.const;
    }
    if (schema.enum)
    {
        return schema.enum[0];
    }
    if (schema.anyOf)
    {
        return valueFor(schema.anyOf[0]);
    }
    if (schema.type === 'object')
    {
        return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, valueFor(value)]));
    }
    if (schema.type === 'array')
    {
        return [];
    }
    if (schema.type === 'boolean')
    {
        return false;
    }
    if (schema.type === 'integer')
    {
        return 1;
    }
    return schema.pattern?.startsWith('^sha256:') ? d() : 'fixture';
}

function fixture(family)
{
    const entry = readOutcomeAdapterCatalog().entries.find((item) => item.family === family);
    const producerId = entry.producerIds[0];
    const identity = { producerId, schedulerRunId: 'fixture-run', sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: d('2'), buildIdentity: d('3'), toolchainDigest: d('4'),
        executionEnvelopeDigest: d('5'), temporalContextDigest: d('6'), replayPlanDigest: d('7') };
    const membership = valueFor(shapes.$defs[family]);
    const candidate = sealProducerSemanticOutcomeCandidate({ producerId, producerAuthorityId: entry.authorityId,
        identity, inputAuthorityRefs: [{ kind: 'fixture', path: 'fixture/input.json', digest: d('8') }],
        attemptEligibility: { aggregateDigest: d('9'), attemptDigest: d('a'), attemptNumber: 1,
            cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true },
        outcome: { status: 'success', requiredMembershipVerified: true, reasons: [], membership,
            semanticPayloadDigest: digestCanonical(membership) } });
    return { candidate, expected: { identity: structuredClone(identity), sourceCommit: entry.sourceCommit,
        sourceDigest: entry.sourceDigest, candidateDigest: candidate.contentDigest } };
}

function reseal(f, change)
{
    const candidate = structuredClone(f.candidate);
    change(candidate);
    candidate.outcome.semanticPayloadDigest = digestCanonical(candidate.outcome.membership);
    f.candidate = sealContentDigest(candidate);
    f.expected.candidateDigest = f.candidate.contentDigest;
}
const validate = (f) => validateOutcomeAdapterCandidateData(JSON.stringify(f.candidate), JSON.stringify(f.expected), 1000000);

test('domain catalog registers the exact seven supplied adapter authorities without granting runtime verification', () =>
{
    const catalog = readOutcomeAdapterCatalog();
    assert.equal(catalog.entries.length, 7);
    assert.deepEqual(catalog.entries.flatMap((entry) => entry.producerIds).sort(), ['backend-unit', 'backend-xunit',
        'browser-contract-semantic-outcome', 'frontend-vitest', 'immutable-build-semantic-outcome',
        'release-finalizer-semantic-outcome', 'release-projection-semantic-outcome', 'release-reliability-semantic-outcome']);
    assert.equal(validate(fixture('backend')).dataOnly, true);
    assert.equal(validate(fixture('backend')).producerVerificationPending, true);
});

test('backend DATA_ONLY profile rejects unknown fields and overlapping terminal membership', () =>
{
    const f = fixture('backend');
    assert.equal(validate(f).normalizationStatus, 'data-only-schema');
    reseal(f, (candidate) => candidate.outcome.membership.newField = 'unregistered');
    assert.throws(() => validate(f), /additional properties/);
    const overlap = fixture('backend');
    reseal(overlap, (candidate) =>
    {
        candidate.outcome.membership.plannedTestIds = ['test'];
        candidate.outcome.membership.executedTestIds = ['test'];
        candidate.outcome.membership.passedTestIds = ['test'];
        candidate.outcome.membership.failedTestIds = ['test'];
    });
    assert.throws(() => validate(overlap), /planned tests is not exact/);
});

test('frontend profile preserves dynamic suite maps and refuses newly invented nested assertion fields', () =>
{
    const f = fixture('frontend');
    reseal(f, (candidate) => candidate.outcome.membership.suiteTestIds = { 'suite:one': [] });
    assert.throws(() => validate(f), /frontend suite map is not exact/);
    reseal(f, (candidate) =>
    {
        candidate.outcome.membership.plannedSuiteIds = ['suite:one'];
        candidate.outcome.membership.passedSuiteIds = ['suite:one'];
    });
    assert.equal(validate(f).normalizationStatus, 'data-only-schema');
    reseal(f, (candidate) => candidate.outcome.membership.assertions = [{ id: 'assertion', testId: 'test',
        status: 'passed', failureClass: null, failureKind: null, failureIdentity: null, newField: 'unknown' }]);
    assert.throws(() => validate(f), /additional properties/);
});

test('browser compatible v2 profile retains member-level semantics and rejects disguised blocked execution', () =>
{
    validateOutcomeFieldDispositions();
    const f = fixture('browser');
    assert.equal(validate(f).dataOnly, true);
    const analysis = analyzeProducerSemanticOutcomeCandidate(f.candidate, { expectedIdentity: f.expected.identity,
        expectedProducerId: f.candidate.producerId, expectedAuthorityId: f.candidate.producerAuthorityId,
        hostExpectedLimits: { maxDepth: 32, maxNodes: 100000, maxStringBytes: 1000000, maxArrayItems: 10000, maxObjectKeys: 10000 } });
    assert.equal(analysis.producerVerificationPending, true);
    reseal(f, (candidate) =>
    {
        const membership = candidate.outcome.membership;
        membership.plannedMemberIds = ['member'];
        membership.plannedProjectIds = ['project'];
        membership.plannedBrowserIds = ['browser'];
        membership.plannedTestIds = ['test'];
        membership.plannedAssertionIds = ['assertion'];
        membership.executedMemberIds = ['member'];
        membership.blockedMemberIds = ['member'];
        membership.members = [{ id: 'member', projectId: 'project', browserId: 'browser', testId: 'test',
            assertionId: 'assertion', required: false, executed: true, status: 'blocked', failureKinds: [], artifactIds: [] }];
    });
    assert.throws(() => validate(f), /browser execution\/status mismatch/);
});

test('reliability profile preserves unspawned and qualified member distinctions', () =>
{
    const f = fixture('reliability');
    assert.equal(validate(f).dataOnly, true);
    reseal(f, (candidate) =>
    {
        candidate.outcome.membership.scenarioIds = ['scenario'];
        candidate.outcome.membership.memberOutcomes = [{ scenarioId: 'scenario', planned: true, executed: true,
            terminalClassification: 'not-reached', reachedPhase: 'not-reached', lifecycle: [], failureReasons: [],
            semanticEvidence: valueFor(shapes.$defs.reliability.properties.memberOutcomes.items.properties.semanticEvidence) }];
    });
    assert.throws(() => validate(f), /unspawned reliability member/);
});

test('domain source digest producer authority and independent candidate identities fail closed', () =>
{
    const f = fixture('browser');
    f.expected.sourceDigest = d('b');
    assert.throws(() => validate(f), /adapter source identity mismatch/);
    const identity = fixture('browser');
    identity.expected.identity.schedulerRunId = 'foreign';
    assert.throws(() => validate(identity), /independent candidate identity/);
    const unknown = fixture('browser');
    reseal(unknown, (candidate) => candidate.producerAuthorityId = 'unknown');
    assert.throws(() => validate(unknown), /not registered/);
});

test('domain contracts leave all three existing build profile identities usable', () =>
{
    assert.equal(validate(fixture('immutable-build-semantic-outcome')).normalizationStatus, 'existing-v2');
    assert.equal(validate(fixture('release-projection-semantic-outcome')).normalizationStatus, 'existing-v2');
    assert.equal(validate(fixture('release-finalizer-semantic-outcome')).normalizationStatus, 'existing-v2');
});

test('domain admission refuses omitted limits nonencoded objects and oversized input', () =>
{
    assert.throws(() => validateOutcomeAdapterCandidateData('{}', '{}'), /explicit host byte budget/);
    assert.throws(() => validateOutcomeAdapterCandidateData({}, '{}', 100), /encoded input/);
    assert.throws(() => validateOutcomeAdapterCandidateData('a'.repeat(101), '{}', 100), /host budget/);
});


test('frontend contract preserves partially executed blocked tests and suite terminal priority from the exact source', () =>
{
    const f = fixture('frontend');
    reseal(f, (candidate) =>
    {
        candidate.outcome.status = 'failed';
        candidate.outcome.requiredMembershipVerified = false;
        candidate.outcome.reasons = [{ kind: 'infra.process-signal', producerId: candidate.producerId,
            identity: { producerId: candidate.producerId, attemptNumber: 1 } }];
        const membership = candidate.outcome.membership;
        membership.plannedTestIds = ['test'];
        membership.executedTestIds = ['test'];
        membership.blockedTestIds = ['test'];
        membership.plannedSuiteIds = ['suite'];
        membership.executedSuiteIds = ['suite'];
        membership.blockedSuiteIds = ['suite'];
        membership.suiteTestIds = { suite: ['test'] };
    });
    assert.equal(validate(f).producerVerificationPending, true);
    reseal(f, (candidate) => candidate.outcome.membership.passedSuiteIds = ['suite']);
    assert.throws(() => validate(f), /frontend suite status is not exact/);
});

test('domain contracts refuse assertions and browser identity axes outside planned membership', () =>
{
    const f = fixture('backend');
    reseal(f, (candidate) => candidate.outcome.membership.assertions = [{ testId: 'unplanned', caseId: 'case',
        assertionId: 'assertion', status: 'passed', evidenceId: 'evidence' }]);
    assert.throws(() => validate(f), /assertion refers to an unplanned test/);
    const browser = fixture('browser');
    reseal(browser, (candidate) => candidate.outcome.membership.plannedProjectIds = ['extra']);
    assert.throws(() => validate(browser), /browser planned identity axes is not exact/);
});
