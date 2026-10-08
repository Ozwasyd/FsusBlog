import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, sealContentDigest, sha256, validateAttemptReceipt } from './attempt-provenance.mjs';
import { backendAtomicDigest, backendAtomicExactFields, validateBackendAtomicPlan, verifyBackendAtomicSourceRefs } from './backend-atomic-producers.mjs';

export const backendAtomicSummarySchema = 'fsusblog.backend-atomic-summary-candidate.v1';

function same(actual, expected, label)
{
    if (canonicalJson(actual) !== canonicalJson(expected))
    {
        throw new Error(`${label} mismatch`);
    }
}

function regularBytes(root, relative)
{
    if (typeof relative !== 'string' || path.posix.isAbsolute(relative) || relative.includes('\\')
        || relative.split('/').some((part) => ['', '.', '..'].includes(part)))
    {
        throw new Error('evidence must be a canonical relative reference');
    }
    const file = path.join(fs.realpathSync(root), relative);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
    {
        throw new Error(`evidence must be a regular file without aliases: ${relative}`);
    }
    return fs.readFileSync(file);
}

function readReference(root, ref)
{
    backendAtomicExactFields(ref, ['path', 'digest'], 'attempt reference');
    backendAtomicDigest(ref.digest, 'attempt file digest');
    const bytes = regularBytes(root, ref.path);
    if (sha256(bytes) !== ref.digest)
    {
        throw new Error(`attempt reference digest mismatch: ${ref.path}`);
    }
    return JSON.parse(bytes);
}

