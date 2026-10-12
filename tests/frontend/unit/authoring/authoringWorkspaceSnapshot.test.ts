import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoringWorkspaceSnapshotApi, requireWorkspaceServerObservation, defaultWorkspaceSnapshotLayout, validateWorkspaceSnapshot, validateWorkspaceSnapshotLayout, workspaceSnapshotBytes, workspaceSnapshotDigest, type AuthoringWorkspaceSnapshot, type AuthoringWorkspaceSnapshotLayout, type AuthoringWorkspaceSnapshotReceipt, type AuthoringWorkspaceSnapshotResult, type AuthoringWorkspaceSnapshotScope, type AuthoringWorkspaceSnapshotTransport } from '@/api/authoringWorkspaceSnapshot';
import { AuthoringWorkspaceSnapshotCache, AuthoringWorkspaceSnapshotIndexedDbStorage, workspaceSnapshotCachePolicy, type WorkspaceSnapshotCacheStorage } from '@/services/authoring/authoringWorkspaceSnapshotCache';
import { AuthoringWorkspaceSnapshotSync, workspaceSnapshotSyncPolicy, type WorkspaceSnapshotCoordinationChannel } from '@/services/authoring/authoringWorkspaceSnapshotSync';
import { applyAuthoringWorkspaceSnapshotRestore, prepareAuthoringWorkspaceSnapshotRestore, verifyAuthoringWorkspaceSnapshotRestorePlan, workspaceSnapshotRestorePolicy, type AuthoringWorkspaceSnapshotResolution, type AuthoringWorkspaceSnapshotResolutionPort } from '@/services/authoring/authoringWorkspaceSnapshotRestore';
import { migrateAuthoringWorkspaceSnapshotLegacy, workspaceSnapshotLegacyInventory } from '@/services/authoring/authoringWorkspaceSnapshotMigration';
import { authoringWorkspaceSnapshotStatusModel, AuthoringWorkspaceSnapshotResetController } from '@/services/authoring/authoringWorkspaceSnapshotStatus';
import { ArticleWorkspaceTabRouter } from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringTabGroupRegistry } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';
import { bindAuthoringWorkspaceSnapshotBootstrapGroups, prepareAuthoringWorkspaceSnapshotBootstrap } from '@/services/authoring/authoringWorkspaceSnapshotBootstrap';
const scope = { userId: 1, siteId: 'site:primary' };
const sourceDigest = 'a'.repeat(64);
const now = 1800000000000;
function layout(count = 1, twoGroups = false): AuthoringWorkspaceSnapshotLayout {
    const result = defaultWorkspaceSnapshotLayout();
    result.tabs = Array.from({ length: count }, (_, index) => ({ tabId: `tab:${String(index).padStart(3, '0')}`,
        identity: { articleId: index + 1, draftId: `draft:${String(index).padStart(3, '0')}`, documentId: `document:${String(index).padStart(3, '0')}` },
        isPreview: false, isPinned: true }));
    const ids = result.tabs.map(tab => tab.tabId);
    result.groups = [{ groupId: 'group:primary', tabIds: twoGroups ? ids.filter((_, index) => index % 2 === 0) : ids,
            activeTabId: ids[0] ?? null }];
    if (twoGroups)
        result.groups.push({ groupId: 'group:secondary', tabIds: ids.filter((_, index) => index % 2 === 1), activeTabId: ids[1] ?? null });
    return result;
}
function snapshot(value = layout(), revision = 1): AuthoringWorkspaceSnapshot {
    const unsigned = { schemaVersion: 1 as const, workspaceId: 'default' as const, scope: structuredClone(scope),
        sourceContract: 'fsusblog.authoring-workspace-snapshot.v1' as const, sourceDigest, revision, updatedAt: now, layout: value };
    return { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
}
function response(value: AuthoringWorkspaceSnapshot | null, action: 'read' | 'write' | 'reset' = 'read', status: AuthoringWorkspaceSnapshotResult['status'] = value ? 'current' : 'missing', revisionBefore = value?.revision ?? 0, inputDigest = workspaceSnapshotDigest(scope)): AuthoringWorkspaceSnapshotResult {
    const receipt: AuthoringWorkspaceSnapshotReceipt = {
        schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1', action, status, reason: status === 'conflict' ? 'stale_revision' : null,
        scope: structuredClone(scope), workspaceId: 'default', sourceDigest, revisionBefore, revisionAfter: value?.revision ?? revisionBefore,
        tabCount: value?.layout.tabs.length ?? 0, byteCount: value ? workspaceSnapshotBytes(value) : 0,
        inputDigest, snapshotDigest: value?.contentDigest ?? null, contentDigest: ''
    };
    return { status, revision: receipt.revisionAfter, snapshot: value,
        receipt: { ...receipt, contentDigest: workspaceSnapshotDigest(receipt) } };
}
// This is a test transport, not a runtime/local authority. Production requires the owner's authenticated AEDS port.
class Server implements AuthoringWorkspaceSnapshotTransport {
    public current: AuthoringWorkspaceSnapshot | null = snapshot();
    public writes: {
        expectedRevision: number;
        layout: AuthoringWorkspaceSnapshotLayout;
    }[] = [];
    public reads = 0;
    public failRead = false;
    public failWrite = false;
    public afterWrite: (() => void) | null = null;
    public afterReset: (() => Promise<void>) | null = null;
    public async read(): Promise<unknown> {
        this.reads++;
        if (this.failRead)
            throw new Error('server_read_failed');
        return structuredClone(response(this.current));
    }
    public async write(command: {
        expectedRevision: number;
        layout: AuthoringWorkspaceSnapshotLayout;
    }): Promise<unknown> {
        this.writes.push(structuredClone(command));
        if (this.failWrite)
            throw new Error('server_write_failed');
        const currentRevision = this.current?.revision ?? 0;
        const inputDigest = workspaceSnapshotDigest(command);
        if (command.expectedRevision !== currentRevision)
            return response(null, 'write', 'conflict', currentRevision, inputDigest);
        this.current = snapshot(structuredClone(command.layout), currentRevision + 1);
        const result = response(this.current, 'write', 'applied', currentRevision, inputDigest);
        this.afterWrite?.();
        return structuredClone(result);
    }
    public async reset(command: {
        expectedRevision: number;
        confirmationDigest: string;
    }): Promise<unknown> {
        const value = defaultWorkspaceSnapshotLayout();
        const revision = this.current?.revision ?? 0;
        const inputDigest = workspaceSnapshotDigest({ expectedRevision: command.expectedRevision, layout: value });
        if (command.expectedRevision !== revision)
            return response(null, 'reset', 'conflict', revision, inputDigest);
        this.current = snapshot(value, revision + 1);
        const result = response(this.current, 'reset', 'applied', revision, inputDigest);
        if (this.afterReset)
            await this.afterReset();
        return result;
    }
}
class CacheStorage implements WorkspaceSnapshotCacheStorage {
    public records = new Map<string, unknown>();
    public replacements = 0;
    public fail = false;
    public async get(key: string): Promise<unknown> { if (this.fail)
        throw new Error('quota'); return structuredClone(this.records.get(key)); }
    public async replace(record: Parameters<WorkspaceSnapshotCacheStorage['replace']>[0]): Promise<void> {
        if (this.fail)
            throw new Error('quota');
        this.replacements++;
        this.records.set(record.key, structuredClone(record));
    }
    public async remove(key: string): Promise<void> { this.records.delete(key); }
    public close(): void { }
}
class ChannelHub {
    public messages: unknown[] = [];
    public listeners = new Set<(value: unknown) => void>();
    public create(): WorkspaceSnapshotCoordinationChannel {
        const own = new Set<(value: unknown) => void>();
        return {
            send: message => { this.messages.push(structuredClone(message)); for (const listener of this.listeners)
                listener(message); },
            subscribe: listener => { this.listeners.add(listener); own.add(listener); return () => this.listeners.delete(listener); },
            close: () => { for (const listener of own)
                this.listeners.delete(listener); }
        };
    }
}
const active: AuthoringWorkspaceSnapshotSync[] = [];
function setup(server = new Server(), storage = new CacheStorage(), channel: WorkspaceSnapshotCoordinationChannel | null = null, ownerRef = 'browser:first') {
    const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => now);
    const cache = new AuthoringWorkspaceSnapshotCache(storage, scope, sourceDigest, () => now);
    const sync = new AuthoringWorkspaceSnapshotSync(api, cache, channel, ownerRef);
    active.push(sync);
    return { server, storage, api, cache, sync };
}
function resolution(observation: Awaited<ReturnType<AuthoringWorkspaceSnapshotApi['read']>>): AuthoringWorkspaceSnapshotResolution {
    const unsigned = { schema: workspaceSnapshotRestorePolicy.resolutionSchema, scopeDigest: workspaceSnapshotDigest(scope),
        sourceDigest, snapshotRevision: observation.revision, snapshotDigest: observation.snapshot!.contentDigest,
        facts: observation.snapshot!.layout.tabs.map(tab => ({ tabId: tab.tabId, state: 'allowed' as const,
            currentIdentity: structuredClone(tab.identity), documentContext: { documentEpoch: 1, sourceRevision: 'source:001', draftRevision: 'revision:001' }, permissionRef: 'permission:current' })) };
    return { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => { for (const sync of active.splice(0))
    await sync.stop(false); vi.useRealTimers(); });
describe('server snapshot boundaries', () => {
    it('matches the shared canonical UTF-8 fixture and C# digest', () => {
        const golden = JSON.parse(readFileSync(new URL('../../../fixtures/authoring-workspace/snapshot-current.json', import.meta.url), 'utf8'));
        validateWorkspaceSnapshot(golden, scope, sourceDigest, now);
        expect(golden.contentDigest).toBe('684e72bc43e7c3592266938dcd4087079c280f984bfdec1ca168bcc082f38249');
        expect(snapshot(defaultWorkspaceSnapshotLayout()).contentDigest).toBe(golden.contentDigest);
    });
    it.each([0, 1, 20, 100])('validates %i tabs without body or editor state', count => {
        const value = snapshot(layout(count, true));
        expect(() => validateWorkspaceSnapshot(value, scope, sourceDigest, now)).not.toThrow();
        expect(workspaceSnapshotBytes(value)).toBeLessThanOrEqual(65536);
    });
    it.each(['name', 'workspaces', 'body', 'undo', 'selection', 'html', 'attachmentBytes', 'journal', 'token'])('rejects %s at every nested boundary', field => {
        for (const path of ['root', 'layout', 'shell', 'tab', 'identity', 'group', 'scope']) {
            const value = snapshot() as unknown as Record<string, any>;
            const target = path === 'root' ? value : path === 'layout' ? value.layout : path === 'shell' ? value.layout.shell
                : path === 'scope' ? value.scope : path === 'group' ? value.layout.groups[0]
                    : path === 'tab' ? value.layout.tabs[0] : value.layout.tabs[0].identity;
            target[field] = 'forbidden';
            expect(() => validateWorkspaceSnapshot(value, scope, sourceDigest, now)).toThrow();
        }
    });
    it('rejects mirror/third-group/orphan and mismatched source/user/site/revision/schema', () => {
        const mirror = layout(2);
        mirror.groups.push({ groupId: 'group:secondary', tabIds: ['tab:000'], activeTabId: 'tab:000' });
        expect(() => validateWorkspaceSnapshotLayout(mirror)).toThrow('orphan_or_mirrored_tab');
        const third = layout(0, true);
        third.groups.push({ groupId: 'group:third', tabIds: [], activeTabId: null });
        expect(() => validateWorkspaceSnapshotLayout(third)).toThrow();
        expect(() => validateWorkspaceSnapshot(snapshot(layout(101)), scope, sourceDigest, now)).toThrow();
        expect(() => validateWorkspaceSnapshot(snapshot(), { ...scope, userId: 2 }, sourceDigest, now)).toThrow();
        expect(() => validateWorkspaceSnapshot(snapshot(), { ...scope, siteId: 'site:other' }, sourceDigest, now)).toThrow();
        expect(() => validateWorkspaceSnapshot(snapshot(), scope, 'b'.repeat(64), now)).toThrow();
        expect(() => validateWorkspaceSnapshot({ ...snapshot(), revision: 2 }, scope, sourceDigest, now)).toThrow();
        expect(() => validateWorkspaceSnapshot({ ...snapshot(), schemaVersion: 2 }, scope, sourceDigest, now)).toThrow('future_schema');
        expect(() => validateWorkspaceSnapshot({ ...snapshot(), workspaceId: 'second' }, scope, sourceDigest, now)).toThrow();
    });
    it('verifies server receipts, immutable provenance and rejects a forged/cache-origin restore', async () => {
        const { api, cache } = setup();
        const observed = await api.read();
        expect(Object.isFrozen(observed.snapshot!.layout)).toBe(true);
        expect(() => { observed.snapshot!.layout.groups[0].tabIds.push('tab:tamper'); }).toThrow();
        await expect(cache.verifyAndReplace(structuredClone(observed))).rejects.toThrow('server_observation_required');
        await expect(prepareAuthoringWorkspaceSnapshotRestore(structuredClone(observed), { resolveBatch: vi.fn() }, 0, new AbortController().signal))
            .rejects.toThrow('server_observation_required');
        const forged = response(snapshot());
        forged.receipt.byteCount++;
        const bad = new AuthoringWorkspaceSnapshotApi({ read: async () => forged, write: vi.fn(), reset: vi.fn() }, scope, sourceDigest, () => now);
        await expect(bad.read()).rejects.toThrow('receipt_digest_mismatch');
    });
});
// Pending ordinary controls only: no runtime/attack/list execution or auth qualification is claimed.
describe('sealed snapshot API custody and irreversible lifetime', () => {
    it('pins genuine port functions and refuses reflection, old-response replay and close ABA', async () => {
        const server = new Server();
        const oldResponse = await server.read();
        let active = true;
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => now, () => {
            if (!active)
                throw new Error('connection_expired');
        });
        server.current = snapshot(layout(), 2);
        server.read = vi.fn(async () => oldResponse);
        const observed = await api.read();
        expect(observed.revision).toBe(2);
        expect(server.read).not.toHaveBeenCalled();
        expect(Object.isFrozen(api)).toBe(true);
        expect(Object.isFrozen(AuthoringWorkspaceSnapshotApi.prototype)).toBe(true);
        for (const name of ['transport', 'lifecycleGeneration', 'readSequence', 'verify', 'checkLifecycle', 'now', 'assertConnection', 'closed', 'scope', 'sourceDigest', 'read', 'close', 'invalidateObservations'])
            expect(Reflect.defineProperty(api, name, { value: () => oldResponse })).toBe(false);
        expect(Reflect.set(AuthoringWorkspaceSnapshotApi.prototype, 'read', () => oldResponse)).toBe(false);
        const confirmation = api.resetConfirmation(2);
        const reads = server.reads;
        active = false;
        api.close();
        api.close();
        active = true;
        api.invalidateObservations();
        await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
        await expect(api.write(2, layout())).rejects.toThrow('workspace_snapshot_connection_closed');
        await expect(api.reset(2, confirmation)).rejects.toThrow('workspace_snapshot_connection_closed');
        expect(() => api.resetConfirmation(2)).toThrow('workspace_snapshot_connection_closed');
        expect(() => requireWorkspaceServerObservation(observed)).toThrow('server_observation_required');
        expect(server.reads).toBe(reads);
        expect(server.writes).toHaveLength(0);
        expect(server.current.revision).toBe(2);
    });
    it('latches an external lifetime failure even if the supplied guard later allows again', async () => {
        const server = new Server();
        let active = true;
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => now, () => {
            if (!active)
                throw new Error('connection_expired');
        });
        const observed = await api.read();
        active = false;
        expect(() => requireWorkspaceServerObservation(observed)).toThrow('connection_expired');
        active = true;
        await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
        expect(() => requireWorkspaceServerObservation(observed)).toThrow('server_observation_required');
    });
    it.each(['read', 'write', 'reset'] as const)('refuses %s publication when closed after dispatch but before a valid old response returns', async action => {
        const server = new Server();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const port: AuthoringWorkspaceSnapshotTransport = {
            read: async () => { const result = await server.read(); await gate; return result; },
            write: async command => { const result = await server.write(command); await gate; return result; },
            reset: async command => { const result = await server.reset(command); await gate; return result; }
        };
        const api = new AuthoringWorkspaceSnapshotApi(port, scope, sourceDigest, () => now);
        const pending = action === 'read' ? api.read() : action === 'write' ? api.write(1, layout())
            : api.reset(1, api.resetConfirmation(1));
        api.close();
        release();
        await expect(pending).rejects.toThrow('workspace_snapshot_connection_closed');
        await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
    });
    it('rechecks lifetime after the clock callback during verification before it can issue', async () => {
        const server = new Server();
        let closeDuringClock = false;
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => {
            if (closeDuringClock)
                api.close();
            return now;
        });
        const observed = await api.read();
        closeDuringClock = true;
        await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
        expect(() => requireWorkspaceServerObservation(observed)).toThrow('server_observation_required');
    });
    it('checks exception reentry and keeps ordinary invalidation distinct from permanent close', async () => {
        const server = new Server();
        let invalidateDuringClock = false;
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => {
            if (invalidateDuringClock) {
                api.invalidateObservations();
                throw new Error('clock_failed');
            }
            return now;
        });
        const observed = await api.read();
        invalidateDuringClock = true;
        await expect(api.read()).rejects.toThrow('server_observation_superseded');
        expect(() => requireWorkspaceServerObservation(observed)).toThrow('server_observation_required');
        invalidateDuringClock = false;
        requireWorkspaceServerObservation(await api.read());
        api.close();
        await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
    });
    it('cannot publish after cloning a valid retained response reenters close', async () => {
        const server = new Server();
        const raw = await server.read();
        const api = new AuthoringWorkspaceSnapshotApi({ read: async () => raw,
            write: server.write.bind(server), reset: server.reset.bind(server) }, scope, sourceDigest, () => now);
        const clone = globalThis.structuredClone.bind(globalThis);
        const cloning = vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
            const result = clone(value);
            if (value === raw)
                api.close();
            return result;
        });
        try {
            await expect(api.read()).rejects.toThrow('workspace_snapshot_connection_closed');
        } finally {
            cloning.mockRestore();
        }
        expect(() => Reflect.apply(requireWorkspaceServerObservation, undefined, [raw])).toThrow('server_observation_required');
    });
    it('refuses a stale ticket when a verification callback starts a newer genuine read', async () => {
        const server = new Server();
        let reenter = false;
        let newer: Promise<Awaited<ReturnType<AuthoringWorkspaceSnapshotApi['read']>>> | undefined;
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => {
            if (reenter) {
                reenter = false;
                newer = api.read();
            }
            return now;
        });
        await api.read();
        reenter = true;
        await expect(api.read()).rejects.toThrow('server_read_superseded');
        expect(newer).toBeDefined();
        if (!newer)
            throw new Error('newer_read_missing');
        requireWorkspaceServerObservation(await newer);
    });
});
describe('verified non-authoritative cache', () => {
    it('stores server success only and reports missing/current/stale with finite expiry', async () => {
        const { api, cache, storage } = setup();
        expect((await cache.read()).status).toBe('missing');
        await cache.verifyAndReplace(await api.read());
        expect((await cache.read()).status).toBe('cached-placeholder');
        expect(storage.replacements).toBe(1);
        const stale = new AuthoringWorkspaceSnapshotCache(storage, scope, sourceDigest, () => now + workspaceSnapshotCachePolicy.maxAgeMs);
        expect((await stale.read()).status).toBe('stale');
    });
    it.each(['scope', 'sourceDigest', 'schemaVersion', 'serverRevision', 'snapshotBytes', 'fetchedAt', 'contentDigest'])('rejects cache tamper of %s even with recomputed record hash', async (field) => {
        const { api, cache, storage } = setup();
        await cache.verifyAndReplace(await api.read());
        const [key, row] = [...storage.records.entries()][0] as [
            string,
            Record<string, unknown>
        ];
        if (field === 'scope')
            row.scope = { userId: 2, siteId: scope.siteId };
        else if (field === 'snapshotBytes')
            row.snapshotBytes = JSON.stringify({ ...snapshot(), name: 'bad' });
        else if (field === 'sourceDigest' || field === 'contentDigest')
            row[field] = 'b'.repeat(64);
        else
            row[field] = field === 'fetchedAt' ? now + 1 : 9;
        if (field !== 'contentDigest') {
            const { contentDigest: _, ...unsigned } = row;
            row.contentDigest = workspaceSnapshotDigest(unsigned);
        }
        storage.records.set(key, row);
        expect((await cache.read()).status).toBe('invalid');
    });
    it('quota/private-mode/IDB denial does not become server or permanent local fallback', async () => {
        const { api, cache, storage, sync, server } = setup();
        storage.fail = true;
        expect((await cache.read()).status).toBe('unavailable');
        expect(await cache.verifyAndReplace(await api.read())).toBe('unavailable');
        await sync.start();
        expect(sync.getState().status).toBe('current');
        expect(server.writes).toHaveLength(0);
        const denied = new AuthoringWorkspaceSnapshotCache(new AuthoringWorkspaceSnapshotIndexedDbStorage(undefined), scope, sourceDigest, () => now);
        expect((await denied.read()).status).toBe('unavailable');
    });
    it('logout clears just the current scope and cancels memory/timers/channels', async () => {
        const hub = new ChannelHub();
        const { sync, storage, api, cache, server } = setup(undefined, undefined, hub.create());
        await cache.verifyAndReplace(await api.read());
        storage.records.set('another-user-scope', { retained: true });
        await sync.start();
        sync.onInteraction('shell', { ...layout(), shell: { ...layout().shell, inspectorOpen: true } });
        await sync.stop();
        await vi.advanceTimersByTimeAsync(60000);
        expect(server.writes).toHaveLength(0);
        expect(storage.records.size).toBe(1);
        expect(storage.records.has('another-user-scope')).toBe(true);
        expect(hub.listeners.size).toBe(0);
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(0);
    });
});
describe('bounded CAS sync, multi-tab and offline current-session state', () => {
    it('online startup replaces a placeholder with server; cache failure never writes a default', async () => {
        const { sync, api, cache, server } = setup();
        await cache.verifyAndReplace(await api.read());
        server.current = snapshot(layout(20), 2);
        await sync.start();
        expect(sync.getState().serverRevision).toBe(2);
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(20);
        expect(server.writes).toHaveLength(0);
        server.failRead = true;
        const other = setup(server);
        await other.sync.start();
        expect(other.sync.getState().status).toBe('failed');
        expect(other.sync.getServerObservation()).toBeNull();
        expect(server.writes).toHaveLength(0);
    });
    it('input/caret/scroll produce zero snapshot writes; layout changes batch and pagehide flushes once', async () => {
        const { sync, server } = setup();
        await sync.start();
        for (let index = 0; index < 100; index++) {
            sync.onInteraction('input');
            sync.onInteraction('caret');
            sync.onInteraction('scroll');
        }
        await vi.advanceTimersByTimeAsync(31000);
        expect(server.writes).toHaveLength(0);
        for (const ratio of [510, 520, 530])
            sync.onInteraction('splitter', { ...layout(), splitRatioPermille: ratio });
        expect(server.writes).toHaveLength(0);
        await sync.flush('pagehide');
        expect(server.writes).toHaveLength(1);
        expect(server.current!.layout.splitRatioPermille).toBe(530);
        await vi.advanceTimersByTimeAsync(1000);
        expect(server.writes).toHaveLength(1);
    });
    it('debounces, uses max-wait and hidden/periodic boundaries with finite event receipts', async () => {
        const { sync, server } = setup();
        await sync.start();
        for (let index = 0; index < 12; index++) {
            sync.onInteraction('splitter', { ...layout(), splitRatioPermille: 500 + index });
            await vi.advanceTimersByTimeAsync(200);
        }
        expect(server.writes.length).toBeGreaterThanOrEqual(1);
        expect(server.writes.length).toBeLessThanOrEqual(2);
        await sync.flush('hidden');
        expect(sync.getState().dirty).toBe(false);
        expect(sync.getReceipt().events.length).toBeLessThanOrEqual(workspaceSnapshotSyncPolicy.maxEvents);
        const { contentDigest, ...unsigned } = sync.getReceipt();
        expect(workspaceSnapshotDigest(unsigned)).toBe(contentDigest);
    });
    it('two devices without shared locks/channel still have one CAS winner and require server reread', async () => {
        const server = new Server();
        const first = setup(server);
        const second = setup(server, undefined, null, 'device:second');
        await Promise.all([first.sync.start(), second.sync.start()]);
        first.sync.onInteraction('tabs', layout(20));
        second.sync.onInteraction('tabs', layout(100));
        await Promise.all([first.sync.flush(), second.sync.flush()]);
        expect(server.current!.revision).toBe(2);
        expect(server.writes).toHaveLength(2);
        expect([first.sync.getState().status, second.sync.getState().status].sort()).toEqual(['conflict', 'current']);
        expect(server.reads).toBeGreaterThanOrEqual(3);
        await second.sync.acceptServerAfterConflict();
        expect(second.sync.getCurrentSessionLayout().tabs).toHaveLength(20);
        await vi.advanceTimersByTimeAsync(35000);
        expect(server.writes).toHaveLength(2);
    });
    it('multi-tab messages carry only scoped revisions/leases and cannot install snapshot authority', async () => {
        const server = new Server();
        const hub = new ChannelHub();
        const first = setup(server, undefined, hub.create());
        const second = setup(server, undefined, hub.create(), 'browser:second');
        await first.sync.start();
        await second.sync.start();
        second.sync.onInteraction('tabs', layout(100));
        first.sync.onInteraction('tabs', layout(20));
        await first.sync.flush();
        await Promise.resolve();
        await Promise.resolve();
        expect(second.sync.getState().status).toBe('conflict');
        expect(server.writes).toHaveLength(1);
        expect(JSON.stringify(hub.messages)).not.toMatch(/"snapshot"|"layout"|"tabs"|"body"/u);
        for (const listener of hub.listeners)
            listener({ schema: workspaceSnapshotSyncPolicy.channelSchema,
                scopeDigest: 'wrong', sourceDigest, ownerRef: 'browser:evil', kind: 'invalidated', revision: 900, leaseUntil: 0, snapshot: snapshot() });
        expect(second.sync.getState().serverRevision).toBe(1);
        expect(server.writes).toHaveLength(1);
    });
    it('offline changes remain in memory; changed server revision conflicts and never auto-overwrites', async () => {
        const { sync, server, storage } = setup();
        await sync.start();
        const cacheBefore = structuredClone([...storage.records.values()]);
        await sync.setOnline(false);
        sync.onInteraction('tabs', layout(100));
        await vi.advanceTimersByTimeAsync(60000);
        expect(sync.getState().status).toBe('offline-unsynced');
        expect(server.writes).toHaveLength(0);
        expect([...storage.records.values()]).toEqual(cacheBefore);
        server.current = snapshot(layout(20), 2);
        await sync.setOnline(true);
        expect(sync.getState().status).toBe('conflict');
        await vi.advanceTimersByTimeAsync(60000);
        expect(server.writes).toHaveLength(0);
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(100);
        await sync.acceptServerAfterConflict();
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(20);
    });
    it('same-revision reconnect rereads before flushing memory; offline startup cannot restore cached tabs', async () => {
        const { sync, server, api, cache, storage } = setup();
        await sync.start();
        await sync.setOnline(false);
        sync.onInteraction('tabs', layout(20));
        await sync.setOnline(true);
        expect(server.reads).toBe(2);
        expect(server.writes).toHaveLength(0);
        await sync.flush();
        expect(server.current!.layout.tabs).toHaveLength(20);
        await cache.verifyAndReplace(await api.read());
        const offline = setup(server, storage);
        await offline.sync.start(false);
        expect(offline.sync.getState().status).toBe('cached-placeholder');
        expect(offline.sync.getServerObservation()).toBeNull();
        expect(offline.sync.getCurrentSessionLayout().tabs).toHaveLength(0);
    });
    it('write failure retains unsynced memory and verified cache with no blind retry', async () => {
        const { sync, server, storage } = setup();
        await sync.start();
        const cached = structuredClone([...storage.records.values()]);
        server.failWrite = true;
        sync.onInteraction('tabs', layout(20));
        await sync.flush();
        expect(sync.getState().status).toBe('failed');
        expect(sync.getState().dirty).toBe(true);
        expect([...storage.records.values()]).toEqual(cached);
        await vi.advanceTimersByTimeAsync(60000);
        expect(server.writes).toHaveLength(1);
    });
    it('Web Locks denial retains unsynced memory without an uncoordinated fallback or timer rejection', async () => {
        const server = new Server();
        const storage = new CacheStorage();
        const api = new AuthoringWorkspaceSnapshotApi(server, scope, sourceDigest, () => now);
        const cache = new AuthoringWorkspaceSnapshotCache(storage, scope, sourceDigest, () => now);
        const lease = { run: vi.fn(async () => { throw new Error('web_locks_denied'); }) };
        const sync = new AuthoringWorkspaceSnapshotSync(api, cache, null, 'browser:denied', lease);
        active.push(sync);
        await sync.start();
        sync.onInteraction('tabs', layout(20));
        await vi.advanceTimersByTimeAsync(250);
        expect(sync.getState()).toMatchObject({ status: 'failed', dirty: true, reason: 'flush_coordination_failed' });
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(20);
        expect(server.writes).toHaveLength(0);
        expect(storage.replacements).toBe(1);
        await vi.advanceTimersByTimeAsync(30000);
        expect(lease.run).toHaveBeenCalledTimes(1);
        expect(server.writes).toHaveLength(0);
    });
    it('new input during in-flight flush remains dirty and caches only server-returned candidate', async () => {
        const { sync, server, cache } = setup();
        await sync.start();
        sync.onInteraction('tabs', layout(20));
        server.afterWrite = () => sync.onInteraction('tabs', layout(100));
        await sync.flush();
        expect(sync.getState().dirty).toBe(true);
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(100);
        const cached = await cache.read();
        expect(cached.status === 'cached-placeholder' && cached.snapshot.layout.tabs.length).toBe(20);
        server.afterWrite = null;
        await sync.flush();
        expect(server.current!.layout.tabs).toHaveLength(100);
    });
    it('reset requires confirmation/current server CAS and never uses a local reset fallback', async () => {
        const { sync, server, api } = setup();
        await sync.start();
        await sync.reset(false, 1, api.resetConfirmation(1));
        expect(server.current!.revision).toBe(1);
        await expect(sync.reset(true, 1, 'invalid')).rejects.toThrow('reset_confirmation_mismatch');
        server.current = snapshot(layout(20), 2);
        await sync.reset(true, 1, api.resetConfirmation(1));
        expect(server.current!.layout.tabs).toHaveLength(20);
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(1);
        expect(sync.getState().status).toBe('conflict');
        await sync.acceptServerAfterConflict();
        await sync.reset(true, 2, api.resetConfirmation(2));
        expect(server.current!.layout.tabs).toHaveLength(0);
        expect(server.current!.revision).toBe(3);
    });
    it('layout changes during a confirmed reset survive in memory and wait for the reset CAS result', async () => {
        const { sync, server, api, cache } = setup();
        await sync.start();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        // The original API pins port methods; defer the actual fixture CAS response inside that method.
        server.afterReset = () => gate;
        const resetting = sync.reset(true, 1, api.resetConfirmation(1));
        expect(authoringWorkspaceSnapshotStatusModel(sync).canReset).toBe(false);
        sync.onInteraction('tabs', layout(20));
        await vi.advanceTimersByTimeAsync(250);
        expect(server.writes).toHaveLength(0);
        await expect(sync.reset(true, 1, api.resetConfirmation(1))).rejects.toThrow('reset_requires_current_server');
        release();
        await resetting;
        expect(sync.getState()).toMatchObject({ resetting: false, dirty: true, serverRevision: 2 });
        expect(sync.getCurrentSessionLayout().tabs).toHaveLength(20);
        const cached = await cache.read();
        expect(cached.status === 'cached-placeholder' && cached.snapshot.layout.tabs.length).toBe(0);
        await sync.flush();
        expect(server.current!.revision).toBe(3);
        expect(server.current!.layout.tabs).toHaveLength(20);
    });
});
describe('server-only immutable restore planning and permission reconciliation', () => {
    it.each([0, 1, 20, 100])('plans %i refs in exactly one bounded batch, preserving two-group ownership', async (count) => {
        const { api, server } = setup();
        server.current = snapshot(layout(count, true));
        const observed = await api.read();
        const facts = resolution(observed);
        const resolveBatch = vi.fn(async () => facts);
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch }, 7, new AbortController().signal);
        expect(resolveBatch).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
        expect(plan.targets).toHaveLength(count);
        expect(plan.layout.groups).toHaveLength(2);
        expect(Object.isFrozen(plan.targets)).toBe(true);
        expect(verifyAuthoringWorkspaceSnapshotRestorePlan(plan, observed, facts)).toBe(true);
        expect(verifyAuthoringWorkspaceSnapshotRestorePlan({ ...plan, operationEpoch: 8 }, observed, facts)).toBe(false);
    });
    it('missing server state yields a legal empty plan with zero resolution calls and zero writes', async () => {
        const { api, server } = setup();
        server.current = null;
        const observed = await api.read();
        const resolveBatch = vi.fn();
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch }, 0, new AbortController().signal);
        expect(resolveBatch).not.toHaveBeenCalled();
        expect(plan.targets).toHaveLength(0);
        expect(plan.layout.groups).toHaveLength(1);
        expect(server.writes).toHaveLength(0);
    });
    it('deleted/archived/permission-revoked/draft-replaced refs do not block valid refs or leak metadata', async () => {
        const { api, server } = setup();
        server.current = snapshot(layout(6, true));
        const observed = await api.read();
        const facts = resolution(observed);
        const reasons = ['deleted', 'archived', 'denied', 'draft-replaced', 'missing'] as const;
        facts.facts.slice(0, 5).forEach((fact, index) => { fact.state = reasons[index]; fact.currentIdentity = null; fact.documentContext = null; fact.permissionRef = null; });
        const { contentDigest: _, ...unsigned } = facts;
        facts.contentDigest = workspaceSnapshotDigest(unsigned);
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => facts }, 0, new AbortController().signal);
        expect(plan.summary).toEqual({ restored: 1, skipped: 3, blocked: 2, reasons: { deleted: 1, archived: 1, denied: 1, 'draft-replaced': 1, missing: 1 } });
        expect(plan.layout.tabs[0].tabId).toBe('tab:005');
        expect(plan.layout.activeGroupId).toBe('group:secondary');
        expect(plan.layout.groups[1].activeTabId).toBe('tab:005');
        expect(plan.layout.groups[0].activeTabId).toBeNull();
        expect(JSON.stringify(plan.summary)).not.toMatch(/tab:|articleId|title|draftId/u);
    });
    it('rejects permission trust, disclosed denied identities, incomplete batch, source mismatch and tamper', async () => {
        const { api } = setup();
        const observed = await api.read();
        for (const mutation of ['denied-metadata', 'draft-mismatch', 'missing-fact', 'wrong-source', 'digest']) {
            const facts = resolution(observed);
            if (mutation === 'denied-metadata')
                facts.facts[0].state = 'denied';
            if (mutation === 'draft-mismatch')
                facts.facts[0].currentIdentity!.draftId = 'draft:replaced';
            if (mutation === 'missing-fact')
                facts.facts = [];
            if (mutation === 'wrong-source')
                facts.sourceDigest = 'b'.repeat(64);
            const { contentDigest: _, ...unsigned } = facts;
            facts.contentDigest = mutation === 'digest' ? 'b'.repeat(64) : workspaceSnapshotDigest(unsigned);
            await expect(prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => facts }, 0, new AbortController().signal)).rejects.toThrow();
        }
    });
    it('cancellation and unissued/cloned plan are rejected before any registry/group/shell commands', async () => {
        const { api } = setup();
        const observed = await api.read();
        const abort = new AbortController();
        abort.abort();
        const port: AuthoringWorkspaceSnapshotResolutionPort = { resolveBatch: vi.fn() };
        await expect(prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, abort.signal)).rejects.toThrow();
        expect(port.resolveBatch).not.toHaveBeenCalled();
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => resolution(observed) }, 0, new AbortController().signal);
        await expect(applyAuthoringWorkspaceSnapshotRestore(structuredClone(plan), {} as any, new AbortController().signal)).rejects.toThrow('prepared_server_plan_required');
    });
    it('offline/scope change and a newer server read invalidate old observations and prepared plans', async () => {
        const { sync, api, server } = setup();
        await sync.start();
        const observed = sync.getServerObservation()!;
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => resolution(observed) }, 0, new AbortController().signal);
        await sync.setOnline(false);
        await expect(prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: vi.fn() }, 0, new AbortController().signal)).rejects.toThrow('server_observation_required');
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, {} as any, new AbortController().signal)).rejects.toThrow('server_observation_required');
        await sync.setOnline(true);
        const newer = await api.read();
        server.current = snapshot(layout(20), 2);
        await api.read();
        await expect(prepareAuthoringWorkspaceSnapshotRestore(newer, { resolveBatch: vi.fn() }, 0, new AbortController().signal)).rejects.toThrow('server_observation_required');
    });
    it('unqualified FsusUI or absent group commands block execution before any session creation', async () => {
        const { api } = setup();
        const observed = await api.read();
        const port = { resolveBatch: async () => resolution(observed) };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const open = vi.spyOn(router, 'openOrActivate');
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, { router } as any, new AbortController().signal)).rejects.toThrow('restore_runtime_capability_required');
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, { router, resolutionPort: port,
            assertRuntimeCapability: () => { throw new Error('fsusui_not_qualified'); },
            applyGroups: vi.fn(), applyShell: vi.fn(), isCurrent: () => true }, new AbortController().signal)).rejects.toThrow('fsusui_not_qualified');
        expect(open).not.toHaveBeenCalled();
        expect(router.getRegistry().listEntries()).toHaveLength(0);
    });
    it('fresh permission/lifecycle batch changes force replan before touching the official registry', async () => {
        const { api } = setup();
        const observed = await api.read();
        const facts = resolution(observed);
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => facts }, 0, new AbortController().signal);
        facts.facts[0].state = 'denied';
        facts.facts[0].currentIdentity = null;
        facts.facts[0].documentContext = null;
        facts.facts[0].permissionRef = null;
        const { contentDigest: _, ...unsigned } = facts;
        facts.contentDigest = workspaceSnapshotDigest(unsigned);
        const router = new ArticleWorkspaceTabRouter();
        const commands = { router, resolutionPort: { resolveBatch: async () => facts }, assertRuntimeCapability: vi.fn(),
            applyGroups: vi.fn(), applyShell: vi.fn(), isCurrent: () => true };
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal)).rejects.toThrow('restore_resolution_changed');
        expect(router.getRegistry().listEntries()).toHaveLength(0);
        expect(commands.applyGroups).not.toHaveBeenCalled();
    });
    it('startup cached/default memory and unsynced interactions cannot authorize a bootstrap plan', async () => {
        const offline = setup();
        await offline.sync.start(false);
        const resolveBatch = vi.fn();
        await expect(prepareAuthoringWorkspaceSnapshotBootstrap(offline.sync, { resolveBatch }, 0, new AbortController().signal))
            .rejects.toThrow('current_server_read_required');
        expect(resolveBatch).not.toHaveBeenCalled();
        const current = setup();
        await current.sync.start();
        const changed = current.sync.getCurrentSessionLayout();
        changed.shell.inspectorOpen = !changed.shell.inspectorOpen;
        current.sync.onInteraction('shell', changed);
        await expect(prepareAuthoringWorkspaceSnapshotBootstrap(current.sync, { resolveBatch }, 0, new AbortController().signal))
            .rejects.toThrow('restore_superseded');
        expect(resolveBatch).not.toHaveBeenCalled();
    });
    it('bootstrap binds the real empty owner with explicitly reconciled group IDs', async () => {
        const { sync } = setup();
        await sync.start();
        const observed = sync.getServerObservation()!;
        const plan = await prepareAuthoringWorkspaceSnapshotBootstrap(sync, { resolveBatch: async () => resolution(observed) }, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
        const groupOwner = new AuthoringTabGroupRegistry(router.getRegistry(), {
            initialGroupId: plan.layout.activeGroupId, initialGroupIds: plan.layout.groups.map(group => group.groupId),
            ratioScope, splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 8
        });
        const before = router.getRegistry().exportState();
        const identity = vi.fn(() => ({ commandId: 'bootstrap:groups', idempotencyKey: 'bootstrap:groups' }));
        try
        {
            const bound = bindAuthoringWorkspaceSnapshotBootstrapGroups(plan, router, groupOwner, identity);
            expect(bound.groupOwner).toBe(groupOwner);
            expect(identity).not.toHaveBeenCalled();
            expect(router.getRegistry().exportState()).toEqual(before);
            expect(() => bindAuthoringWorkspaceSnapshotBootstrapGroups(plan, new ArticleWorkspaceTabRouter(), groupOwner, identity))
                .toThrow('restore_registry_binding_changed');
        }
        finally
        {
            authoringWorkspaceRatioOwner.releaseWorkspace(ratioScope);
        }
    });
    it('a digest-only group callback cannot restore or create sessions', async () => {
        const { api } = setup();
        const observed = await api.read();
        const port = { resolveBatch: async () => resolution(observed) };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const open = vi.spyOn(router, 'openOrActivate');
        const commands = { router, resolutionPort: port, assertRuntimeCapability: vi.fn(),
            applyGroups: vi.fn(async () => 'a'.repeat(64)), applyShell: vi.fn(), isCurrent: () => true };
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal)).rejects.toThrow('restore_group_receipt_capability_required');
        expect(open).not.toHaveBeenCalled();
        expect(commands.applyGroups).not.toHaveBeenCalled();
        expect(commands.applyShell).not.toHaveBeenCalled();
        expect(router.getRegistry().listEntries()).toHaveLength(0);
    });
    it('a genuine foreign group owner is refused before session creation or group publication', async () => {
        const { api } = setup();
        const observed = await api.read();
        const port = { resolveBatch: async () => resolution(observed) };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const foreignRouter = new ArticleWorkspaceTabRouter();
        const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
        const groupOwner = new AuthoringTabGroupRegistry(foreignRouter.getRegistry(), {
            initialGroupId: plan.layout.activeGroupId, initialGroupIds: plan.layout.groups.map(group => group.groupId),
            ratioScope, splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 8
        });
        const adapter = groupOwner.createSnapshotAdapter(() => ({ commandId: 'restore:foreign', idempotencyKey: 'restore:foreign' }));
        const open = vi.spyOn(router, 'openOrActivate');
        const before = router.getRegistry().exportState();
        const foreignBefore = foreignRouter.getRegistry().exportState();
        const commands = { router, resolutionPort: port, assertRuntimeCapability: vi.fn(), groupOwner,
            applyGroups: vi.fn(adapter.applyGroups), applyGroupsWithReceipt: vi.fn(adapter.applyGroupsWithReceipt),
            applyShell: vi.fn(), isCurrent: () => true };
        try
        {
            await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal)).rejects.toThrow('restore_registry_binding_changed');
            expect(open).not.toHaveBeenCalled();
            expect(commands.applyGroupsWithReceipt).not.toHaveBeenCalled();
            expect(commands.applyShell).not.toHaveBeenCalled();
            expect(router.getRegistry().exportState()).toEqual(before);
            expect(foreignRouter.getRegistry().exportState()).toEqual(foreignBefore);
        }
        finally
        {
            authoringWorkspaceRatioOwner.releaseWorkspace(ratioScope);
        }
    });
    it.each(['dispose', 'replace'] as const)('shell callback cannot %s the live ratio identity and return restored', async (action) => {
        // An untrusted shell digest is refusal input, never a qualified shell/runtime receipt.
        const { api, server } = setup();
        server.current = null;
        const observed = await api.read();
        const port = { resolveBatch: vi.fn() };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
        const groupOwner = new AuthoringTabGroupRegistry(router.getRegistry(), {
            initialGroupId: plan.layout.activeGroupId, initialGroupIds: plan.layout.groups.map(group => group.groupId),
            ratioScope, splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 8
        });
        const adapter = groupOwner.createSnapshotAdapter(() => ({ commandId: 'restore:empty', idempotencyKey: 'restore:empty' }));
        let disposed = false;
        const commands = { router, resolutionPort: port, assertRuntimeCapability: vi.fn(), groupOwner, ...adapter,
            applyShell: vi.fn(async () => {
                if (action === 'dispose')
                {
                    authoringWorkspaceRatioOwner.releaseWorkspace(ratioScope);
                    disposed = true;
                }
                else
                {
                    const projection = groupOwner.exportProjection();
                    const change = authoringWorkspaceRatioOwner.prepare(ratioScope, projection.splitRatioRef, plan.layout.splitRatioPermille);
                    const result = groupOwner.execute({ schema: 'fsusblog.authoring-tab-group-command.v1',
                        kind: 'set-split-ratio-ref', commandId: 'shell:ratio', idempotencyKey: 'shell:ratio',
                        expectedRevision: projection.state.revision, expectedArticleRegistryRevision: router.getRevision(),
                        expectedRatioRevision: projection.state.splitRatio.revision, splitRatioPermille: plan.layout.splitRatioPermille }, change);
                    expect(result.status).toBe('applied');
                }
                return 'a'.repeat(64);
            }), isCurrent: () => true };
        try
        {
            await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal))
                .rejects.toThrow(action === 'dispose' ? 'invalid-scope' : 'restore_ratio_binding_changed');
            expect(commands.applyShell).toHaveBeenCalledOnce();
            expect(router.getRegistry().listEntries()).toHaveLength(0);
            // Refusal does not fabricate rollback of the genuine already-committed group transition.
            expect(router.getRegistry().getRevision()).toBe(action === 'dispose' ? 1 : 2);
        }
        finally
        {
            if (!disposed)
            {
                authoringWorkspaceRatioOwner.releaseWorkspace(ratioScope);
            }
        }
    });
    it('late readiness after reset and operation epoch changes cannot reach group/shell restoration', async () => {
        // Synthetic command interleavings exercise consumer refusal, never actual FsusUI qualification or acceptance.
        const { api } = setup();
        const observed = await api.read();
        const port = { resolveBatch: async () => resolution(observed) };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        const ratioScope = authoringWorkspaceRatioOwner.openWorkspace();
        const groupOwner = new AuthoringTabGroupRegistry(router.getRegistry(), {
            initialGroupId: plan.layout.activeGroupId, initialGroupIds: plan.layout.groups.map(group => group.groupId),
            ratioScope, splitRatioRef: authoringWorkspaceRatioOwner.read(ratioScope).ratioRef, historyCapacity: 8
        });
        const adapter = groupOwner.createSnapshotAdapter(() => ({ commandId: 'restore:groups', idempotencyKey: 'restore:groups' }));
        const original = router.openOrActivate.bind(router);
        vi.spyOn(router, 'openOrActivate').mockImplementation(async (input) => {
            const receipt = await original(input);
            await api.reset(1, api.resetConfirmation(1));
            router.reset();
            return receipt;
        });
        const commands = { router, resolutionPort: port, assertRuntimeCapability: vi.fn(), groupOwner,
            applyGroups: vi.fn(adapter.applyGroups), applyGroupsWithReceipt: vi.fn(adapter.applyGroupsWithReceipt), applyShell: vi.fn(), isCurrent: () => true };
        try
        {
            await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal)).rejects.toThrow('server_observation_required');
            expect(commands.applyGroups).not.toHaveBeenCalled();
            expect(commands.applyGroupsWithReceipt).not.toHaveBeenCalled();
            expect(commands.applyShell).not.toHaveBeenCalled();
            const freshRouter = new ArticleWorkspaceTabRouter();
            const freshObserved = await api.read();
            const freshPlan = await prepareAuthoringWorkspaceSnapshotRestore(freshObserved, port, 0, new AbortController().signal);
            await expect(applyAuthoringWorkspaceSnapshotRestore(freshPlan, { ...commands, router: freshRouter, isCurrent: () => false }, new AbortController().signal)).rejects.toThrow('restore_superseded');
            expect(freshRouter.getRegistry().listEntries()).toHaveLength(0);
        }
        finally
        {
            authoringWorkspaceRatioOwner.releaseWorkspace(ratioScope);
        }
    });
    it('existing/revoked sessions cannot be reopened through the dependency activated-existing branch', async () => {
        const { api } = setup();
        const observed = await api.read();
        const port = { resolveBatch: async () => resolution(observed) };
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, port, 0, new AbortController().signal);
        const router = new ArticleWorkspaceTabRouter();
        await router.openOrActivate({ identity: observed.snapshot!.layout.tabs[0].identity,
            documentContext: { documentEpoch: 1, sourceRevision: null, draftRevision: null }, title: '', targetGroupId: 'group:primary', tabKind: 'pinned', entrypoint: 'recent-restore',
            status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false, permission: 'allowed', lifecycle: 'current', statusRef: 'permission:current' } });
        const entry = router.getRegistry().listEntries()[0];
        router.getRegistry().execute({ schema: 'fsusblog.open-article-document-command.v1', kind: 'invalidate-permission',
            commandId: 'test:revoked', idempotencyKey: 'test:revoked', expectedRevision: router.getRevision(), tabId: entry.tabId, permission: 'revoked', statusRef: 'permission:revoked' });
        const before = router.getRegistry().exportState();
        const commands = { router, resolutionPort: port, assertRuntimeCapability: vi.fn(), applyGroups: vi.fn(), applyShell: vi.fn(), isCurrent: () => true };
        await expect(applyAuthoringWorkspaceSnapshotRestore(plan, commands, new AbortController().signal)).rejects.toThrow('restore_requires_unstarted_workspace');
        expect(router.getRegistry().exportState()).toEqual(before);
        expect(commands.applyGroups).not.toHaveBeenCalled();
    });
});
describe('finite legacy migration and machine-backed status/reset projection', () => {
    it('stale or forged restore summaries cannot break the current status or retain partial authority', async () => {
        const { sync } = setup();
        await sync.start();
        const observed = sync.getServerObservation()!;
        const facts = resolution(observed);
        facts.facts[0] = { tabId: facts.facts[0].tabId, state: 'denied', currentIdentity: null, documentContext: null, permissionRef: null };
        const { contentDigest: _, ...unsigned } = facts;
        facts.contentDigest = workspaceSnapshotDigest(unsigned);
        const plan = await prepareAuthoringWorkspaceSnapshotRestore(observed, { resolveBatch: async () => facts }, 0, new AbortController().signal);
        expect(authoringWorkspaceSnapshotStatusModel(sync, plan).state).toBe('partial');
        expect(authoringWorkspaceSnapshotStatusModel(sync, plan).message).toContain('可恢复标签');
        expect(authoringWorkspaceSnapshotStatusModel(sync, plan).message).not.toContain('已恢复');
        expect(authoringWorkspaceSnapshotStatusModel(sync, structuredClone(plan)).state).toBe('current');
        await sync.setOnline(false);
        expect(authoringWorkspaceSnapshotStatusModel(sync, plan).state).not.toBe('partial');
        expect(authoringWorkspaceSnapshotStatusModel(sync, plan).reasonCounts).toEqual({});
    });
    it('explicit missing bootstrap discards unscoped layout, uses CAS, cleans only inventoried key and is idempotent', async () => {
        const { api, server } = setup();
        server.current = null;
        const values = new Map([[workspaceSnapshotLegacyInventory[0].key, 'true'], ['draft:protected', 'do-not-read']]);
        const storage = { getItem: vi.fn(key => values.get(key) ?? null), removeItem: vi.fn(key => values.delete(key)) };
        const migrated = await migrateAuthoringWorkspaceSnapshotLegacy(api, await api.read(), storage, true);
        expect(migrated.receipt.status).toBe('applied');
        expect(migrated.receipt.reason).toBe('unscoped-legacy');
        expect(server.current!.layout.shell.outlineOpen).toBe(defaultWorkspaceSnapshotLayout().shell.outlineOpen);
        expect(server.writes).toHaveLength(1);
        expect(values.has(workspaceSnapshotLegacyInventory[0].key)).toBe(false);
        expect(values.get('draft:protected')).toBe('do-not-read');
        expect(storage.getItem).toHaveBeenCalledTimes(1);
        const again = await migrateAuthoringWorkspaceSnapshotLegacy(api, await api.read(), storage, true);
        expect(again.receipt.status).toBe('server-precedence');
        expect(server.writes).toHaveLength(1);
    });
    it('existing server wins without reading legacy; deferred bootstrap and failed CAS preserve old keys', async () => {
        const { api, server } = setup();
        const storage = { getItem: vi.fn(() => 'false'), removeItem: vi.fn() };
        const existing = await migrateAuthoringWorkspaceSnapshotLegacy(api, await api.read(), storage, true);
        expect(existing.receipt.status).toBe('server-precedence');
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(server.writes).toHaveLength(0);
        const initial = setup();
        initial.server.current = null;
        const missing = await initial.api.read();
        storage.removeItem.mockClear();
        expect((await migrateAuthoringWorkspaceSnapshotLegacy(initial.api, missing, storage, false)).receipt.status).toBe('deferred');
        expect(initial.server.writes).toHaveLength(0);
        expect(storage.removeItem).not.toHaveBeenCalled();
        initial.server.current = snapshot(layout(20));
        const conflict = await migrateAuthoringWorkspaceSnapshotLegacy(initial.api, missing, storage, true);
        expect(conflict.receipt.status).toBe('conflict');
        expect(storage.removeItem).not.toHaveBeenCalled();
        expect(initial.server.current!.layout.tabs).toHaveLength(20);
    });
    it('normal current UI is quiet; cache/offline/conflict labels cannot claim saved and reset cancellation writes nothing', async () => {
        const { sync, api, server } = setup();
        await sync.start();
        expect(authoringWorkspaceSnapshotStatusModel(sync).message).toBeNull();
        const reset = new AuthoringWorkspaceSnapshotResetController(api, sync);
        expect(reset.request().prompt).toContain('文章、草稿、版本、附件和恢复记录均保留');
        reset.cancel();
        await expect(reset.confirm()).rejects.toThrow('reset_confirmation_required');
        expect(server.current!.revision).toBe(1);
        await sync.setOnline(false);
        sync.onInteraction('tabs', layout(20));
        const status = authoringWorkspaceSnapshotStatusModel(sync);
        expect(status.state).toBe('offline-unsynced');
        expect(status.canReset).toBe(false);
        expect(status.message).toContain('尚未同步');
        expect(status.message).not.toContain('已保存');
        expect(status.role).toBe('status');
        expect(status.live).toBe('polite');
    });
});
