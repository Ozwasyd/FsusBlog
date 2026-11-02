import { types } from 'node:util';

import { candidate, exactIds, reason } from './adapter-support.mjs';
import { readOutcomeFailureTaxonomy, validateProducerSemanticOutcomeCandidate } from './outcome-contract.mjs';

const { digestCanonical, validateAggregateAttemptReceipt } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateCanonicalTestId, validateReplayPlan } = await import(new URL('../../test/execution-replay-contract.mjs', import.meta.url));
const { evidenceProjectionReceiptSchema, projectionContentDigest } = await import(new URL('../evidence-projection.mjs', import.meta.url));

export const backendTestOutcomeAuthorityId = 'tools/test-matrix/outcomes/backend-test-adapter.mjs';
export const backendCaseCatalogSchema = 'fsusblog.backend-outcome-case-binding.v1';
export const backendFrameworkReportSchema = 'fsusblog.backend-outcome-framework-observation.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const terminalStatuses = ['passed', 'failed', 'skipped', 'blocked'];

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(`backend outcome: ${message}`);
    }
}

function dataCopy(value)
{
    let nodes = 0;
    const active = new Set();
    function copy(item, depth)
    {
        requireCondition(++nodes <= 100000 && depth <= 64, 'input data budget exceeded');
        if (item === null || typeof item === 'boolean' || typeof item === 'string')
        {
            return item;
        }
        if (typeof item === 'number')
        {
            requireCondition(Number.isFinite(item), 'non-finite input');
            return item;
        }
        requireCondition(item && typeof item === 'object' && !types.isProxy(item), 'input must be plain data');
        requireCondition(!active.has(item), 'cyclic input');
        const array = Array.isArray(item);
        requireCondition(array || Object.getPrototypeOf(item) === Object.prototype
            || Object.getPrototypeOf(item) === null, 'input must be plain data');
        active.add(item);
        const descriptors = Object.getOwnPropertyDescriptors(item);
        requireCondition(Reflect.ownKeys(descriptors).every((key) => typeof key === 'string'), 'symbol input');
        const result = array ? [] : Object.create(null);
        for (const [key, descriptor] of Object.entries(descriptors))
        {
            if (array && key === 'length')
            {
                continue;
            }
            requireCondition(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'accessor/hidden input');
            if (array)
            {
                requireCondition(/^(0|[1-9][0-9]*)$/u.test(key), 'non-index array field');
            }
            Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
        }
        if (array)
        {
            requireCondition(result.length === item.length
            && Object.keys(result).length === item.length, 'sparse input');
        }
        active.delete(item);
        return result;
    }
    return copy(value, 0);
}

function keys(value, fields, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()), `${label} fields mismatch`);
}

function text(value, label)
{
    requireCondition(typeof value === 'string' && value.length > 0 && value.trim() === value, `${label} is missing`);
    return value;
}

function digest(value, label)
{
    requireCondition(typeof value === 'string' && digestPattern.test(value), `${label} digest is invalid`);
    return value;
}

function same(actual, expected, label)
{
    requireCondition(digestCanonical(actual) === digestCanonical(expected), `${label} mismatch`);
}

function sealed(document, schema, identity, label)
{
    requireCondition(document.schema === schema, `${label} schema mismatch`);
    const unsigned = { ...document };
    delete unsigned.contentDigest;
    same(document.contentDigest, digestCanonical(unsigned), `${label} content seal`);
    same(document.identity, identity, `${label} identity`);
}

function relativePath(value)
{
    text(value, 'evidence path');
    requireCondition(!value.includes('\\') && !value.startsWith('/')
        && !value.includes(':') && value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'evidence path must be relative and contained');
}

function boundReference(reference, attempt)
{
    keys(reference, ['id', 'path', 'digest'], 'evidence reference');
    text(reference.id, 'evidence ID');
    relativePath(reference.path);
    digest(reference.digest, 'evidence');
    requireCondition(attempt.artifactDigests[reference.path] === reference.digest,
        'evidence reference is not held by this attempt');
}

