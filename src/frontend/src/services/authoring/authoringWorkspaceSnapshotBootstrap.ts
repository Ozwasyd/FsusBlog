import { AuthoringWorkspaceSnapshotError } from '@/api/authoringWorkspaceSnapshot';

import { AuthoringTabGroupRegistry, type AuthoringGroupCommandIdentity, type AuthoringSnapshotGroupAdapter } from './authoringTabGroupRegistry';
import { prepareAuthoringWorkspaceSnapshotRestore, requirePreparedWorkspaceSnapshotRestorePlan, type AuthoringWorkspaceSnapshotResolutionPort, type AuthoringWorkspaceSnapshotRestorePlan } from './authoringWorkspaceSnapshotRestore';
import type { AuthoringWorkspaceSnapshotSync } from './authoringWorkspaceSnapshotSync';

import type { ArticleWorkspaceTabRouter } from './articleWorkspaceTabRouter';

/** Consume the existing startup sync's server observation, never its cached or local layout. */
export async function prepareAuthoringWorkspaceSnapshotBootstrap(
    sync: AuthoringWorkspaceSnapshotSync,
    resolutionPort: AuthoringWorkspaceSnapshotResolutionPort,
    operationEpoch: number,
    signal: AbortSignal
): Promise<AuthoringWorkspaceSnapshotRestorePlan>
{
    signal.throwIfAborted();
    const state = sync.getState();
    if (state.dirty || state.resetting)
    {
        throw new AuthoringWorkspaceSnapshotError('restore_superseded');
    }
    const observation = sync.getServerObservation();
    if (!observation)
    {
        throw new AuthoringWorkspaceSnapshotError('current_server_read_required');
    }
    const plan = await prepareAuthoringWorkspaceSnapshotRestore(observation, resolutionPort, operationEpoch, signal);
    signal.throwIfAborted();
    requirePreparedWorkspaceSnapshotRestorePlan(plan);
    const current = sync.getState();
    if (sync.getServerObservation() !== observation || current.dirty || current.resetting)
    {
        throw new AuthoringWorkspaceSnapshotError('restore_superseded');
    }
    return plan;
}

/** Bind an already bootstrapped original owner; this function creates no groups, scope or session. */
export function bindAuthoringWorkspaceSnapshotBootstrapGroups(
    plan: AuthoringWorkspaceSnapshotRestorePlan,
    router: Pick<ArticleWorkspaceTabRouter, 'getRegistry'>,
    groupOwner: AuthoringTabGroupRegistry,
    createIdentity: () => AuthoringGroupCommandIdentity
): AuthoringSnapshotGroupAdapter & { readonly groupOwner: AuthoringTabGroupRegistry; }
{
    requirePreparedWorkspaceSnapshotRestorePlan(plan);
    const registry = router.getRegistry();
    if (!(groupOwner instanceof AuthoringTabGroupRegistry) || !groupOwner.verifyBinding(registry))
    {
        throw new AuthoringWorkspaceSnapshotError('restore_registry_binding_changed');
    }
    const projection = groupOwner.exportProjection();
    if (registry.listEntries().length > 0 || projection.state.groups.some(group => group.tabs.length > 0))
    {
        throw new AuthoringWorkspaceSnapshotError('restore_requires_unstarted_workspace');
    }
    if (projection.state.groups.length !== plan.layout.groups.length
        || !projection.state.groups.every((group, index) => group.groupId === plan.layout.groups[index]?.groupId))
    {
        throw new AuthoringWorkspaceSnapshotError('restore_group_bootstrap_required');
    }
    const adapter = groupOwner.createSnapshotAdapter(createIdentity);
    requirePreparedWorkspaceSnapshotRestorePlan(plan);
    return Object.freeze({ groupOwner, ...adapter });
}
