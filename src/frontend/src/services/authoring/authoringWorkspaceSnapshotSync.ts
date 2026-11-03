import { AuthoringWorkspaceSnapshotError, defaultWorkspaceSnapshotLayout, freezeWorkspaceSnapshot, requireWorkspaceServerObservation, validateWorkspaceSnapshotLayout, workspaceSnapshotDigest, workspaceSnapshotExact, workspaceSnapshotId, workspaceSnapshotInteger, type AuthoringWorkspaceSnapshotApi, type AuthoringWorkspaceServerObservation, type AuthoringWorkspaceSnapshotLayout } from '@/api/authoringWorkspaceSnapshot';

import type { AuthoringWorkspaceSnapshotCache, WorkspaceSnapshotCacheRead } from './authoringWorkspaceSnapshotCache';

export const workspaceSnapshotSyncPolicy = Object.freeze({
    schema: 'fsusblog.authoring-workspace-sync.v1',
    channelSchema: 'fsusblog.authoring-workspace-channel.v1',
    debounceMs: 250, maxWaitMs: 2000, safetyFlushMs: 30000, leaseMs: 5000,
    maxEvents: 64,
    statuses: ['loading', 'current', 'cached-placeholder', 'defaulted', 'failed', 'offline-unsynced', 'conflict', 'blocked'],
    layoutEvents: ['tabs', 'groups', 'active', 'splitter', 'shell'],
    ignoredEvents: ['input', 'caret', 'scroll'],
    flushBoundaries: ['debounce', 'pagehide', 'hidden', 'periodic', 'manual']
} as const);
export type WorkspaceSnapshotSyncStatus = typeof workspaceSnapshotSyncPolicy.statuses[number];
export interface WorkspaceSnapshotSyncState {
    schema: typeof workspaceSnapshotSyncPolicy.schema;
    scopeDigest: string;
    sourceDigest: string;
    status: WorkspaceSnapshotSyncStatus;
    serverRevision: number | null;
    dirty: boolean;
    resetting: boolean;
    online: boolean;
    cacheStatus: string;
    reason: string | null;
    contentDigest: string;
}
interface ChannelMessage {
    schema: typeof workspaceSnapshotSyncPolicy.channelSchema;
    scopeDigest: string;
    sourceDigest: string;
    ownerRef: string;
    kind: 'flush-start' | 'flush-end' | 'invalidated';
    revision: number;
    leaseUntil: number;
}
export interface WorkspaceSnapshotCoordinationChannel {
    send(message: ChannelMessage): void;
    subscribe(listener: (value: unknown) => void): () => void;
    close(): void;
}
export interface WorkspaceSnapshotFlushLease {
    run(name: string, operation: () => Promise<void>): Promise<boolean>;
}
export interface WorkspaceSnapshotSyncClock {
    now(): number;
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const browserClock: WorkspaceSnapshotSyncClock = {
    now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: timer => clearTimeout(timer)
};
/// Coordinates only revisions/leases; every layout write remains server CAS and every cache write is server verified.
export class AuthoringWorkspaceSnapshotSync
{
    private readonly api: AuthoringWorkspaceSnapshotApi;
    private readonly cache: AuthoringWorkspaceSnapshotCache;
    private readonly channel: WorkspaceSnapshotCoordinationChannel | null;
    private readonly ownerRef: string;
    private readonly lease: WorkspaceSnapshotFlushLease | null;
    private readonly clock: WorkspaceSnapshotSyncClock;
    private readonly scopeDigest: string;
    private readonly abort = new AbortController();
    private readonly listeners = new Set<() => void>();
    private readonly unsubscribe: () => void;
    private observation: AuthoringWorkspaceServerObservation | null = null;
    private pendingServer: AuthoringWorkspaceServerObservation | null = null;
    private memory = defaultWorkspaceSnapshotLayout();
    private cacheRead: WorkspaceSnapshotCacheRead | null = null;
    private status: WorkspaceSnapshotSyncStatus = 'loading';
    private cacheStatus = 'missing';
    private reason: string | null = null;
    private online = true;
    private dirty = false;
    private resetting = false;
    private generation = 0;
    private lifecycleEpoch = 0;
    private dirtySince = 0;
    private stopped = false;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private periodic: ReturnType<typeof setTimeout> | null = null;
    private flushTask: Promise<void> | null = null;
    private reading = 0;
    private peerLeaseUntil = 0;
    private readAfterFlush = false;
    private readonly events: {
        kind: string;
        revision: number | null;
        status: WorkspaceSnapshotSyncStatus;
    }[] = [];
    public constructor(api: AuthoringWorkspaceSnapshotApi, cache: AuthoringWorkspaceSnapshotCache, channel: WorkspaceSnapshotCoordinationChannel | null, ownerRef: string, lease: WorkspaceSnapshotFlushLease | null = null, clock: WorkspaceSnapshotSyncClock = browserClock)
    {
        this.api = api;
        this.cache = cache;
        this.channel = channel;
        this.ownerRef = ownerRef;
        this.lease = lease;
        this.clock = clock;
        if (!workspaceSnapshotId(ownerRef))
        {
            throw new AuthoringWorkspaceSnapshotError('invalid_flush_owner');
        }
        this.scopeDigest = workspaceSnapshotDigest(api.scope);
        this.unsubscribe = channel?.subscribe(value => this.onChannel(value)) ?? (() => undefined);
    }
    public subscribe(listener: () => void): () => void
    {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    public getServerObservation(): AuthoringWorkspaceServerObservation | null
    {
        return this.online && !this.stopped && (this.status === 'current' || this.status === 'defaulted')
            && this.hasAuthority(this.observation) ? this.observation : null;
    }
    public getPlaceholder(): WorkspaceSnapshotCacheRead | null
    {
        return this.cacheRead;
    }
    public getCurrentSessionLayout(): AuthoringWorkspaceSnapshotLayout
    {
        return structuredClone(this.memory);
    }
    public getState(): WorkspaceSnapshotSyncState
    {
        const expired = this.online && (this.status === 'current' || this.status === 'defaulted') && !this.hasAuthority(this.observation);
        const unsigned = {
            schema: workspaceSnapshotSyncPolicy.schema, scopeDigest: this.scopeDigest, sourceDigest: this.api.sourceDigest,
            status: expired ? 'failed' as const : this.status, serverRevision: this.observation?.revision ?? null, dirty: this.dirty,
            resetting: this.resetting, online: this.online, cacheStatus: this.cacheStatus,
            reason: expired ? 'server_observation_superseded' : this.reason
        };
        return freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
    }
    public getReceipt(): {
        state: WorkspaceSnapshotSyncState;
        events: {
            kind: string;
            revision: number | null;
            status: WorkspaceSnapshotSyncStatus;
        }[];
        contentDigest: string;
    }
    {
        const unsigned = { state: this.getState(), events: structuredClone(this.events) };
        return freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
    }
    public async start(online = true): Promise<void>
    {
        if (this.stopped)
        {
            return;
        }
        const epoch = ++this.lifecycleEpoch;
        this.api.invalidateObservations();
        this.online = online;
        const cacheRead = await this.cache.read();
        if (this.stopped || epoch !== this.lifecycleEpoch)
        {
            return;
        }
        this.cacheRead = cacheRead;
        this.cacheStatus = this.cacheRead.status;
        if (this.cacheRead.status === 'cached-placeholder')
        {
            this.status = 'cached-placeholder';
        }
        else
        {
            this.status = online ? 'loading' : 'defaulted';
        }
        this.record('startup-cache');
        if (online)
        {
            await this.readServer('startup');
        }
        if (!this.stopped && epoch === this.lifecycleEpoch)
        {
            this.schedulePeriodic();
        }
    }
    public onInteraction(kind: typeof workspaceSnapshotSyncPolicy.layoutEvents[number] | typeof workspaceSnapshotSyncPolicy.ignoredEvents[number], layout?: AuthoringWorkspaceSnapshotLayout): void
    {
        if (this.stopped || (workspaceSnapshotSyncPolicy.ignoredEvents as readonly string[]).includes(kind))
        {
            return;
        }
        if (!(workspaceSnapshotSyncPolicy.layoutEvents as readonly string[]).includes(kind) || !layout)
        {
            throw new AuthoringWorkspaceSnapshotError('layout_event_required');
        }
        validateWorkspaceSnapshotLayout(layout);
        if (workspaceSnapshotDigest(layout) === workspaceSnapshotDigest(this.memory))
        {
            return;
        }
        this.memory = structuredClone(layout);
        this.generation++;
        if (!this.dirty)
        {
            this.dirtySince = this.clock.now();
        }
        this.dirty = true;
        if (!this.online)
        {
            this.status = 'offline-unsynced';
        }
        this.record('layout-dirty');
        this.scheduleFlush();
    }
    public async setOnline(online: boolean): Promise<void>
    {
        if (this.stopped)
        {
            return;
        }
        if (this.online !== online)
        {
            this.lifecycleEpoch++;
            this.reading++;
            this.resetting = false;
            if (online)
            {
                this.api.invalidateObservations();
            }
        }
        this.online = online;
        const epoch = this.lifecycleEpoch;
        this.clearDebounce();
        if (!online)
        {
            this.api.invalidateObservations();
            if (this.dirty)
            {
                this.status = 'offline-unsynced';
            }
            else
            {
                this.status = this.cacheRead?.status === 'cached-placeholder' ? 'cached-placeholder' : 'defaulted';
            }
            this.reason = 'offline';
            this.record('offline');
            return;
        }
        // A current-session projection is never replayed until a new server read confirms the same revision.
        if (this.flushTask)
        {
            await this.flushTask;
        }
        if (!this.isCurrentOperation(epoch))
        {
            return;
        }
        await this.readServer('reconnect');
        this.scheduleFlush();
    }
    public async flush(boundary: typeof workspaceSnapshotSyncPolicy.flushBoundaries[number] = 'manual'): Promise<void>
    {
        this.clearDebounce();
        if (this.flushTask)
        {
            return this.flushTask;
        }
        if (!this.canFlush())
        {
            return;
        }
        if (this.peerLeaseUntil > this.clock.now())
        {
            this.scheduleFlush();
            return;
        }
        const epoch = this.lifecycleEpoch;
        const operation = async (): Promise<void> =>
        {
            if (!this.canFlush() || !this.isCurrentOperation(epoch))
            {
                return;
            }
            const revision = this.observation!.revision;
            const generation = this.generation;
            const layout = structuredClone(this.memory);
            this.send('flush-start', revision);
            this.record(`flush-${boundary}`);
            try
            {
                const result = await this.api.write(revision, layout, this.abort.signal);
                if (!this.isCurrentOperation(epoch) || !this.hasAuthority(result))
                {
                    return;
                }
                if (result.status === 'conflict')
                {
                    this.status = 'conflict';
                    this.reason = 'stale_revision';
                    this.record('cas-conflict');
                    await this.readServer('conflict');
                    return;
                }
                this.observation = result;
                const cacheStatus = await this.cache.verifyAndReplace(result);
                if (!this.isCurrentOperation(epoch) || !this.hasAuthority(result))
                {
                    return;
                }
                this.cacheStatus = cacheStatus;
                this.dirty = this.generation !== generation;
                this.status = this.online ? 'current' : this.dirty ? 'offline-unsynced' : 'cached-placeholder';
                this.reason = this.online ? null : 'offline';
                this.send('invalidated', result.revision);
                this.record('server-applied');
            }
            catch
            {
                if (this.isCurrentOperation(epoch))
                {
                    this.status = this.online ? 'failed' : 'offline-unsynced';
                    this.reason = 'server_write_failed';
                    this.record('server-write-failed');
                }
            }
            finally
            {
                this.send('flush-end', this.observation?.revision ?? revision);
            }
        };
        this.flushTask = (async () =>
        {
            if (this.lease)
            {
                const acquired = await this.lease.run(this.scopeDigest, operation);
                if (!acquired && this.isCurrentOperation(epoch))
                {
                    this.peerLeaseUntil = this.clock.now() + workspaceSnapshotSyncPolicy.debounceMs;
                }
            }
            else
            {
                await operation();
            } // CAS is also the concurrency authority when Web Locks is unavailable.
        })();
        try
        {
            await this.flushTask;
        }
        catch
        {
            if (this.isCurrentOperation(epoch))
            {
                // A denied coordination mechanism never grants a competing local writer.
                this.status = this.online ? 'failed' : 'offline-unsynced';
                this.reason = 'flush_coordination_failed';
                this.record('flush-coordination-failed');
            }
        }
        finally
        {
            this.flushTask = null;
            if (this.readAfterFlush && !this.stopped)
            {
                this.readAfterFlush = false;
                await this.readServer('channel');
            }
            this.scheduleFlush();
        }
    }
    public acceptServerAfterConflict(): void
    {
        if (this.stopped || this.status !== 'conflict' || !this.pendingServer)
        {
            return;
        }
        // Explicit choice discards only current-session layout; it never sends a force-overwrite command.
        this.adopt(this.pendingServer);
        this.pendingServer = null;
        this.record('accepted-server');
    }
    public async reset(confirmed: boolean, expectedRevision: number, confirmationDigest: string): Promise<void>
    {
        if (!confirmed || this.stopped)
        {
            return;
        }
        this.clearDebounce();
        if (!this.online || this.dirty || this.flushTask || this.resetting
            || expectedRevision !== this.observation?.revision || this.status === 'conflict')
        {
            throw new AuthoringWorkspaceSnapshotError('reset_requires_current_server');
        }
        const generation = this.generation;
        const epoch = this.lifecycleEpoch;
        this.resetting = true;
        this.record('reset-start');
        try
        {
            const result = await this.api.reset(expectedRevision, confirmationDigest, this.abort.signal);
            if (!this.isCurrentOperation(epoch) || !this.hasAuthority(result))
            {
                return;
            }
            if (result.status === 'conflict')
            {
                this.status = 'conflict';
                this.reason = 'stale_revision';
                await this.readServer('conflict');
                return;
            }
            if (this.generation === generation)
            {
                this.adopt(result);
            }
            else
            {
                // Layout changes after confirmation remain current-session unsynced state.
                this.observation = result;
                this.status = 'current';
                this.reason = null;
            }
            const cacheStatus = await this.cache.verifyAndReplace(result);
            if (!this.isCurrentOperation(epoch) || !this.hasAuthority(result))
            {
                return;
            }
            this.cacheStatus = cacheStatus;
            this.send('invalidated', result.revision);
            this.record('server-reset');
        }
        finally
        {
            if (!this.stopped && epoch === this.lifecycleEpoch)
            {
                this.resetting = false;
                this.record('reset-end');
                this.scheduleFlush();
            }
        }
    }
    public async stop(clearScope = true): Promise<void>
    {
        this.stopped = true;
        this.lifecycleEpoch++;
        this.reading++;
        this.abort.abort();
        this.api.invalidateObservations();
        this.clearDebounce();
        if (this.periodic !== null)
        {
            this.clock.clearTimeout(this.periodic);
        }
        this.periodic = null;
        this.unsubscribe();
        this.channel?.close();
        this.listeners.clear();
        this.observation = null;
        this.pendingServer = null;
        this.cacheRead = null;
        this.memory = defaultWorkspaceSnapshotLayout();
        this.dirty = false;
        this.resetting = false;
        this.status = 'defaulted';
        this.reason = 'scope_closed';
        this.online = false;
        this.cacheStatus = 'missing';
        this.events.length = 0;
        // Wait for an already issued cache write before scoped cleanup; a late response cannot recreate it.
        if (this.flushTask)
        {
            await this.flushTask;
        }
        if (clearScope)
        {
            await this.cache.clearCurrentScope();
        }
        this.cache.close();
    }
    private async readServer(trigger: 'startup' | 'reconnect' | 'conflict' | 'channel'): Promise<void>
    {
        if (this.stopped || !this.online)
        {
            return;
        }
        const ticket = ++this.reading;
        const epoch = this.lifecycleEpoch;
        try
        {
            const server = await this.api.read(this.abort.signal);
            if (!this.isCurrentOperation(epoch) || ticket !== this.reading || !this.hasAuthority(server))
            {
                return;
            }
            if (this.observation && server.revision < this.observation.revision)
            {
                return;
            }
            const cacheStatus = await this.cache.verifyAndReplace(server);
            if (!this.isCurrentOperation(epoch) || ticket !== this.reading || !this.hasAuthority(server))
            {
                return;
            }
            this.cacheStatus = cacheStatus;
            if (server.status === 'blocked')
            {
                this.status = 'blocked';
                this.reason = server.receipt.reason;
                this.observation = null;
                if (!this.dirty)
                {
                    this.memory = defaultWorkspaceSnapshotLayout();
                }
            }
            else if (trigger === 'conflict' || (this.dirty && server.revision !== this.observation?.revision))
            {
                this.pendingServer = server;
                this.status = 'conflict';
                this.reason = 'server_revision_changed';
            }
            else if (this.dirty)
            {
                this.observation = server;
                this.status = 'current';
                this.reason = null;
            }
            else
            {
                this.adopt(server);
            }
            this.record(`server-read-${trigger}`);
        }
        catch (error)
        {
            if (!this.isCurrentOperation(epoch) || ticket !== this.reading)
            {
                return;
            }
            this.status = this.cacheRead?.status === 'cached-placeholder' && !this.dirty ? 'cached-placeholder' : 'failed';
            this.reason = error instanceof AuthoringWorkspaceSnapshotError ? error.reason : 'server_read_failed';
            this.record('server-read-failed');
        }
    }
    private adopt(server: AuthoringWorkspaceServerObservation): void
    {
        requireWorkspaceServerObservation(server);
        this.observation = server;
        this.memory = structuredClone(server.snapshot?.layout ?? defaultWorkspaceSnapshotLayout());
        this.dirty = false;
        this.status = server.status === 'missing' ? 'defaulted' : 'current';
        this.reason = null;
    }
    private canFlush(): boolean
    {
        return !this.stopped && !this.resetting && this.online && this.dirty && this.hasAuthority(this.observation)
            && (this.status === 'current' || this.status === 'defaulted');
    }
    private isCurrentOperation(epoch: number): boolean
    {
        return !this.stopped && this.online && epoch === this.lifecycleEpoch;
    }
    private hasAuthority(observation: AuthoringWorkspaceServerObservation | null): boolean
    {
        if (observation === null)
        {
            return false;
        }
        try
        {
            requireWorkspaceServerObservation(observation);
            return true;
        }
        catch
        {
            return false;
        }
    }
    private scheduleFlush(): void
    {
        this.clearDebounce();
        if (!this.canFlush() || this.flushTask)
        {
            return;
        }
        const delay = Math.max(1, Math.min(workspaceSnapshotSyncPolicy.debounceMs, workspaceSnapshotSyncPolicy.maxWaitMs - (this.clock.now() - this.dirtySince)), this.peerLeaseUntil - this.clock.now());
        this.debounce = this.clock.setTimeout(() =>
        {
            this.debounce = null;
            void this.flush('debounce');
        }, delay);
    }
    private schedulePeriodic(): void
    {
        if (this.stopped)
        {
            return;
        }
        this.periodic = this.clock.setTimeout(() =>
        {
            this.periodic = null;
            void this.flush('periodic');
            this.schedulePeriodic();
        }, workspaceSnapshotSyncPolicy.safetyFlushMs);
    }
    private clearDebounce(): void
    {
        if (this.debounce !== null)
        {
            this.clock.clearTimeout(this.debounce);
        }
        this.debounce = null;
    }
    private send(kind: ChannelMessage['kind'], revision: number): void
    {
        if (this.stopped)
        {
            return;
        }
        try
        {
            this.channel?.send({ schema: workspaceSnapshotSyncPolicy.channelSchema, scopeDigest: this.scopeDigest,
                sourceDigest: this.api.sourceDigest, ownerRef: this.ownerRef, kind, revision,
                leaseUntil: kind === 'flush-start' ? this.clock.now() + workspaceSnapshotSyncPolicy.leaseMs : 0 });
        }
        catch
        {
            this.record('channel-unavailable');
        }
    }
    private onChannel(value: unknown): void
    {
        if (this.stopped)
        {
            return;
        }
        try
        {
            workspaceSnapshotExact(value, ['schema', 'scopeDigest', 'sourceDigest', 'ownerRef', 'kind', 'revision', 'leaseUntil']);
            if (value.schema !== workspaceSnapshotSyncPolicy.channelSchema || value.scopeDigest !== this.scopeDigest
                || value.sourceDigest !== this.api.sourceDigest || value.ownerRef === this.ownerRef || !workspaceSnapshotId(value.ownerRef)
                || !['flush-start', 'flush-end', 'invalidated'].includes(value.kind as string)
                || !workspaceSnapshotInteger(value.revision) || !workspaceSnapshotInteger(value.leaseUntil)
                || value.leaseUntil > this.clock.now() + workspaceSnapshotSyncPolicy.leaseMs)
            {
                return;
            }
            if (value.kind === 'flush-start')
            {
                this.peerLeaseUntil = Math.max(this.peerLeaseUntil, value.leaseUntil);
            }
            if (value.kind === 'flush-end')
            {
                this.peerLeaseUntil = 0;
                this.scheduleFlush();
            }
            if (value.kind === 'invalidated' && value.revision > (this.observation?.revision ?? -1))
            {
                this.clearDebounce();
                if (this.dirty)
                {
                    this.status = 'conflict';
                    this.reason = 'peer_revision_changed';
                }
                if (this.flushTask)
                {
                    this.readAfterFlush = true;
                }
                else
                {
                    void this.readServer('channel');
                }
            }
            this.record(`channel-${String(value.kind)}`);
        }
        catch
        { /* Untrusted cross-tab payloads cannot hydrate memory, snapshot, cache or registry. */ }
    }
    private record(kind: string): void
    {
        if (this.stopped)
        {
            return;
        }
        this.events.push({ kind, revision: this.observation?.revision ?? null, status: this.getState().status });
        if (this.events.length > workspaceSnapshotSyncPolicy.maxEvents)
        {
            this.events.shift();
        }
        for (const listener of this.listeners)
        {
            listener();
        }
    }
}
export class AuthoringWorkspaceSnapshotBroadcastChannel implements WorkspaceSnapshotCoordinationChannel
{
    private readonly listeners = new Set<(value: unknown) => void>();
    private readonly channel: BroadcastChannel;
    public constructor(scopeDigest: string)
    {
        this.channel = new BroadcastChannel(`fsusblog.authoring-workspace:${scopeDigest}`);
        this.channel.onmessage = event =>
        {
            for (const listener of this.listeners)
            {
                listener(event.data);
            }
        };
    }
    public send(message: ChannelMessage): void
    {
        this.channel.postMessage(message);
    }
    public subscribe(listener: (value: unknown) => void): () => void
    {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    public close(): void
    {
        this.listeners.clear();
        this.channel.close();
    }
}
export class AuthoringWorkspaceSnapshotWebLocks implements WorkspaceSnapshotFlushLease
{
    private readonly locks: LockManager;
    public constructor(locks: LockManager)
    {
        this.locks = locks;
    }
    public async run(name: string, operation: () => Promise<void>): Promise<boolean>
    {
        return this.locks.request(`fsusblog.authoring-workspace:${name}`, { ifAvailable: true }, async (lock) =>
        {
            if (!lock)
            {
                return false;
            }
            await operation();
            return true;
        });
    }
}
export function bindWorkspaceSnapshotFlushBoundaries(sync: AuthoringWorkspaceSnapshotSync, windowTarget: Window, documentTarget: Document): () => void
{
    const pagehide = (): void =>
    {
        void sync.flush('pagehide');
    };
    const visibility = (): void =>
    {
        if (documentTarget.visibilityState === 'hidden')
        {
            void sync.flush('hidden');
        }
    };
    const online = (): void =>
    {
        void sync.setOnline(true);
    };
    const offline = (): void =>
    {
        void sync.setOnline(false);
    };
    windowTarget.addEventListener('pagehide', pagehide);
    windowTarget.addEventListener('online', online);
    windowTarget.addEventListener('offline', offline);
    documentTarget.addEventListener('visibilitychange', visibility);
    return () =>
    {
        windowTarget.removeEventListener('pagehide', pagehide);
        windowTarget.removeEventListener('online', online);
        windowTarget.removeEventListener('offline', offline);
        documentTarget.removeEventListener('visibilitychange', visibility);
    };
}
