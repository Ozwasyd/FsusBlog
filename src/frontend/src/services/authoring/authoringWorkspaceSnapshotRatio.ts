import { authoringWorkspaceRatioOwner, type AuthoringWorkspaceRatioChange, type AuthoringWorkspaceRatioRef, type AuthoringWorkspaceRatioScope } from './authoringWorkspaceRatioOwner';
import { requirePreparedWorkspaceSnapshotRestorePlan, type AuthoringWorkspaceSnapshotRestorePlan } from './authoringWorkspaceSnapshotRestore';

/** Projects the exact current session ref to the scalar snapshot field; no effective clamp or current-ref fallback. */
export function projectAuthoringWorkspaceSnapshotRatio(scope: AuthoringWorkspaceRatioScope, ratioRef: AuthoringWorkspaceRatioRef): number
{
    return authoringWorkspaceRatioOwner.resolve(scope, ratioRef).splitRatioPermille;
}

/**
 * Stages a genuine server restore plan's scalar through the sole ratio owner.
 * The original group transaction must readPrepared and jointly commit, or discard;
 * this conversion publishes no ratio/group state and produces no restore receipt.
 */
export function prepareAuthoringWorkspaceSnapshotRatio(
    plan: AuthoringWorkspaceSnapshotRestorePlan,
    scope: AuthoringWorkspaceRatioScope,
    expectedRatioRef: AuthoringWorkspaceRatioRef
): AuthoringWorkspaceRatioChange
{
    requirePreparedWorkspaceSnapshotRestorePlan(plan);
    return authoringWorkspaceRatioOwner.prepare(scope, expectedRatioRef, plan.layout.splitRatioPermille);
}
