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
    inspectCleanup(): SnapshotCleanupStatus;
    disposalFailure?: unknown;
}

type SnapshotCleanupRole = 'abort' | 'watch' | 'listener' | 'connection' | 'sync' | 'channel' | 'cache';
type SnapshotCleanupResult = 'fulfilled' | 'not-acquired';

/** Diagnostics of original cleanup commands only, never a native or storage-deletion receipt. */
export interface SnapshotCleanupStatus {
    readonly closed: boolean;
    readonly active: boolean;
    readonly obligations: readonly {
        readonly role: SnapshotCleanupRole;
        readonly state: 'pending' | SnapshotCleanupResult;
        readonly attempts: number;
        readonly hasFailure: boolean;
        readonly firstFailure: unknown;
        readonly lastFailure: unknown;
    }[];
}

function createSnapshotCleanup(revoke: () => void)
{
    const obligations = new Map<SnapshotCleanupRole, {
        run(): SnapshotCleanupResult | void | Promise<SnapshotCleanupResult | void>;
        state: 'pending' | SnapshotCleanupResult;
        attempts: number;
        hasFailure: boolean;
        firstFailure: unknown;
        lastFailure: unknown;
    }>();
    let closed = false;
    let active: Promise<void> | undefined;
    const order: readonly SnapshotCleanupRole[] = ['abort', 'watch', 'listener', 'connection', 'sync', 'channel', 'cache'];
    const attempt = async (role: SnapshotCleanupRole): Promise<void> =>
    {
        const obligation = obligations.get(role);
        if (obligation?.state !== 'pending')
        {
            return;
        }
        obligation.attempts = Math.min(Number.MAX_SAFE_INTEGER, obligation.attempts + 1);
        try
        {
            const result = obligation.run();
            if (result === active)
            {
                throw new Error('article-workspace-snapshot-cleanup-self-await');
            }
            const completed = result && typeof result === 'object' ? await result : result;
            obligation.state = completed === 'not-acquired' ? 'not-acquired' : 'fulfilled';
        }
        catch (error)
        {
            if (!obligation.hasFailure)
            {
                obligation.firstFailure = error;
            }
            obligation.hasFailure = true;
            obligation.lastFailure = error;
            throw error;
        }
    };
    return Object.freeze({
        register(role: SnapshotCleanupRole, run: () => SnapshotCleanupResult | void | Promise<SnapshotCleanupResult | void>): void
        {
            if (obligations.has(role))
            {
                throw new Error('article-workspace-snapshot-cleanup-owner-already-adopted');
            }
            obligations.set(role, { run, state: 'pending', attempts: 0, hasFailure: false,
                firstFailure: undefined, lastFailure: undefined });
        },
        dispose(): Promise<void>
        {
            // This never transitions back to live, even when cleanup fails or is retried.
            closed = true;
            revoke();
            if (active)
            {
                return active;
            }
            const pass = Promise.resolve().then(async () =>
            {
                // Start every independent obligation before waiting on any one async owner.
                const pending = order.filter(role => role !== 'abort' && obligations.get(role)?.state === 'pending');
                const results = await Promise.allSettled([aborting, ...pending.map(role => attempt(role))]);
                const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
                if (failures.length > 0)
                {
                    const errors = failures.map((result) =>
                    {
                        const error: unknown = result.reason;
                        return error;
                    });
                    throw new AggregateError(errors,
                        'article-workspace-snapshot-cleanup-incomplete', { cause: errors[0] });
                }
            });
            // Reserve before abort invokes listeners which may synchronously re-enter dispose.
            active = pass;
            const aborting = attempt('abort');
            // Retain the immediate abort outcome; it is reported even if a later attempt succeeds.
            void aborting.catch(() => undefined);
            void pass.then(() =>
            {
                active = undefined;
            }, () =>
            {
                active = undefined;
            });
            return pass;
        },
        inspect(): SnapshotCleanupStatus
        {
            return Object.freeze({ closed, active: active !== undefined,
                obligations: Object.freeze([...obligations].map(([role, obligation]) => Object.freeze({
                    role, state: obligation.state, attempts: obligation.attempts, hasFailure: obligation.hasFailure,
                    firstFailure: obligation.firstFailure, lastFailure: obligation.lastFailure
                }))) });
        }
    });
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
    let closed = false;
    const cleanup = createSnapshotCleanup(() =>
    {
        closed = true;
    });
    cleanup.register('abort', () => controller.abort());
    const lifetime: SnapshotLifetime = {
        assertCurrent: () => assertCurrent(),
        inspectCleanup: () => cleanup.inspect(),
        dispose: () =>
        {
            const pass = cleanup.dispose();
            void pass.catch((error: unknown) =>
            {
                lifetime.disposalFailure = error;
            });
            return pass;
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
    cleanup.register('watch', stopWatching);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup.register('listener', () => signal.removeEventListener('abort', onAbort));
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
        const acquiring = connectAuthoringWorkspaceSnapshotHttp(signal).then(value => ({ value }), (error: unknown) => ({ error }));
        cleanup.register('connection', async () =>
        {
            const acquired = await acquiring;
            if ('error' in acquired)
            {
                // No connection handle was transferred; the original failed constructor owns its cleanup.
                return 'not-acquired';
            }
            acquired.value.dispose();
            return 'fulfilled';
        });
        const acquired = await acquiring;
        if ('error' in acquired)
        {
            throw acquired.error;
        }
        const connected = acquired.value;
        connection = connected;
        assertCurrent();
        const api = checked(() => connected.api);
        const cache = new AuthoringWorkspaceSnapshotCache(storage, api.scope, api.sourceDigest);
        cleanup.register('cache', cache.close.bind(cache));
        assertCurrent();
        if (channel)
        {
            cleanup.register('channel', channel.close.bind(channel));
        }
        const sync = new AuthoringWorkspaceSnapshotSync(api, cache, channel, ownerRef, flushLease);
        cleanup.register('sync', sync.stop.bind(sync));
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

export function readAdminArticleWorkspaceSnapshotCleanupStatus(ports: AdminArticleWorkspaceStartupPorts): SnapshotCleanupStatus | undefined
{
    return lifetimes.get(ports)?.inspectCleanup();
}
