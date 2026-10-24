import { exactIds, reason } from './adapter-support.mjs';
import { readOutcomeFailureTaxonomy } from './outcome-contract.mjs';

const { freezeDeep } = await import(new URL('../../test-fixtures/receipt/canonical.mjs', import.meta.url));
const { normalizeRuntimeIdentity } = await import(new URL('../../test-runtime/contract.mjs', import.meta.url));
const { validateRuntimeResetBarrierReceipt } = await import(new URL('../../test-runtime/reset-barrier.mjs', import.meta.url));
const { runtimeStepCatalogDigest, validateRuntimeSchedulePlan } = await import(
    new URL('../../test-runtime/schedule-plan.mjs', import.meta.url)
);
const { validateRuntimeStateSnapshot } = await import(new URL('../../test-runtime/state-snapshot.mjs', import.meta.url));

export const runtimeBundleOutcomeProducerId = 'runtime-bundle-semantic-outcome';
const terminalStatus = Object.freeze({
    success: 'passed', failed: 'failed', 'timed-out': 'failed', 'internal-error': 'failed',
    skipped: 'skipped', blocked: 'blocked', 'not-reached': 'not-reached', cancelled: 'cancelled'
});
const statuses = Object.freeze(['passed', 'failed', 'skipped', 'blocked', 'not-reached', 'cancelled']);

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`runtime outcome material: ${message}`);
    }
}

function records(values, label)
{
    require(Array.isArray(values), `${label} must be an array`);
    const ids = exactIds(values.map((value) => value?.id), label);
    return new Map(ids.map((id) => [id, values.find((value) => value.id === id)]));
}

function equalIds(left, right, label)
{
    require(JSON.stringify([...left].sort()) === JSON.stringify([...right].sort()), `${label} membership mismatch`);
}

function partition(entries)
{
    return Object.fromEntries(statuses.map((status) => [status,
        entries.filter((entry) => entry.status === status).map((entry) => entry.id).sort()]));
}

/**
 * Collect member-level DATA_ONLY material from explicit, encoded producer data.
 * Input: {plan, steps, authority, bundle, execution, assertions, artifacts}.
 * Host expectations: {identity, plan, assertions, correctnessArtifacts, finalStateDigest}.
 * Both plans are actual runtime-schedule-plan.v1 documents. Assertions are
 * {id, stepId, status}; artifacts are {id, disposition, digest}. The host provides
 * the independently held plan, assertion roster and correctness artifact roster.
 *
 * The caller must supply JSON text: byte admission precedes parse and reflection.
 * maxBytes is mandatory and bounds each encoded input; it is not execution policy.
 * Existing runtime owners verify plans, snapshots/fragments and reset receipts.
 * Failure kinds come from structured facts, never exception text or bundle status.
 * Output is detached/frozen and deliberately unverified: no source files, live
 * scheduler journal, artifact bytes, attempt receipts or locator are authenticated
 * here. Candidate publication still needs the producer-owned held-input bridge
 * and a closed runtime disposition profile; no fingerprint or aggregate is built.
 */
