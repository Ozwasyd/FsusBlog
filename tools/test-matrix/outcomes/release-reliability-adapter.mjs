import fs from 'node:fs';
import { types } from 'node:util';

import { candidate, exactIds, reason } from './adapter-support.mjs';
import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../test/release-reliability-receipt.mjs', import.meta.url));
const { releaseReliabilityScenarioIds } = await import(
    new URL('../../release/release-reliability-qualified-receipt.mjs', import.meta.url)
);
const catalog = JSON.parse(fs.readFileSync(new URL(
    '../../../config/testing/release-reliability-scenario-catalog.json', import.meta.url
), 'utf8'));
const registry = JSON.parse(fs.readFileSync(new URL(
    '../../../config/testing/release-reliability-lifecycle-action-registry.json', import.meta.url
), 'utf8'));
const terminalClasses = new Set(['qualified-success', 'product-failure', 'precondition-failure',
    'infra-no-conclusion', 'cancelled', 'not-reached']);
const phases = ['precondition', 'reset-before', 'measurement', 'postcondition', 'reset-after'];
const bindingFields = ['invocationId', 'attemptDigest', 'currentRunDigest', 'fixtureDigest',
    'machineDigest', 'policyDigest', 'runtimeDigest'];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export const releaseReliabilityOutcomeProducerId = 'release-reliability-semantic-outcome';
export const releaseReliabilityOutcomeAuthorityId = 'tools/test-matrix/outcomes/release-reliability-adapter.mjs';

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`release reliability outcome: ${message}`);
    }
}

function data(value, active = new Set(), depth = 0)
{
    require(depth < 64, 'input depth exceeded');
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
    {
        return;
    }
    if (typeof value === 'number')
    {
        require(Number.isFinite(value), 'nonfinite input');
        return;
    }
    require(typeof value === 'object' && !types.isProxy(value) && !active.has(value),
        'inputs must be acyclic plain JSON data');
    const array = Array.isArray(value);
    require(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype),
        'inputs must be plain JSON data');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    require(keys.length <= 4096 && keys.every(key => typeof key === 'string'
        && Object.hasOwn(descriptors[key], 'value')
        && (descriptors[key].enumerable || array && key === 'length')),
    'inputs cannot contain accessors, symbols or hidden fields');
    if (array)
    {
        require(keys.length === value.length + 1, 'inputs cannot contain sparse arrays');
    }
    active.add(value);
    for (const key of keys.filter(key => !array || key !== 'length'))
    {
        data(descriptors[key].value, active, depth + 1);
    }
    active.delete(value);
}

function equal(actual, expected, label)
{
    require(expected !== undefined && digestCanonical(actual) === digestCanonical(expected),
        `${label} differs from independent expected input`);
}

function sealed(document, expectedDigest, label)
{
    require(digestPattern.test(expectedDigest) && document?.contentDigest === expectedDigest
        && digestValue(document) === expectedDigest, `${label} seal or independent digest mismatch`);
}

function exactMembers(items, label)
{
    require(Array.isArray(items), `${label} is missing`);
    equal(exactIds(items.map(item => item.scenarioId), label), releaseReliabilityScenarioIds, label);
}

function exactMap(value, keys, label)
{
    require(value && !Array.isArray(value), `${label} is missing`);
    equal(Object.keys(value).sort(), [...keys].sort(), label);
}

function referenceKey(reference)
{
    require(reference && typeof reference.path === 'string' && reference.path.length > 0,
        'receipt reference is missing');
    return reference.path;
}

function verifyReference(reference, expected, consumed)
{
    const key = referenceKey(reference);
    const value = reference.bytesDigest ?? reference.digest ?? reference.contentDigest;
    require(digestPattern.test(value), `receipt ${key} digest is missing`);
    equal(value, expected[key], `receipt ${key}`);
    consumed.add(key);
}