function readAttempt(plan, declaration, ref, evidenceRoot, verifyAuthority)
{
    if (typeof verifyAuthority !== 'function')
    {
        throw new Error('independent external authority verifier is required');
    }
    const expectedPath = `${plan.identity.schedulerRunId}/${declaration.producerId}/attempt-1/receipt.json`;
    same(ref.path, expectedPath, 'run-owned first attempt path');
    const attemptRoot = path.posix.dirname(ref.path);
    const producerRoot = path.join(evidenceRoot, path.posix.dirname(attemptRoot));
    same(fs.readdirSync(producerRoot).filter((name) => name.startsWith('attempt-')).sort(), ['attempt-1'], 'exact-one attempt directory');
    const document = readReference(evidenceRoot, ref);
    const receipt = validateAttemptReceipt(document, {
        verifyAuthority,
        verifyArtifact: (relative, digest) => sha256(regularBytes(evidenceRoot, `${attemptRoot}/${relative}`)) === digest
    });
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId'])
    {
        same(receipt[field], plan.identity[field], `attempt ${field}`);
    }
    same(receipt.producerId, declaration.producerId, 'attempt producer');
    same(receipt.retryPolicyId, 'correctness-first-attempt', 'zero-retry policy');
    same(receipt.attemptNumber, 1, 'attempt number');
    same(receipt.maxAttempts, 1, 'max attempts');
    same(receipt.retryDecision, receipt.status === 'clean-success' ? 'not-applicable' : 'policy-denied', 'zero-retry terminal decision');
    for (const field of ['commandDigest', 'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        same(receipt[field], declaration[field], `attempt ${field}`);
    }
    return { receipt, attemptRoot, ref };
}

function vectorEntry(entry, attempt, failureDomain)
{
    const { receipt, ref } = attempt;
    return {
        producerId: entry.producerId, terminalState: receipt.status,
        failureDomain: receipt.status === 'clean-success' ? null : receipt.status === 'cancelled' ? 'cancelled' : failureDomain,
        reasonCode: receipt.failureKind, attemptRef: ref, attemptContentDigest: receipt.contentDigest,
        replayRef: receipt.authorityReferences.find((reference) => reference.kind === 'replay-plan'),
        artifacts: receipt.artifactPaths.map((relative) => ({ path: `${attempt.attemptRoot}/${relative}`, digest: receipt.artifactDigests[relative] })),
        blockedBy: [], startedAt: receipt.startedAt, finishedAt: receipt.finishedAt
    };
}

function completeRoster(plan, observations)
{
    const producers = plan.declarations.filter((entry) => entry.kind === 'atomic-producer');
    if (!Array.isArray(observations))
    {
        throw new Error('observations must be an array');
    }
    same(observations.map((entry) => entry.producerId).sort(), producers.map((entry) => entry.producerId).sort(), 'complete exact-one settled vector');
    return producers;
}

function summary(plan, statusVector)
{
    const summaryId = plan.declarations.find((entry) => entry.kind === 'settled-join').producerId;
    const failed = statusVector.some((entry) => entry.terminalState !== 'clean-success');
    return sealContentDigest({
        schema: backendAtomicSummarySchema, authority: 'DATA_ONLY', producerId: summaryId,
        planDigest: plan.contentDigest, identity: plan.identity, readinessMode: plan.readinessMode, buildConfiguration: plan.buildConfiguration,
        terminalState: failed ? 'failed-no-retry' : 'clean-success', exitCode: failed ? 1 : 0,
        statusVector
    });
}

export function projectBackendGovernanceOutcomes({ plan, expectedPlanDigest, observations, evidenceRoot, sourceRoot, verifyAuthority })
{
    validateBackendAtomicPlan(plan, expectedPlanDigest);
    verifyBackendAtomicSourceRefs(plan, expectedPlanDigest, sourceRoot);
    same(plan.lane, 'backend-test-governance', 'governance lane');
    const producers = completeRoster(plan, observations);
    return summary(plan, producers.map((entry) =>
    {
        const observation = observations.find((item) => item.producerId === entry.producerId);
        backendAtomicExactFields(observation, ['producerId', 'attemptRef'], 'governance observation');
        return vectorEntry(entry, readAttempt(plan, entry, observation.attemptRef, evidenceRoot, verifyAuthority), 'governance');
    }));
}

function inputArtifact(attempt, name, expected, evidenceRoot)
{
    if (!attempt.receipt.artifactPaths.includes(name))
    {
        throw new Error(`consumed input artifact is missing: ${name}`);
    }
    same(JSON.parse(regularBytes(evidenceRoot, `${attempt.attemptRoot}/${name}`)), expected, `consumed ${name}`);
}

function after(start, finish, label)
{
    if (Date.parse(start) < Date.parse(finish))
    {
        throw new Error(`${label} overlaps an unsettled dependency/CPU window`);
    }
}

export function backendGovernanceInput(summaryDocument, observations)
{
    return {
        schema: 'fsusblog.backend-governance-consumed-input.v1',
        summaryDigest: summaryDocument.contentDigest, planDigest: summaryDocument.planDigest,
        attemptRefs: observations.map((item) => ({ producerId: item.producerId, attemptRef: item.attemptRef }))
            .sort((left, right) => left.producerId.localeCompare(right.producerId))
    };
}

export function backendReadinessInput(plan)
{
    return {
        schema: 'fsusblog.backend-readiness-consumed-input.v1', planDigest: plan.contentDigest,
        readinessMode: plan.readinessMode, configuration: plan.buildConfiguration
    };
}

export function projectBackendPerfOutcomes({ plan, expectedPlanDigest, observations, releaseAttemptRef, governance, evidenceRoot, sourceRoot, verifyAuthority })
{
    validateBackendAtomicPlan(plan, expectedPlanDigest);
    verifyBackendAtomicSourceRefs(plan, expectedPlanDigest, sourceRoot);
    same(plan.lane, 'backend-perf', 'perf lane');
    const producers = completeRoster(plan, observations);
    backendAtomicExactFields(governance, ['plan', 'expectedPlanDigest', 'observations'], 'governance input');
    same(governance.plan.identity, plan.identity, 'governance execution identity/profile');
    const governanceSummary = projectBackendGovernanceOutcomes({ ...governance, evidenceRoot, sourceRoot, verifyAuthority });
    const release = readAttempt(plan, plan.releasePrerequisite, releaseAttemptRef, evidenceRoot, verifyAuthority);
    const attempts = new Map();
    for (const entry of producers.filter((item) => item.producerId !== 'backend-perf-native-p99'))
    {
        const observation = observations.find((item) => item.producerId === entry.producerId);
        backendAtomicExactFields(observation, ['producerId', 'attemptRef'], 'perf observation');
        attempts.set(entry.producerId, readAttempt(plan, entry, observation.attemptRef, evidenceRoot, verifyAuthority));
    }
    const governanceAttempt = attempts.get('backend-perf-governance');
    inputArtifact(governanceAttempt, 'governance-input.json', backendGovernanceInput(governanceSummary, governance.observations), evidenceRoot);
    for (const outcome of governanceSummary.statusVector)
    {
        after(governanceAttempt.receipt.startedAt, outcome.finishedAt, 'governance consumer');
    }
    if (governanceSummary.exitCode !== 0 && governanceAttempt.receipt.status === 'clean-success')
    {
        throw new Error('governance consumer cannot overwrite an underlying first failure');
    }
    inputArtifact(attempts.get('backend-perf-readiness'), 'readiness-input.json', backendReadinessInput(plan), evidenceRoot);
    const nativeEntry = producers.find((entry) => entry.producerId === 'backend-perf-native-p99');
    const nativeObservation = observations.find((entry) => entry.producerId === nativeEntry.producerId);
    let nativeVector;
    if (release.receipt.status !== 'clean-success')
    {
        backendAtomicExactFields(nativeObservation, ['producerId', 'blockedBy'], 'blocked native observation');
        same(nativeObservation.blockedBy, [plan.releasePrerequisite.producerId], 'native true blocked prerequisite');
        const nativeDirectory = path.join(evidenceRoot, plan.identity.schedulerRunId, nativeEntry.producerId);
        if (fs.existsSync(nativeDirectory))
        {
            throw new Error('blocked native producer must have spawn/attempt=0');
        }
        nativeVector = {
            producerId: nativeEntry.producerId, terminalState: 'blocked', failureDomain: 'blocked',
            reasonCode: 'release-test-build-not-clean', attemptRef: null, attemptContentDigest: null,
            replayRef: null, artifacts: [], blockedBy: [{ producerId: plan.releasePrerequisite.producerId, attemptRef: releaseAttemptRef }],
            startedAt: null, finishedAt: null
        };
    }
    else
    {
        backendAtomicExactFields(nativeObservation, ['producerId', 'attemptRef'], 'native observation');
        const native = readAttempt(plan, nativeEntry, nativeObservation.attemptRef, evidenceRoot, verifyAuthority);
        after(native.receipt.startedAt, release.receipt.finishedAt, 'native Release assembly prerequisite');
        for (const dependency of attempts.values())
        {
            after(native.receipt.startedAt, dependency.receipt.finishedAt, 'native measurement');
        }
        nativeVector = vectorEntry(nativeEntry, native, native.receipt.failureClass === 'product' ? 'product-performance' : 'runtime-infrastructure');
    }
    const statusVector = producers.map((entry) => entry.producerId === nativeEntry.producerId ? nativeVector
        : vectorEntry(entry, attempts.get(entry.producerId), entry.producerId === 'backend-perf-governance' ? 'governance' : 'build-readiness'));
    return summary(plan, statusVector);
}

export function verifyBackendAtomicSummary(document, expectedDigest, input)
{
    backendAtomicDigest(expectedDigest, 'selected summary digest');
    const projected = input.plan.lane === 'backend-test-governance'
        ? projectBackendGovernanceOutcomes(input) : projectBackendPerfOutcomes(input);
    same(document, projected, 'replayed complete summary');
    same(document.contentDigest, expectedDigest, 'selected summary digest');
    return projected;
}
