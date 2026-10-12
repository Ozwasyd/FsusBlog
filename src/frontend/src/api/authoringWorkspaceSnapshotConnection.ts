import { watch } from 'vue';

import { getAdminMe } from '@/api/auth';
import { AuthoringWorkspaceSnapshotApi, AuthoringWorkspaceSnapshotError, workspaceSnapshotExact, workspaceSnapshotHash, workspaceSnapshotId, workspaceSnapshotInteger } from '@/api/authoringWorkspaceSnapshot';
import { createAuthoringWorkspaceSnapshotHttpTransport, readAuthoringWorkspaceSnapshotHttp } from '@/api/authoringWorkspaceSnapshotHttpTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

export interface AuthoringWorkspaceSnapshotConnection {
    readonly api: AuthoringWorkspaceSnapshotApi;
    assertCurrent(): void;
    dispose(): void;
}

/** Real HTTP binding only; the host still owns Sync, restore admission and disposal. */
export async function connectAuthoringWorkspaceSnapshotHttp(signal?: AbortSignal): Promise<AuthoringWorkspaceSnapshotConnection>
{
    signal?.throwIfAborted();
    const generation = privateSurfaceRuntime.authGeneration.value;
    const lease = privateRequestRuntime.open('admin', signal);
    const leaseSignal = lease.signal;
    if (!leaseSignal)
    {
        lease.release();
        throw new AuthoringWorkspaceSnapshotError('admin_request_lease_required');
    }
    const lifetime = new AbortController();
    const requestSignal = AbortSignal.any([leaseSignal, lifetime.signal]);
    let api: AuthoringWorkspaceSnapshotApi | undefined;
    let closed = false;
    const dispose = (): void =>
    {
        if (closed)
        {
            return;
        }
        closed = true;
        api?.close();
        stopWatching();
        requestSignal.removeEventListener('abort', dispose);
        lifetime.abort();
        lease.release();
    };
    const assertCurrent = (): void =>
    {
        requestSignal.throwIfAborted();
        lease.assertCurrent();
        if (closed || privateSurfaceRuntime.isClearing.value
            || generation !== privateSurfaceRuntime.authGeneration.value)
        {
            dispose();
            throw new AuthoringWorkspaceSnapshotError('workspace_snapshot_auth_binding_changed');
        }
    };
    const invoke = async <T>(operation: (requestSignal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> =>
    {
        assertCurrent();
        const currentSignal = callerSignal ? AbortSignal.any([requestSignal, callerSignal]) : requestSignal;
        currentSignal.throwIfAborted();
        const result = await operation(currentSignal);
        currentSignal.throwIfAborted();
        assertCurrent();
        return result;
    };
    requestSignal.addEventListener('abort', dispose, { once: true });
    const stopWatching = watch(privateSurfaceRuntime.authGeneration, dispose, { flush: 'sync' });
    try
    {
        const principal = await invoke(currentSignal => getAdminMe({ signal: currentSignal }));
        const userId = Number(principal.id);
        if (principal.source !== 'independent' || principal.adminSessionStatus !== 'active'
            || principal.totpStepUpRequired === true || !principal.permissions.includes('article.write')
            || !workspaceSnapshotInteger(userId, 1) || String(userId) !== principal.id)
        {
            throw new AuthoringWorkspaceSnapshotError('workspace_snapshot_admin_authority_required');
        }

        // This first authenticated GET only discovers coordinates; it mints no observation.
        const raw = await invoke(readAuthoringWorkspaceSnapshotHttp);
        workspaceSnapshotExact(raw, ['status', 'revision', 'snapshot', 'receipt']);
        workspaceSnapshotExact(raw.receipt, ['schema', 'action', 'status', 'reason', 'scope', 'workspaceId', 'sourceDigest', 'revisionBefore', 'revisionAfter', 'tabCount', 'byteCount', 'inputDigest', 'snapshotDigest', 'contentDigest']);
        workspaceSnapshotExact(raw.receipt.scope, ['userId', 'siteId']);
        const receipt = raw.receipt;
        const scope = raw.receipt.scope;
        if ((raw.status !== 'current' && raw.status !== 'missing') || receipt.action !== 'read'
            || receipt.workspaceId !== 'default' || scope.userId !== userId
            || !workspaceSnapshotInteger(scope.userId, 1) || !workspaceSnapshotId(scope.siteId)
            || !workspaceSnapshotHash(receipt.sourceDigest))
        {
            throw new AuthoringWorkspaceSnapshotError('workspace_snapshot_server_binding_required');
        }
        const transport = createAuthoringWorkspaceSnapshotHttpTransport(receipt.sourceDigest);
        api = new AuthoringWorkspaceSnapshotApi({
            read: callerSignal => invoke(currentSignal => transport.read(currentSignal), callerSignal),
            write: (command, callerSignal) => invoke(currentSignal => transport.write(command, currentSignal), callerSignal),
            reset: (command, callerSignal) => invoke(currentSignal => transport.reset(command, currentSignal), callerSignal)
        }, { userId: scope.userId, siteId: scope.siteId }, receipt.sourceDigest, Date.now, assertCurrent);

        // A fresh real GET must pass the original complete receipt/snapshot verifier.
        // Source/site drift fails that binding; no cached first result or default is adopted.
        const observation = await api.read(requestSignal);
        assertCurrent();
        if (observation.status !== 'current' && observation.status !== 'missing')
        {
            throw new AuthoringWorkspaceSnapshotError('current_server_read_required');
        }
        return Object.freeze({ api, assertCurrent, dispose });
    }
    catch (error)
    {
        dispose();
        throw error;
    }
}