function lifecycle(result, terminal, member, expected, consumed)
{
    const planned = registry.actions.filter(action => action.scenarioId === result.scenarioId);
    require(planned.length > 0 && phases.every(phase => planned.some(action => action.phase === phase)),
        'canonical lifecycle plan is incomplete');
    const actions = result.lifecycle?.actions;
    require(Array.isArray(actions), 'lifecycle actions are missing');
    const ids = exactIds(actions.map(action => action.actionId), 'lifecycle actions');
    require(ids.every(id => planned.some(action => action.actionId === id)), 'orphan lifecycle action');
    const notReached = terminal.terminalClassification === 'not-reached';
    exactMap(member.isolationEvidenceDigests, planned.map(action => action.actionId), 'member isolation evidence');
    require(!notReached || actions.length === 0, 'not-reached scenario has lifecycle actions');
    const projection = planned.map(plan =>
    {
        const action = actions.find(item => item.actionId === plan.actionId);
        if (!action)
        {
            require(notReached, `lifecycle phase ${plan.phase} is missing`);
            return { actionId: plan.actionId, phase: plan.phase, status: 'not-run',
                stateDomains: [...plan.stateDomains], isolationEvidenceDigest: null };
        }
        require(action.phase === plan.phase
            && ['passed', 'failed', 'timed-out', 'cancelled', 'not-run'].includes(action.status),
        'lifecycle phase or status is unknown');
        const reached = action.status !== 'not-run';
        if (reached)
        {
            require(action.receipt && action.processTreeReceipt, 'lifecycle isolation evidence is incomplete');
            equal(action.receipt.stateDomains, plan.stateDomains, 'lifecycle state domains');
            require(action.receipt.actionId === plan.actionId && action.receipt.phase === plan.phase,
                'lifecycle receipt identity mismatch');
            verifyReference(action.receipt, expected.receiptDigests, consumed);
            verifyReference(action.processTreeReceipt, expected.receiptDigests, consumed);
            require(action.processTreeReceipt.postObservation === 'zero-members'
                && action.processTreeReceipt.logComplete === true
                && action.terminalFence?.status === 'closed'
                && action.terminalFence.lateEvidenceAccepted === false,
            'lifecycle isolation evidence is incomplete');
        }
        else
        {
            require(!action.receipt && !action.processTreeReceipt, 'unreached phase has receipts');
        }
        const isolationDigest = member.isolationEvidenceDigests?.[plan.actionId];
        require(reached ? digestPattern.test(isolationDigest) : isolationDigest === null,
            'independent isolation semantic evidence is missing');
        equal(isolationDigest, expected.isolationDigests[plan.actionId], 'isolation semantic evidence');
        return { actionId: plan.actionId, phase: plan.phase, status: action.status,
            stateDomains: [...plan.stateDomains], isolationEvidenceDigest: isolationDigest };
    });
    if (terminal.terminalClassification === 'qualified-success')
    {
        require(projection.every(action => action.status === 'passed')
            && result.lifecycle.resetPostObservation?.status === 'passed'
            && result.lifecycle.finalPostObservation?.status === 'passed',
        'successful member has incomplete lifecycle');
    }
    equal(projection, expected.lifecycleByScenario[result.scenarioId], 'independent lifecycle projection');
    return projection;
}

function failures(member, terminal, identity, attemptEligibility)
{
    const taxonomy = readOutcomeFailureTaxonomy();
    const classification = terminal.terminalClassification;
    require(Array.isArray(member.failures), 'canonical member failures are missing');
    require(classification === 'qualified-success' ? member.failures.length === 0 : member.failures.length > 0,
        'terminal classification and failure topology disagree');
    return member.failures.map(failure =>
    {
        const rule = taxonomy.get(failure.kind);
        require(rule && typeof failure.evidenceId === 'string' && failure.evidenceId.length > 0
            && (phases.includes(failure.phase)
                || classification === 'not-reached' && failure.phase === 'not-reached'),
        'unknown canonical failure or lifecycle identity');
        const category = failure.kind.split('.')[0];
        require(classification === 'product-failure' ? category === 'product' : category !== 'product',
            'non-product terminal cannot carry a product failure');
        require(classification !== 'infra-no-conclusion' || category === 'infra',
            'no-conclusion terminal requires infrastructure identity');
        require(classification !== 'cancelled' || failure.kind === 'infra.process-signal',
            'cancelled terminal requires process-signal identity');
        require(classification !== 'not-reached' || failure.kind === 'contract.missing-evidence',
            'not-reached terminal requires missing-evidence identity');
        const failureIdentity = { ...failure.identity, scenarioId: member.scenarioId,
            lifecyclePhase: failure.phase, evidenceId: failure.evidenceId };
        for (const field of rule.requiredIdentity.filter(field => field !== 'producerId'))
        {
            require(failureIdentity[field] !== undefined, `canonical failure lacks ${field}`);
            if (Object.hasOwn(identity, field))
            {
                equal(failureIdentity[field], identity[field], `failure ${field}`);
            }
            if (field === 'attemptNumber')
            {
                equal(failureIdentity[field], attemptEligibility.attemptNumber, 'failure attempt');
            }
        }
        return reason(failure.kind, releaseReliabilityOutcomeProducerId, failureIdentity, { failureClass: category });
    });
}

