import { watch } from 'vue';

import { connectAuthoringWorkspaceSnapshotHttp } from '@/api/authoringWorkspaceSnapshotConnection';
import type { AuthoringWorkspaceSnapshotConnection } from '@/api/authoringWorkspaceSnapshotConnection';
import type { AdminArticleWorkspaceStartupPorts } from '@/layouts/adminArticleWorkspaceStartup';
import { AuthoringWorkspaceSnapshotCache } from '@/services/authoring/authoringWorkspaceSnapshotCache';
import type { WorkspaceSnapshotCacheStorage } from '@/services/authoring/authoringWorkspaceSnapshotCache';
import { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';
import type { WorkspaceSnapshotCoordinationChannel, WorkspaceSnapshotFlushLease } from '@/services/authoring/authoringWorkspaceSnapshotSync';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
/** Original caller resources only; this boundary owns no article, permission or mount source. */
export interface AdminArticleWorkspaceSnapshotCaller {
    readonly startup: Omit<AdminArticleWorkspaceStartupPorts, 'sync'>;
    readonly cacheStorage: WorkspaceSnapshotCacheStorage;
    readonly channel: WorkspaceSnapshotCoordinationChannel | null;
    readonly ownerRef: string;
    readonly flushLease: WorkspaceSnapshotFlushLease | null;
}

interface SnapshotLifetime {
    assertCurrent(): void;
    dispose(): Promise<void>;
    disposalFailure?: unknown;
}

// Cleanup custody for these exact returned ports; never a second document/session index.
const lifetimes = new WeakMap<AdminArticleWorkspaceStartupPorts, SnapshotLifetime>();
let installation: {
    readonly source: AdminArticleWorkspaceSnapshotCaller;
    readonly task: Promise<AdminArticleWorkspaceStartupPorts>;
} | undefined;

/** Connect the actual HTTP owner to the existing root installer input; install no host here. */
export function connectAdminArticleWorkspaceSnapshotStartup(
    source: AdminArticleWorkspaceSnapshotCaller
): Promise<AdminArticleWorkspaceStartupPorts>
{
    if (installation)
    {
        if (installation.source !== source)
        {
            return Promise.reject(new Error('article-workspace-snapshot-caller-already-reserved'));
        }
        return installation.task.then((ports) =>
        {
            const lifetime = lifetimes.get(ports);
            if (!lifetime)
            {
                throw new Error('article-workspace-snapshot-caller-owner-unavailable');
            }
            lifetime.assertCurrent();
            return ports;
        });
    }
    // Reserve before any source getter or original callback can re-enter preparation.
    const task = Promise.resolve().then(() => prepareSnapshotStartup(source));
    installation = { source, task };
    return task;
}

async function prepareSnapshotStartup(source: AdminArticleWorkspaceSnapshotCaller): Promise<AdminArticleWorkspaceStartupPorts>
{
    const original = source.startup;
    const callerSignal = original.signal;
    callerSignal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const generation = privateSurfaceRuntime.authGeneration.value;
    let connection: AuthoringWorkspaceSnapshotConnection | undefined;
    let cache: AuthoringWorkspaceSnapshotCache | undefined;
    let sync: AuthoringWorkspaceSnapshotSync | undefined;
    let adoptedChannel: WorkspaceSnapshotCoordinationChannel | null = null;
    let closed = false;
    let disposal: Promise<void> | undefined;
    const lifetime: SnapshotLifetime = {
        assertCurrent: () => assertCurrent(),
        dispose: () =>
        {
            // Revoke before callbacks and keep disposal observable, including late connection completion.
            closed = true;
            controller.abort();
            connection?.dispose();
            stopWatching();
            signal.removeEventListener('abort', onAbort);
            disposal ??= Promise.resolve().then(async () =>
            {
                if (sync)
                {
                    await sync.stop();
                }
                else
                {
                    cache?.close();
                    adoptedChannel?.close();
                }
            });
            return disposal;
        }
    };
    const onAbort = (): void =>
    {
        void lifetime.dispose().catch((error: unknown) =>
        {
            lifetime.disposalFailure = error;
        });
    };
    const assertCurrent = (): void =>
    {
        signal.throwIfAborted();
        if (closed || source.startup !== original || original.signal !== callerSignal || privateSurfaceRuntime.isClearing.value
            || privateSurfaceRuntime.authGeneration.value !== generation)
        {
            throw new Error('article-workspace-snapshot-caller-revoked');
        }
        connection?.assertCurrent();
        signal.throwIfAborted();
        if (closed)
        {
            throw new Error('article-workspace-snapshot-caller-revoked');
        }
    };
    const checked = <Value>(read: () => Value): Value =>
    {
        assertCurrent();
        const value = read();
        assertCurrent();
        return value;
    };
    const stopWatching = watch(privateSurfaceRuntime.authGeneration, onAbort, { flush: 'sync' });
    signal.addEventListener('abort', onAbort, { once: true });
    try
    {
        const assertCapability = checked(() => original.assertRuntimeCapability.bind(original));
        checked(() => assertCapability());
        const resolutionPort = checked(() => original.resolutionPort);
        if (checked(() => typeof resolutionPort.resolveBatch) !== 'function')
        {
            throw new Error('article-workspace-snapshot-batch-source-required');
        }
        const mountedEditors = checked(() => original.mountedEditors);
        const groupOptions = checked(() => original.groupOptions);
        const createGroupIdentity = checked(() => original.createGroupIdentity.bind(original));
        const operationEpoch = checked(() => original.operationEpoch);
        const applyShell = checked(() => original.applyShell.bind(original));
        const isCurrent = checked(() => original.isCurrent.bind(original));
        const layout = checked(() => original.layout);
        const storage = checked(() => source.cacheStorage);
        const channel = checked(() => source.channel);
        const ownerRef = checked(() => source.ownerRef);
        const flushLease = checked(() => source.flushLease);
        const connected = await connectAuthoringWorkspaceSnapshotHttp(signal);
        connection = connected;
        assertCurrent();
        const api = checked(() => connected.api);
        cache = new AuthoringWorkspaceSnapshotCache(storage, api.scope, api.sourceDigest);
        assertCurrent();
        adoptedChannel = channel;
        sync = new AuthoringWorkspaceSnapshotSync(api, cache, channel, ownerRef, flushLease);
        assertCurrent();
        const ports = Object.freeze<AdminArticleWorkspaceStartupPorts>({
            sync, resolutionPort, mountedEditors, groupOptions, createGroupIdentity, operationEpoch,
            signal, layout,
            assertRuntimeCapability: () => checked(() => assertCapability()),
            isCurrent: guard => checked(() => isCurrent(guard)),
            applyShell: async (shell, commandSignal) =>
            {
                assertCurrent();
                const result = await applyShell(shell, commandSignal);
                assertCurrent();
                return result;
            }
        });
        lifetimes.set(ports, lifetime);
        // The existing root starts this original Sync once and consumes its genuine server observation.
        return ports;
    }
    catch (error)
    {
        try
        {
            await lifetime.dispose();
        }
        catch (disposalError)
        {
            throw new AggregateError([error, disposalError], 'article-workspace-snapshot-caller-and-cleanup-failed', { cause: disposalError });
        }
        throw error;
    }
}

/** Release only resources created by this caller; legacy supplied Sync remains with its original owner. */
export function disposeAdminArticleWorkspaceSnapshotStartup(ports: AdminArticleWorkspaceStartupPorts): Promise<void> | undefined
{
    return lifetimes.get(ports)?.dispose();
}

export function readAdminArticleWorkspaceSnapshotDisposalFailure(ports: AdminArticleWorkspaceStartupPorts): unknown
{
    return lifetimes.get(ports)?.disposalFailure;
}
