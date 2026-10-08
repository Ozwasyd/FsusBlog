import { sealContentDigest, sha256 } from '../test/attempt-provenance.mjs';
import { readCoverageMaterial } from './atomic-coverage-inputs.mjs';
import { readCoverageBytes, requireCoverage, validateCoveragePlan } from './atomic-coverage-plan.mjs';

/**
 * Pure DATA_ONLY settled projection: no tests, child command invocation or qualification.
 * Missing nodes remain visible and fail the aggregate. Blocked outcomes require the
 * canonical compiler's independent verifier; a digest alone cannot grant that authority.
 */
export function projectCoverageSettled({ root, plan, projectionId, outcomes, verifyAuthority, verifyBlocked })
{
    validateCoveragePlan(plan, root);
    const projection = plan.projections.find((item) => item.id === projectionId);
    requireCoverage(projection && outcomes && Object.keys(outcomes).every((id) => projection.settledDependsOn.includes(id)), 'unknown projection/member');
    const summaryRefs = {};
    const nodes = projection.settledDependsOn.map((producerId) =>
    {
        const outcome = outcomes[producerId];
        if (!outcome) return { producerId, terminalState: 'missing', reasonCode: 'coverage.terminal-missing' };
        if (Object.keys(outcome).join(',') === 'blockedRef')
        {
            const reference = outcome.blockedRef;
            requireCoverage(reference && Object.keys(reference).sort().join(',') === 'digest,path', 'invalid blocked ref');
            const bytes = readCoverageBytes(root, reference.path);
            requireCoverage(sha256(bytes) === reference.digest, 'blocked receipt tamper');
            requireCoverage(typeof verifyBlocked === 'function', 'canonical blocked verifier unavailable');
            const blocked = verifyBlocked({ reference, bytes, producerId, plan });
            const producer = plan.producers.find((item) => item.id === producerId);
            requireCoverage(blocked?.producerId === producerId && blocked.terminalState === 'blocked'
                && blocked.identity?.runId === plan.identity.runId
                && blocked.identity?.sourceCommit === plan.identity.sourceCommit
                && blocked.identity?.sourceFingerprint === plan.identity.sourceFingerprint
                && blocked.planDigest === plan.contentDigest
                && Array.isArray(blocked.blockedBy) && blocked.blockedBy.length > 0
                && new Set(blocked.blockedBy).size === blocked.blockedBy.length
                && blocked.blockedBy.every((id) => producer.dependsOn.includes(id))
                && Array.isArray(blocked.primaryFailureRefs) && blocked.primaryFailureRefs.length > 0,
            'invalid/cross-run/unrelated blocked outcome');
            return { producerId, terminalState: 'blocked', reasonCode: 'coverage.hard-input-blocked',
                blockedBy: [...blocked.blockedBy], primaryFailureRefs: blocked.primaryFailureRefs, blockedRef: reference };
        }
        const material = readCoverageMaterial({ root, plan, producerId, material: outcome, verifyAuthority });
        if (material.status === 'clean-success' && material.artifacts.summary)
        {
            const { path, digest } = material.artifacts.summary;
            summaryRefs[producerId === 'coverage-merge' ? 'merged' : producerId.slice('coverage-'.length)] = { path, digest };
        }
        return { producerId, terminalState: material.status, attemptRef: material.attemptRef,
            replayRef: material.attempt.authorityReferences.find((reference) => reference.kind === 'replay-plan'),
            reasonCode: material.status === 'clean-success' ? null : material.attempt.failureKind };
    });
    return sealContentDigest({
        schema: 'fsusblog.atomic-coverage-settled-data.v1', projectionId,
        identity: { ...plan.identity }, planDigest: plan.contentDigest, nodes, summaryRefs,
        status: nodes.every((node) => node.terminalState === 'clean-success') ? 'clean-success' : 'failed-no-retry',
        qualificationEligible: false
    });
}