/**
 * Adapt the canonical v3 terminal timeline after its existing owner verifies it.
 * `expected` is independent held input: exact raw seals, terminal projection,
 * lifecycle/receipt digests and producer-owned semantic projections. It cannot
 * be derived from this invocation's evidence or substituted by group qualification.
 * DATA_ONLY fixtures exercise this boundary; they confer no runtime authority.
 * Metrics/state/assertions are supplied by the producer's verified projection,
 * bound to its original evidence digest, rather than extracted from log text.
 * The output is candidate v1, never a sealed producer outcome or a release receipt.
 * Canonical registry/profile admission and the physical held-input bridge remain
 * with their existing owners; this adapter computes no fingerprint or aggregate.
 *
 * @param {object} input Explicit identity, authority, attempt, evidence and expected inputs.
 * @returns {object} Verified producer semantic outcome candidate.
 */
export function adaptReleaseReliabilitySemanticOutcome(input)
{
    data(input);
    const { identity, inputAuthorityRefs, attemptEligibility, evidence, expected } = input;
    require(expected && evidence && expected.receiptDigests && expected.isolationDigests
        && expected.lifecycleByScenario, 'independent held inputs are required');
    equal(identity, expected.identity, 'candidate identity');
    require(identity.producerId === releaseReliabilityOutcomeProducerId, 'producer identity mismatch');
    equal(evidence.binding, expected.binding, 'run/source/build/runtime/attempt binding');
    equal(evidence.binding.identity, identity, 'evidence execution identity');
    require(bindingFields.every(field => field === 'invocationId'
        ? typeof evidence.binding[field] === 'string' && evidence.binding[field].length > 0
        : digestPattern.test(evidence.binding[field])), 'run binding is incomplete');
    equal(evidence.binding.attemptDigest, attemptEligibility.attemptDigest, 'attempt digest');
    equal(inputAuthorityRefs, expected.inputAuthorityRefs, 'authority references');
    require(inputAuthorityRefs.some(reference => reference.kind === 'reliability-terminal-verification'
        && reference.digest === expected.verificationReceiptDigest), 'independent terminal verification is missing');
    equal(exactIds(catalog.canonicalScenarioIds, 'catalog scenarios'), releaseReliabilityScenarioIds, 'canonical catalog');
    exactMembers(evidence.scenarioResults, 'scenario results');
    exactMembers(evidence.members, 'semantic members');
    exactMap(expected.resultDigests, releaseReliabilityScenarioIds, 'expected result digests');
    exactMap(expected.memberDigests, releaseReliabilityScenarioIds, 'expected semantic digests');
    exactMap(expected.lifecycleByScenario, releaseReliabilityScenarioIds, 'expected lifecycle projections');
    exactMap(expected.isolationDigests, registry.actions.map(action => action.actionId), 'expected isolation digests');
    const timeline = evidence.timeline;
    sealed(timeline, expected.timelineDigest, 'terminal timeline');
    require(timeline.schema === 'fsusblog.release-reliability-timeline.v3'
        && timeline.status === 'complete', 'terminal timeline is not complete');
    equal(timeline.runId, identity.schedulerRunId, 'timeline run');
    equal(timeline.invocationId, evidence.binding.invocationId, 'timeline invocation');
    equal(timeline.identity, expected.runIdentityReference, 'timeline identity reference');
    exactMembers(timeline.terminalEvents, 'terminal events');
    exactMembers(timeline.scenarioResults, 'timeline result references');
    equal(timeline.terminalEvents, expected.terminalEvents, 'independently verified terminal events');
    const consumed = new Set();
    const reasons = [];
    const memberOutcomes = releaseReliabilityScenarioIds.map(scenarioId =>
    {
        const result = evidence.scenarioResults.find(item => item.scenarioId === scenarioId);
        const terminal = timeline.terminalEvents.find(item => item.scenarioId === scenarioId);
        const member = evidence.members.find(item => item.scenarioId === scenarioId);
        sealed(result, expected.resultDigests[scenarioId], `result ${scenarioId}`);
        equal(timeline.scenarioResults.find(item => item.scenarioId === scenarioId).resultContentDigest,
            result.contentDigest, 'timeline result seal');
        require(result.schema === 'fsusblog.release-reliability-scenario-result.v3'
            && terminalClasses.has(terminal.terminalClassification), 'result schema or terminal class is unknown');
        equal(result.runId, timeline.runId, 'result run');
        equal(result.invocationId, timeline.invocationId, 'result invocation');
        equal(result.identity, timeline.identity, 'result identity');
        equal(member.binding, evidence.binding, 'member binding');
        equal(digestCanonical(member), expected.memberDigests[scenarioId], 'independent semantic member');
        require(typeof terminal.producerSpawned === 'boolean', 'producer execution state is missing');
        equal(result.producerSpawned, terminal.producerSpawned, 'producer execution state');
        const classification = terminal.terminalClassification;
        require([...phases, 'admission', 'not-reached'].includes(terminal.reachedPhase), 'unknown reached phase');
        require(result.producerSpawned || result.authoritativeEvidence === null,
            'unspawned producer has authoritative evidence');
        const unspawned = ['precondition-failure', 'not-reached'].includes(classification);
        require(!unspawned || !terminal.producerSpawned
            && result.authoritativeEvidence === null && terminal.authoritativeEvidence === null
            && member.semanticEvidence === null, 'unspawned member has authoritative measurement evidence');
        require(!['qualified-success', 'product-failure'].includes(classification)
            || terminal.producerSpawned && result.authoritativeEvidence && member.semanticEvidence,
        'successful or product-failed member lacks real measurement evidence');
        if (result.authoritativeEvidence)
        {
            equal(terminal.authoritativeEvidence, result.authoritativeEvidence, 'terminal evidence reference');
            verifyReference(result.authoritativeEvidence, expected.receiptDigests, consumed);
        }
        else
        {
            require(terminal.authoritativeEvidence === null && member.semanticEvidence === null,
                'member has orphan measurement evidence');
        }
        if (member.semanticEvidence)
        {
            equal(member.semanticEvidence.producerEvidenceDigest, result.authoritativeEvidence?.digest,
                'semantic evidence original producer digest');
            require(member.semanticEvidence.metrics !== undefined && member.semanticEvidence.state !== undefined
                && Array.isArray(member.semanticEvidence.assertions), 'semantic metrics/state/assertions are missing');
            const assertions = member.semanticEvidence.assertions;
            exactIds(assertions.map(assertion => assertion.assertionId), 'semantic assertions');
            require(assertions.length > 0
                && assertions.every(assertion => ['passed', 'failed'].includes(assertion.status)),
            'semantic assertion status is unknown or missing');
            if (classification === 'qualified-success')
            {
                require(result.status === 'passed' && result.evidenceClass === 'correctness'
                    && result.qualificationEligible === true && result.firstFailure === null
                    && result.cleanupFailures?.length === 0
                    && assertions.every(assertion => assertion.status === 'passed'),
                'qualified member is not passing correctness evidence');
            }
            if (classification === 'product-failure')
            {
                require(member.failures.every(failure => failure.kind !== 'product.assertion'
                    || assertions.some(assertion => assertion.assertionId === failure.identity?.assertionId
                        && assertion.status === 'failed')), 'product assertion failure lacks measured assertion');
            }
        }
        const lifecycleOutcome = lifecycle(result, terminal, member, expected, consumed);
        const memberReasons = failures(member, terminal, identity, attemptEligibility);
        reasons.push(...memberReasons);
        const semantic = member.semanticEvidence;
        const assertions = semantic?.assertions.map(assertion =>
        {
            for (const field of ['expectedDigest', 'actualDigest'])
            {
                require(assertion[field] === undefined || assertion[field] === null
                    || digestPattern.test(assertion[field]), 'assertion evidence content digest is invalid');
            }
            return { assertionId: assertion.assertionId, status: assertion.status,
                expectedDigest: assertion.expectedDigest ?? null, actualDigest: assertion.actualDigest ?? null };
        }).sort((left, right) => left.assertionId < right.assertionId ? -1 : left.assertionId > right.assertionId ? 1 : 0);
        const semanticEvidence = semantic ? { metricsDigest: digestCanonical(semantic.metrics),
            stateDigest: digestCanonical(semantic.state), assertions } : null;
        if (semanticEvidence)
        {
            semanticEvidence.contentDigest = digestCanonical(semanticEvidence);
        }
        return { scenarioId, planned: true, executed: terminal.producerSpawned,
            terminalClassification: classification, reachedPhase: terminal.reachedPhase,
            lifecycle: lifecycleOutcome, failureReasons: memberReasons,
            semanticEvidence };
    });
    equal([...consumed].sort(), Object.keys(expected.receiptDigests).sort(), 'exact receipt membership');
    if (attemptEligibility.attemptNumber !== 1 || !attemptEligibility.cleanFirstAttempt
        || attemptEligibility.firstFailure || !attemptEligibility.qualificationEligible)
    {
        reasons.push(reason('contract.identity', releaseReliabilityOutcomeProducerId,
            { identityField: 'attemptEligibility' }));
    }
    return candidate({ producerId: releaseReliabilityOutcomeProducerId,
        producerAuthorityId: releaseReliabilityOutcomeAuthorityId, identity, inputAuthorityRefs,
        attemptEligibility, membership: { scenarioIds: [...releaseReliabilityScenarioIds], memberOutcomes }, reasons });
}
