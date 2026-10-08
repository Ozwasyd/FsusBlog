import { AuthoringWorkspaceSnapshotError, defaultWorkspaceSnapshotLayout, freezeWorkspaceSnapshot, requireWorkspaceServerObservation, workspaceSnapshotDigest, type AuthoringWorkspaceSnapshotApi, type AuthoringWorkspaceServerObservation } from '@/api/authoringWorkspaceSnapshot';
// Inventory is scoped to layout persistence found in the transferred source candidate.
// Article draft/comment/journal/theme/locale data is outside this owner and is never inspected or removed.
export const workspaceSnapshotLegacyInventory = Object.freeze([
    Object.freeze({ key: 'fsusblog.article-outline.rail-open.v1',
        owner: 'src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue',
        scope: 'unscoped', disposition: 'discard-unscoped', targetField: null })
] as const);
export interface WorkspaceSnapshotLegacyStorage {
    getItem(key: string): string | null;
    removeItem(key: string): void;
}
export interface AuthoringWorkspaceSnapshotMigrationReceipt {
    schema: 'fsusblog.authoring-workspace-migration.v1';
    inventoryDigest: string;
    scopeDigest: string;
    sourceDigest: string;
    status: 'deferred' | 'server-precedence' | 'applied' | 'conflict' | 'blocked' | 'cleanup-unavailable';
    revision: number;
    discardedCount: number;
    reason: 'unscoped-legacy' | 'no-legacy' | 'server-existing' | 'cleanup-unavailable' | 'server-blocked' | 'bootstrap-not-requested' | 'stale-revision';
    contentDigest: string;
}
/// Only an explicit missing-server bootstrap may write. A global legacy boolean cannot prove user/site/source ownership.
export async function migrateAuthoringWorkspaceSnapshotLegacy(api: AuthoringWorkspaceSnapshotApi, observation: AuthoringWorkspaceServerObservation, storage: WorkspaceSnapshotLegacyStorage, explicitBootstrap: boolean): Promise<{
    observation: AuthoringWorkspaceServerObservation;
    receipt: AuthoringWorkspaceSnapshotMigrationReceipt;
}>
{
    requireWorkspaceServerObservation(observation);
    if (observation.receipt.action !== 'read' || observation.receipt.sourceDigest !== api.sourceDigest
        || workspaceSnapshotDigest(observation.receipt.scope) !== workspaceSnapshotDigest(api.scope))
    {
        throw new AuthoringWorkspaceSnapshotError('migration_server_read_required');
    }
    let result = observation;
    let status: AuthoringWorkspaceSnapshotMigrationReceipt['status'] = 'deferred';
    let reason: AuthoringWorkspaceSnapshotMigrationReceipt['reason'] = 'bootstrap-not-requested';
    let discardedCount = 0;
    if (observation.status === 'blocked')
    {
        status = 'blocked';
        reason = 'server-blocked';
    }
    else if (observation.status === 'current')
    {
        status = 'server-precedence';
        reason = 'server-existing';
    }
    else if (observation.status !== 'missing')
    {
        throw new AuthoringWorkspaceSnapshotError('migration_server_read_required');
    }
    else if (explicitBootstrap)
    {
        try
        {
            // Read only finite inventoried layout keys. Even true/false is discarded because the old format has no scope proof.
            discardedCount = workspaceSnapshotLegacyInventory.filter(row => storage.getItem(row.key) !== null).length;
        }
        catch
        {
            discardedCount = 0;
        }
        result = await api.write(0, defaultWorkspaceSnapshotLayout());
        status = result.status === 'conflict' ? 'conflict' : 'applied';
        reason = result.status === 'conflict' ? 'stale-revision' : discardedCount > 0 ? 'unscoped-legacy' : 'no-legacy';
    }
    if (status === 'applied' || status === 'server-precedence')
    {
        try
        {
            for (const row of workspaceSnapshotLegacyInventory)
            {
                storage.removeItem(row.key);
            }
        }
        catch
        {
            status = 'cleanup-unavailable';
            reason = 'cleanup-unavailable';
        }
    }
    const unsigned: Omit<AuthoringWorkspaceSnapshotMigrationReceipt, 'contentDigest'> = {
        schema: 'fsusblog.authoring-workspace-migration.v1', inventoryDigest: workspaceSnapshotDigest(workspaceSnapshotLegacyInventory),
        scopeDigest: workspaceSnapshotDigest(api.scope), sourceDigest: api.sourceDigest,
        status, revision: result.revision, discardedCount, reason
    };
    return { observation: result, receipt: freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) }) };
}