function caseBinding(binding, testId)
{
    keys(binding, ['kind', 'id'], 'case binding');
    requireCondition(['fact', 'parameterized', 'property', 'model', 'fuzz'].includes(binding.kind), 'unknown case kind');
    text(binding.id, 'stable case ID');
    validateCanonicalTestId(testId);
    const suffix = /\?case=(parameterized|property|fuzz):(.+)$/u.exec(testId);
    if (binding.kind === 'parameterized')
    {
        requireCondition(suffix?.[1] === 'parameterized' && decodeURIComponent(suffix[2]) === binding.id,
            'parameterized case must use the sealed framework unique ID');
    }
    else if (suffix)
    {
        const kind = binding.kind === 'model' ? 'property' : binding.kind;
        requireCondition(suffix[1] === kind && decodeURIComponent(suffix[2]) === binding.id, 'case ID crosses sealed test ID');
    }
}

function canonicalFailure(failure, binding, evidenceById, taxonomy, identity, attempt)
{
    keys(failure, ['class', 'kind', 'identity', 'diagnosticEvidenceId', 'semanticArtifactIds', 'stateIds'], 'failure');
    const rule = taxonomy.get(failure.kind);
    requireCondition(rule && failure.class === failure.kind.split('.')[0], 'unknown canonical failure class/kind');
    const expected = { ...binding, producerId: identity.producerId };
    const requiredFields = [...new Set([...Object.keys(expected), ...rule.requiredIdentity])];
    keys(failure.identity, requiredFields, 'failure identity');
    for (const field of requiredFields)
    {
        const expectedValue = Object.hasOwn(expected, field) ? expected[field]
            : field === 'attemptNumber' ? attempt.attemptNumber
            : field === 'evidenceId' ? failure.diagnosticEvidenceId : identity[field];
        if (expectedValue !== undefined)
        {
            requireCondition(failure.identity[field] === expectedValue, `failure identity crosses ${field}`);
        }
        else
        {
            text(failure.identity[field], `failure identity ${field}`);
            if (field.endsWith('Digest'))
            {
                digest(failure.identity[field], `failure identity ${field}`);
            }
            if (field === 'semanticId')
            {
                requireCondition([...failure.semanticArtifactIds, ...failure.stateIds]
                    .includes(failure.identity[field]), 'failure semantic identity lacks an applicable reference');
            }
            if (field === 'identityField')
            {
                requireCondition(Object.hasOwn(identity, failure.identity[field]), 'unknown failure identity field');
            }
        }
    }
    requireCondition(evidenceById.has(failure.diagnosticEvidenceId), 'failure diagnostic evidence is missing');
    exactIds(failure.semanticArtifactIds, 'failure semantic artifacts');
    exactIds(failure.stateIds, 'failure state IDs');
    return reason(failure.kind, identity.producerId, failure.identity, {
        failureClass: failure.class,
        diagnosticEvidenceId: failure.diagnosticEvidenceId,
        semanticArtifactIds: failure.semanticArtifactIds,
        stateIds: failure.stateIds
    });
}

/**
 * Adapt independently held backend observations to the original candidate-v1 contract.
 * The external callbacks are required capabilities, never inferred from report flags.
 * Failed first correctness attempts retain topology but remain qualification-ineligible.
 * This function neither executes tests nor computes an outcome fingerprint.
 */