export function collectRuntimeBundleOutcomeMaterial(encodedInput, encodedExpected, maxBytes)
{
    require(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'explicit host byte limit is required');
    for (const encoded of [encodedInput, encodedExpected])
    {
        require(typeof encoded === 'string' && encoded.length <= maxBytes
            && Buffer.byteLength(encoded, 'utf8') <= maxBytes, 'encoded data exceeds host byte limit or is not text');
    }
    const input = JSON.parse(encodedInput);
    const expected = JSON.parse(encodedExpected);
    const { plan, steps, authority, bundle, execution } = input;
    const identity = normalizeRuntimeIdentity(expected.identity);
    const actualIdentity = normalizeRuntimeIdentity(execution?.identity);
    // Clock/replay differences remain explicit drift facts below. Other identities
    // cannot be joined across a different run, attempt, session, source or build.
    for (const field of Object.keys(identity).filter((key) => !['clockDigest', 'replayDigest'].includes(key)))
    {
        require(actualIdentity[field] === identity[field], `execution identity mismatch: ${field}`);
    }
    require(bundle?.schema === 'fsusblog.local-production.bundle.v1'
        && bundle.physicalBundleId === 'runtime-browser' && bundle.schedulerRunId === identity.runId,
    'bundle identity/schema mismatch');
    require(execution.schema === 'fsusblog.production-runtime-order-execution.v1'
        && ['success', 'failed', 'partial', 'cancelled', 'blocked'].includes(execution.status),
    'execution schema/status mismatch');
    require(authority?.catalogDigest === identity.catalogDigest, 'state catalog identity mismatch');
    validateRuntimeSchedulePlan(plan, { steps, expected: {
        runtimeStepCatalogDigest: runtimeStepCatalogDigest(steps), stateCatalogDigest: authority.catalogDigest
    } });
    validateRuntimeSchedulePlan(expected.plan, { steps, expected: {
        runtimeStepCatalogDigest: runtimeStepCatalogDigest(steps), stateCatalogDigest: authority.catalogDigest,
        clockDigest: identity.clockDigest, replayDigest: identity.replayDigest, envelopeDigest: identity.envelopeDigest
    } });
    require(execution.planDigest === plan.contentDigest && execution.planId === plan.planId,
        'execution is cross-plan');
    const failures = [];
    const add = (kind, facts) => failures.push(reason(kind, runtimeBundleOutcomeProducerId, facts));
    if (plan.seed !== expected.plan.seed)
    {
        add('determinism.seed-drift', { replayPlanDigest: identity.replayDigest });
    }
    if (plan.clockDigest !== identity.clockDigest || actualIdentity.clockDigest !== identity.clockDigest)
    {
        add('determinism.clock-drift', { temporalContextDigest: identity.clockDigest });
    }
    if (plan.contentDigest !== expected.plan.contentDigest || actualIdentity.replayDigest !== identity.replayDigest)
    {
        add('determinism.execution-plan-drift', { replayPlanDigest: identity.replayDigest });
    }
    if (plan.envelopeDigest !== identity.envelopeDigest)
    {
        add('infra.environment-mismatch', { executionEnvelopeDigest: identity.envelopeDigest });
    }
    const planned = exactIds(plan.orderedStepIds, 'planned steps');
    const executed = exactIds(execution.executedStepIds, 'executed steps');
    require(executed.every((id) => planned.includes(id)), 'extra executed step');
    const receipts = bundle.schedulerTerminalReceipts;
    require(receipts && typeof receipts === 'object' && !Array.isArray(receipts), 'terminal receipts missing');
    equalIds(Object.keys(receipts), exactIds(bundle.schedulerTerminalReceiptIds, 'terminal receipt IDs'), 'terminal receipts');
    require(Object.keys(receipts).every((id) => planned.includes(id)), 'extra terminal step');
    const stepOutcomes = planned.map((id) =>
    {
        const receipt = receipts[id];
        if (!receipt)
        {
            require(!executed.includes(id) && execution.status !== 'success', `missing terminal receipt: ${id}`);
            return { id, status: 'not-reached', executed: false, blockerIds: [] };
        }
        require(receipt.schema === 'fsusblog.scheduler.terminal-receipt.v1' && receipt.stepId === id,
            `terminal receipt identity mismatch: ${id}`);
        const status = terminalStatus[receipt.terminalState];
        require(status !== undefined, `unknown terminal state: ${id}`);
        require(!['passed', 'failed'].includes(status) || executed.includes(id), `terminal execution missing: ${id}`);
        require(!['blocked', 'skipped', 'not-reached'].includes(status) || !executed.includes(id),
            `unexecuted terminal has execution: ${id}`);
        const blockerIds = status === 'blocked' ? exactIds(receipt.primaryFailureRefs, 'terminal blockers') : [];
        require(blockerIds.every((blocker) => planned.includes(blocker)), `unknown blocker: ${id}`);
        require(status !== 'blocked' || blockerIds.length > 0, `blocked step lacks blocker: ${id}`);
        return { id, status, executed: executed.includes(id), blockerIds };
    });
    const plannedAssertions = records(expected.assertions, 'planned assertions');
    const assertions = records(input.assertions, 'actual assertions');
    equalIds(assertions.keys(), plannedAssertions.keys(), 'assertions');
    const assertionOutcomes = [...assertions.values()].map((entry) =>
    {
        require(entry.stepId === plannedAssertions.get(entry.id).stepId && planned.includes(entry.stepId),
            `assertion step mismatch: ${entry.id}`);
        require(statuses.includes(entry.status), `unknown assertion status: ${entry.id}`);
        const step = stepOutcomes.find((item) => item.id === entry.stepId);
        require(!['passed', 'failed'].includes(entry.status) || step.executed, `assertion was not executed: ${entry.id}`);
        require(!['blocked', 'skipped', 'not-reached'].includes(step.status) || entry.status === step.status,
            `assertion conceals unexecuted step: ${entry.id}`);
        if (entry.status === 'failed')
        {
            add('product.assertion', { assertionId: entry.id });
        }
        return { id: entry.id, stepId: entry.stepId, status: entry.status };
    }).sort((left, right) => left.id.localeCompare(right.id));
    equalIds(assertionOutcomes.filter((entry) => ['passed', 'failed'].includes(entry.status)).map((entry) => entry.id),
        exactIds(execution.executedAssertionIds, 'executed assertions'), 'executed assertions');
    const stateDigests = [];
    const boundaryKeys = new Set();
    const captures = execution.boundarySnapshots;
    require(Array.isArray(captures), 'state captures missing');
    for (const capture of captures)
    {
        require(Array.isArray(capture.fragments), 'state fragments missing');
        validateRuntimeStateSnapshot(capture.snapshot, { authority, identity: actualIdentity, fragments: capture.fragments });
        const snapshot = capture.snapshot;
        equalIds(snapshot.domains, authority.accessedDomains, 'state domains');
        equalIds(capture.fragments.map((fragment) => fragment.fragmentDigest), snapshot.fragments.map((ref) => ref.fragmentDigest),
            'state fragment references');
        const key = `${snapshot.boundary}:${snapshot.stepId ?? ''}`;
        require(!boundaryKeys.has(key), 'duplicate state boundary');
        boundaryKeys.add(key);
        require(snapshot.stepId === null || executed.includes(snapshot.stepId), 'state boundary belongs to unexecuted step');
        stateDigests.push({ boundary: snapshot.boundary, stepId: snapshot.stepId, digest: snapshot.semanticDigest });
    }
    const requiredBoundaries = ['before-runtime:'];
    for (const id of executed)
    {
        require(authority.steps?.[id], `step is absent from state authority: ${id}`);
        if (['writes', 'creates', 'deletes', 'invalidates'].some((field) => authority.steps[id][field]?.length))
        {
            requiredBoundaries.push(`before-mutating-step:${id}`, `after-mutating-step:${id}`);
        }
    }
    if (execution.status === 'success')
    {
        requiredBoundaries.push('after-runtime:');
    }
    for (const key of requiredBoundaries)
    {
        require(boundaryKeys.has(key), `missing state boundary: ${key}`);
    }
    const finalCapture = captures.find((capture) => capture.snapshot.boundary === 'after-runtime');
    if (finalCapture)
    {
        require(execution.finalSnapshot?.snapshotDigest === finalCapture.snapshot.snapshotDigest,
            'final state is not after-runtime');
        validateRuntimeStateSnapshot(execution.finalSnapshot, { authority, identity: actualIdentity,
            fragments: execution.finalFragments });
    }
    require(expected.finalStateDigest === null || /^sha256:[a-f0-9]{64}$/u.test(expected.finalStateDigest),
        'explicit expected final state digest or null is required');
    if (finalCapture && expected.finalStateDigest !== null
        && finalCapture.snapshot.semanticDigest !== expected.finalStateDigest)
    {
        add('product.state-mismatch', { semanticId: 'after-runtime' });
    }
    const resetKeys = [];
    const resets = execution.resetReceipts;
    require(Array.isArray(resets), 'reset receipts missing');
    const postconditions = [];
    require(execution.postconditions && typeof execution.postconditions === 'object'
        && !Array.isArray(execution.postconditions), 'step postconditions missing');
    equalIds(Object.keys(execution.postconditions), executed, 'step postconditions');
    for (const id of executed)
    {
        const observation = execution.postconditions[id];
        const declared = exactIds(authority.steps[id].postconditions ?? [], 'catalog postconditions');
        equalIds(exactIds(observation.declared, 'observed postconditions'), declared, 'declared postconditions');
        require(['satisfied', 'failed'].includes(observation.status), 'unknown step postcondition status');
        for (const postconditionId of declared)
        {
            if (observation.status === 'failed')
            {
                add('product.state-mismatch', { semanticId: postconditionId });
            }
            postconditions.push({ stepId: id, id: postconditionId, status: observation.status });
        }
    }
    for (const receipt of resets)
    {
        const barrier = receipt.barrier;
        const declared = authority.steps?.[barrier?.consumerStepId]?.[barrier?.phase]?.find((reset) =>
            reset.assertionId === barrier.assertionId && reset.producer === barrier.producerStepId);
        require(declared && declared.postcondition === barrier.expectedPostcondition, 'reset is not catalog-declared');
        const beforeCapture = captures.find((capture) => capture.snapshot.snapshotDigest === receipt.beforeSnapshotDigest);
        const afterCapture = captures.find((capture) => capture.snapshot.snapshotDigest === receipt.afterSnapshotDigest);
        require(beforeCapture && afterCapture, 'reset state references missing');
        validateRuntimeResetBarrierReceipt(receipt, { authority, identity: actualIdentity, beforeCapture, afterCapture });
        const key = `${barrier.consumerStepId}:${barrier.phase}:${barrier.assertionId}`;
        require(!resetKeys.includes(key), 'duplicate reset receipt');
        resetKeys.push(key);
        require(Array.isArray(receipt.postconditionResults) && receipt.postconditionResults.length > 0,
            'reset postcondition results missing');
        equalIds(receipt.postconditionResults.map((entry) => entry.domain), barrier.domains, 'reset postcondition domains');
        for (const result of receipt.postconditionResults)
        {
            require(['satisfied', 'failed'].includes(result.status)
                && /^sha256:[a-f0-9]{64}$/u.test(result.observationDigest), 'reset postcondition status/digest missing');
            if (result.status !== 'satisfied')
            {
                add('product.state-mismatch', { semanticId: result.domain });
            }
            postconditions.push({ stepId: barrier.consumerStepId, id: declared.postcondition, domain: result.domain,
                status: result.status, observationDigest: result.observationDigest });
        }
    }
    const requiredResets = executed.flatMap((id) => ['resetBefore', 'resetAfter'].flatMap((phase) =>
        (authority.steps[id][phase] ?? []).map((reset) => `${id}:${phase}:${reset.assertionId}`)));
    equalIds(resetKeys, requiredResets, 'reset receipts');
    const artifacts = records(input.artifacts, 'artifacts');
    const expectedArtifacts = records(expected.correctnessArtifacts, 'expected correctness artifacts');
    const correctnessIds = [...expectedArtifacts.keys()];
    equalIds([...artifacts.values()].filter((entry) => entry.disposition === 'correctness').map((entry) => entry.id),
        correctnessIds, 'correctness artifacts');
    const artifactDigests = [];
    for (const artifact of artifacts.values())
    {
        require(['correctness', 'diagnostic'].includes(artifact.disposition), 'unknown artifact disposition');
        require(/^sha256:[a-f0-9]{64}$/u.test(artifact.digest), 'invalid artifact digest');
        if (artifact.disposition === 'correctness')
        {
            require(artifact.digest === expectedArtifacts.get(artifact.id).digest, 'correctness artifact reference drift');
            artifactDigests.push({ id: artifact.id, digest: artifact.digest });
        }
    }
    const taxonomyKinds = readOutcomeFailureTaxonomy();
    require(Array.isArray(execution.failures ?? []), 'structured failures must be an array');
    for (const failure of execution.failures ?? [])
    {
        const taxonomy = taxonomyKinds.get(failure.kind);
        require(taxonomy && taxonomy.requiredIdentity.every((field) => failure.identity?.[field] !== undefined)
            && failure.identity.producerId === runtimeBundleOutcomeProducerId, 'unknown or incomplete structured failure');
        require(failure.identity.testId === undefined || plannedAssertions.has(failure.identity.testId),
            'failure refers to an unplanned assertion');
        require(failure.identity.assertionId === undefined || plannedAssertions.has(failure.identity.assertionId),
            'failure refers to an unplanned assertion');
        failures.push(reason(failure.kind, runtimeBundleOutcomeProducerId, failure.identity));
    }
    const successful = execution.status === 'success' && failures.length === 0
        && stepOutcomes.every((entry) => entry.status === 'passed')
        && assertionOutcomes.every((entry) => entry.status === 'passed');
    return freezeDeep({
        dataOnly: true, producerVerificationPending: true, qualificationEligible: false,
        producerId: runtimeBundleOutcomeProducerId, identity, observedIdentity: actualIdentity,
        planDigest: plan.contentDigest, expectedPlanDigest: expected.plan.contentDigest,
        status: successful ? 'success' : execution.status === 'success' ? 'failed' : execution.status,
        stepOutcomes, stepSets: { planned, executed, ...partition(stepOutcomes) },
        assertionOutcomes, assertionSets: partition(assertionOutcomes),
        stateDigests, postconditions, artifactDigests, failures,
        inputReferences: {
            planDigest: plan.contentDigest,
            snapshotDigests: captures.map((capture) => capture.snapshot.snapshotDigest),
            resetReceiptDigests: resets.map((receipt) => receipt.receiptDigest)
        }
    });
}