export function adaptBackendTestSemanticOutcome({
    identity, plan, catalog, report, attempt, aggregateAttempt, inputAuthorityRefs,
    verifyAuthority, verifyArtifact, verifyBackendEvidence, projectionReceipt = null
})
{
    ({ identity, plan, catalog, report, attempt, aggregateAttempt, inputAuthorityRefs, projectionReceipt } = dataCopy({
        identity, plan, catalog, report, attempt, aggregateAttempt, inputAuthorityRefs, projectionReceipt
    }));
    digest(identity.buildIdentity, 'build identity');
    validateReplayPlan(plan);
    requireCondition(['xunit', 'property', 'model', 'fuzz'].includes(plan.producer.framework), 'unsupported backend framework');
    requireCondition(plan.run.mode === 'qualification', 'diagnostic replay plan is unqualified');
    same(plan.source, { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint }, 'plan source');
    requireCondition(plan.producer.id === identity.producerId && plan.run.id === identity.schedulerRunId
        && plan.planDigest === identity.replayPlanDigest, 'plan producer/run/digest identity mismatch');
    requireCondition(typeof verifyArtifact === 'function' && typeof verifyBackendEvidence === 'function',
        'independent artifact/backend evidence verification is required');
    const aggregate = validateAggregateAttemptReceipt(aggregateAttempt, {
        loadAttempt: () => attempt, verifyAuthority, verifyArtifact
    });
    requireCondition(aggregate.policy.classification === 'correctness' && aggregate.attempts.length === 1
        && attempt.attemptNumber === 1, 'unqualified/recovered attempt');
    for (const field of ['producerId', 'schedulerRunId', 'sourceCommit', 'worktreeFingerprint',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        requireCondition(attempt[field] === identity[field], `attempt crosses ${field}`);
    }
    requireCondition(attempt.status !== 'clean-success' || aggregate.qualificationEligible === true,
        'successful attempt is unqualified');
    keys(catalog, ['schema', 'identity', 'policyDigests', 'tests', 'contentDigest'], 'catalog');
    keys(report, ['schema', 'identity', 'attemptDigest', 'catalogDigest', 'frameworkStatus',
        'tests', 'evidenceRefs', 'artifactSemanticDigests', 'stateSemanticDigests', 'terminalFailure', 'contentDigest'], 'report');
    sealed(catalog, backendCaseCatalogSchema, identity, 'catalog');
    sealed(report, backendFrameworkReportSchema, identity, 'report');
    requireCondition(report.attemptDigest === attempt.contentDigest && report.catalogDigest === catalog.contentDigest,
        'report attempt/catalog reference mismatch');
    keys(catalog.policyDigests, ['retryPolicyDigest', 'failureTaxonomyDigest', 'projectionPolicyDigest'], 'policy digests');
    if (catalog.policyDigests.projectionPolicyDigest !== null)
    {
        digest(catalog.policyDigests.projectionPolicyDigest, 'projection policy');
    }
    const taxonomy = readOutcomeFailureTaxonomy();
    same(catalog.policyDigests.retryPolicyDigest, digestCanonical(aggregate.policy), 'retry policy');
    same(catalog.policyDigests.failureTaxonomyDigest, digestCanonical([...taxonomy.values()]), 'failure taxonomy');
    const plannedTestIds = exactIds(plan.testEnumerationOrder, 'planned tests');
    requireCondition(Array.isArray(catalog.tests) && Array.isArray(report.tests) && Array.isArray(report.evidenceRefs),
        'catalog/report arrays are required');
    same(exactIds(catalog.tests.map((entry) => entry.testId), 'catalog tests'), plannedTestIds, 'catalog planned membership');
    same(exactIds(report.tests.map((entry) => entry.testId), 'actual tests'), plannedTestIds, 'report planned membership');
    const evidenceById = new Map();
    for (const reference of report.evidenceRefs)
    {
        boundReference(reference, attempt);
        requireCondition(!evidenceById.has(reference.id), 'duplicate evidence ID');
        evidenceById.set(reference.id, reference);
    }
    const attemptRef = inputAuthorityRefs.find((reference) => reference.kind === 'attempt');
    requireCondition(attemptRef?.path === aggregateAttempt.attempts[0].path, 'aggregate/attempt location mismatch');
    const inputDigests = {
        'replay-plan': plan.planDigest, 'backend-catalog': catalog.contentDigest,
        'backend-report': report.contentDigest, attempt: attempt.contentDigest,
        'aggregate-attempt': aggregateAttempt.contentDigest,
        ...(projectionReceipt ? { 'evidence-projection': projectionReceipt.contentDigest } : {})
    };
    requireCondition(Array.isArray(inputAuthorityRefs), 'input references are required');
    same(exactIds(inputAuthorityRefs.map((reference) => reference.kind), 'input reference kinds'),
        Object.keys(inputDigests).sort(), 'input reference roster');
    for (const reference of inputAuthorityRefs)
    {
        keys(reference, ['kind', 'path', 'digest'], 'input reference');
        relativePath(reference.path);
        requireCondition(reference.digest === inputDigests[reference.kind], 'input reference digest mismatch');
    }
    // The verifier belongs to the execution/evidence owner and must reopen held inputs.
    const verification = dataCopy(verifyBackendEvidence({ identity, inputAuthorityRefs }));
    keys(verification, ['verified', 'identity', 'inputAuthorityRefs', 'verificationReceipt'], 'backend verification');
    requireCondition(verification.verified === true, 'backend evidence was not independently verified');
    same(verification.identity, identity, 'held evidence identity');
    same(verification.inputAuthorityRefs, inputAuthorityRefs, 'held input references');
    keys(verification.verificationReceipt, ['path', 'digest'], 'backend verification receipt');
    relativePath(verification.verificationReceipt.path);
    digest(verification.verificationReceipt.digest, 'backend verification receipt');
    const membership = {
        plannedTestIds, executedTestIds: [], passedTestIds: [], failedTestIds: [], skippedTestIds: [], blockedTestIds: [],
        assertions: [], caseIdentities: [], coverageIds: [], artifactSemanticDigests: {}, stateSemanticDigests: {},
        policyDigests: catalog.policyDigests, projectionReceipts: []
    };
    const reasons = [];
    const coverageIds = new Set();
    const artifactIds = new Set();
    const stateIds = new Set();
    const catalogByTest = new Map(catalog.tests.map((entry) => [entry.testId, entry]));
    for (const observation of report.tests)
    {
        keys(observation, ['testId', 'caseBinding', 'status', 'cases', 'assertions', 'coverageIds',
            'artifactIds', 'stateIds', 'evidenceId'], 'test observation');
        const binding = catalogByTest.get(observation.testId);
        keys(binding, ['testId', 'caseBinding', 'assertionIds', 'coverageIds', 'artifactIds', 'stateIds'], 'planned case');
        caseBinding(binding.caseBinding, binding.testId);
        same(observation.caseBinding, binding.caseBinding, 'framework case binding');
        requireCondition(terminalStatuses.includes(observation.status), 'unknown terminal test status');
        requireCondition(evidenceById.has(observation.evidenceId), 'test evidence is missing');
        for (const field of ['assertionIds', 'coverageIds', 'artifactIds', 'stateIds'])
        {
            exactIds(binding[field], `planned ${field}`);
        }
        for (const field of ['coverageIds', 'artifactIds', 'stateIds'])
        {
            same(exactIds(observation[field], `observed ${field}`), exactIds(binding[field], `planned ${field}`), `applicable ${field}`);
        }
        observation.coverageIds.forEach((id) => coverageIds.add(id));
        observation.artifactIds.forEach((id) => artifactIds.add(id));
        observation.stateIds.forEach((id) => stateIds.add(id));
        membership[`${observation.status}TestIds`].push(observation.testId);
        const executed = ['passed', 'failed'].includes(observation.status);
        if (executed)
        {
            membership.executedTestIds.push(observation.testId);
        }
        requireCondition(Array.isArray(observation.cases) && Array.isArray(observation.assertions), 'cases/assertions must be explicit arrays');
        const caseIds = exactIds(observation.cases.map((entry) => entry.caseId), 'observed case IDs');
        requireCondition(executed ? caseIds.length > 0 : caseIds.length === 0 && observation.assertions.length === 0,
            'terminal state/case execution mismatch');
        for (const observedCase of observation.cases)
        {
            keys(observedCase, ['caseId', 'inputDigest', 'shrinkSequenceIdentity', 'transitionIds'], 'observed case');
            text(observedCase.caseId, 'case ID');
            const randomized = ['property', 'model', 'fuzz'].includes(binding.caseBinding.kind);
            if (randomized)
            {
                digest(observedCase.inputDigest, 'randomized case input');
            }
            else
            {
                requireCondition(observedCase.caseId === binding.caseBinding.id && observedCase.inputDigest === null
                && observedCase.shrinkSequenceIdentity === null, 'xUnit case identity mismatch');
            }
            if (observedCase.shrinkSequenceIdentity !== null)
            {
                digest(observedCase.shrinkSequenceIdentity, 'shrink sequence');
            }
            exactIds(observedCase.transitionIds, 'model transitions');
            requireCondition(binding.caseBinding.kind === 'model' || observedCase.transitionIds.length === 0, 'non-model transitions');
            membership.caseIdentities.push({ testId: observation.testId, ...observedCase });
        }
        const assertionKeys = new Set();
        let failedAssertions = 0;
        for (const assertion of observation.assertions)
        {
            keys(assertion, ['id', 'caseId', 'status', 'evidenceId', 'failure'], 'assertion');
            const assertionKey = JSON.stringify([assertion.caseId, assertion.id]);
            requireCondition(!assertionKeys.has(assertionKey), 'duplicate case/assertion identity');
            assertionKeys.add(assertionKey);
            requireCondition(binding.assertionIds.includes(assertion.id) && caseIds.includes(assertion.caseId), 'extra assertion or unknown case ID');
            requireCondition(evidenceById.has(assertion.evidenceId), 'assertion evidence is missing');
            requireCondition(['passed', 'failed'].includes(assertion.status), 'unknown assertion status');
            const failureBinding = { testId: observation.testId, caseId: assertion.caseId, assertionId: assertion.id };
            membership.assertions.push({ ...failureBinding, status: assertion.status, evidenceId: assertion.evidenceId });
            if (assertion.status === 'failed')
            {
                failedAssertions += 1;
                const failure = canonicalFailure(assertion.failure, failureBinding, evidenceById, taxonomy, identity, attempt);
                requireCondition(assertion.failure.semanticArtifactIds.every((id) => binding.artifactIds.includes(id))
                    && assertion.failure.stateIds.every((id) => binding.stateIds.includes(id)), 'failure semantic reference is inapplicable');
                reasons.push(failure);
            }
            else
            {
                requireCondition(assertion.failure === null, 'passing assertion has a failure');
            }
        }
        if (observation.status === 'passed')
        {
            requireCondition(failedAssertions === 0 && binding.assertionIds.length > 0, 'passed test lacks passing assertions');
            for (const caseId of caseIds)
            {
                same(exactIds(observation.assertions.filter((entry) => entry.caseId === caseId).map((entry) => entry.id), 'case assertions'),
                    exactIds(binding.assertionIds, 'planned assertions'), 'passed assertion membership');
            }
        }
        else if (observation.status === 'failed')
        {
            requireCondition(failedAssertions > 0, 'failed test lacks assertion/failure evidence');
            requireCondition(caseIds.every((caseId) => observation.assertions.some((entry) => entry.caseId === caseId)),
                'executed case lacks assertion evidence');
        }
        else
        {
            reasons.push(reason('contract.missing-evidence', identity.producerId,
                { testId: observation.testId, evidenceId: observation.evidenceId }));
        }
    }
    for (const field of ['executedTestIds', 'passedTestIds', 'failedTestIds', 'skippedTestIds', 'blockedTestIds'])
    {
        membership[field].sort();
    }
    membership.assertions.sort((left, right) => Buffer.compare(Buffer.from(JSON.stringify(left), 'utf8'), Buffer.from(JSON.stringify(right), 'utf8')));
    membership.caseIdentities.sort((left, right) => Buffer.compare(Buffer.from(JSON.stringify(left), 'utf8'), Buffer.from(JSON.stringify(right), 'utf8')));
    membership.coverageIds = [...coverageIds].sort();
    for (const [field, ids] of [['artifactSemanticDigests', artifactIds], ['stateSemanticDigests', stateIds]])
    {
        keys(report[field], [...ids], field);
        for (const id of [...ids].sort())
        {
            Object.defineProperty(membership[field], id, { value: digest(report[field][id], `${field}.${id}`), enumerable: true });
        }
    }
    same(attempt.executedTestIds, membership.executedTestIds, 'attempt executed membership');
    same(attempt.failedTestIds, membership.failedTestIds, 'attempt failed membership');
    requireCondition(['completed', 'crashed'].includes(report.frameworkStatus), 'unknown framework completion state');
    if (report.frameworkStatus === 'crashed')
    {
        requireCondition(attempt.status !== 'clean-success' && report.terminalFailure !== null, 'crash lacks terminal evidence');
        const failure = canonicalFailure(report.terminalFailure, {}, evidenceById, taxonomy, identity, attempt);
        requireCondition(report.terminalFailure.class === 'infra'
            && report.terminalFailure.kind === attempt.failureKind && report.terminalFailure.class === attempt.failureClass,
        'crash failure disagrees with attempt taxonomy');
        requireCondition(report.terminalFailure.semanticArtifactIds.every((id) => artifactIds.has(id))
            && report.terminalFailure.stateIds.every((id) => stateIds.has(id)), 'terminal failure semantic reference is inapplicable');
        reasons.push(failure);
    }
    else
    {
        requireCondition(report.terminalFailure === null && membership.blockedTestIds.length === 0,
            'partial/completed report lacks crash evidence');
    }
    if (attempt.status === 'clean-success')
    {
        requireCondition(reasons.length === 0, 'clean attempt/report topology mismatch');
    }
    else
    {
        requireCondition(reasons.length > 0, 'failed attempt has no semantic failure');
        requireCondition(reasons.some((failure) => failure.kind === attempt.failureKind
            && failure.kind.split('.')[0] === attempt.failureClass), 'attempt canonical failure disagrees with report');
    }
    if (projectionReceipt !== null)
    {
        requireCondition(reasons.length === 0, 'success-only projection cannot certify failed tests');
        requireCondition(projectionReceipt.schema === evidenceProjectionReceiptSchema
            && projectionReceipt.status === 'success' && projectionReceipt.executionMode === 'projection'
            && projectionReceipt.contentDigest === projectionContentDigest(projectionReceipt), 'projection receipt tamper/schema');
        same(projectionReceipt.sourceState, {
            commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint.slice(7)
        }, 'projection source');
        requireCondition(projectionReceipt.runId === identity.schedulerRunId
            && projectionReceipt.executionOwner === identity.producerId && projectionReceipt.projectFrom === identity.producerId,
        'projection producer/run mismatch');
        requireCondition(projectionReceipt.buildIdentity === identity.buildIdentity, 'projection build mismatch');
        requireCondition(projectionReceipt.policyIdentity === catalog.policyDigests.projectionPolicyDigest, 'projection policy mismatch');
        same(exactIds(projectionReceipt.testIds, 'projection tests'), plannedTestIds, 'projection membership');
        same(exactIds(projectionReceipt.coverageIds, 'projection coverage'), membership.coverageIds, 'projection coverage');
        membership.projectionReceipts.push({ projectionId: text(projectionReceipt.tierId, 'projection ID'),
            receiptDigest: projectionReceipt.contentDigest });
    }
    const attemptEligibility = {
        aggregateDigest: aggregateAttempt.contentDigest, attemptDigest: attempt.contentDigest, attemptNumber: attempt.attemptNumber,
        cleanFirstAttempt: aggregate.cleanFirstAttempt, firstFailure: attempt.firstFailure, qualificationEligible: aggregate.qualificationEligible
    };
    return candidate({ producerId: identity.producerId, producerAuthorityId: backendTestOutcomeAuthorityId, identity,
        inputAuthorityRefs: [...inputAuthorityRefs, { kind: 'backend-evidence-verification',
            path: verification.verificationReceipt.path, digest: verification.verificationReceipt.digest }],
        attemptEligibility, membership, reasons });
}

/** Reopen all original held inputs and compare the entire expected candidate, including its evidence references. */
export function verifyBackendTestSemanticOutcomeCandidate(value, inputs)
{
    value = dataCopy(value);
    validateProducerSemanticOutcomeCandidate(value, { expectedProducerId: inputs.identity.producerId,
        expectedAuthorityId: backendTestOutcomeAuthorityId });
    const expected = adaptBackendTestSemanticOutcome(inputs);
    same(value, expected, 'candidate/held evidence');
    return value;
}
