import { AuthoringWorkspaceSnapshotError, authoringWorkspaceSnapshotContract, freezeWorkspaceSnapshot, requireWorkspaceServerObservation, validateWorkspaceSnapshot, validateWorkspaceSnapshotScope, workspaceSnapshotBytes, workspaceSnapshotDigest, workspaceSnapshotExact, workspaceSnapshotInteger, type AuthoringWorkspaceServerObservation, type AuthoringWorkspaceSnapshot, type AuthoringWorkspaceSnapshotScope } from '@/api/authoringWorkspaceSnapshot';
export const workspaceSnapshotCachePolicy = Object.freeze({
    schema: 'fsusblog.authoring-workspace-verified-cache.v1',
    database: 'fsusblog.authoring-workspace-verified.v1',
    store: 'verified',
    maxEntries: 8,
    maxAgeMs: 86400000,
    maxEntryBytes: 80000
} as const);
interface WorkspaceSnapshotCacheRecord {
    schema: typeof workspaceSnapshotCachePolicy.schema;
    key: string;
    scope: AuthoringWorkspaceSnapshotScope;
    workspaceId: 'default';
    sourceDigest: string;
    schemaVersion: 1;
    serverRevision: number;
    serverUpdatedAt: number;
    snapshotDigest: string;
    snapshotBytes: string;
    fetchedAt: number;
    expiresAt: number;
    contentDigest: string;
}
export interface WorkspaceSnapshotCacheStorage {
    get(key: string): Promise<unknown>;
    replace(record: WorkspaceSnapshotCacheRecord, now: number): Promise<void>;
    remove(key: string): Promise<void>;
    close(): void;
}
export type WorkspaceSnapshotCacheRead = {
    status: 'cached-placeholder';
    snapshot: AuthoringWorkspaceSnapshot;
    expiresAt: number;
} | {
    status: 'missing' | 'stale' | 'invalid' | 'unavailable';
    reason: string;
};
export class AuthoringWorkspaceSnapshotCache
{
    private readonly scope: AuthoringWorkspaceSnapshotScope;
    private closed = false;
    private readonly writes = new Set<Promise<'stored' | 'cleared' | 'unavailable'>>();
    public constructor(private readonly storage: WorkspaceSnapshotCacheStorage, scope: AuthoringWorkspaceSnapshotScope, private readonly sourceDigest: string, private readonly now: () => number = Date.now)
    {
        validateWorkspaceSnapshotScope(scope);
        this.scope = freezeWorkspaceSnapshot(structuredClone(scope));
    }
    public async read(): Promise<WorkspaceSnapshotCacheRead>
    {
        try
        {
            const raw = await this.storage.get(this.key());
            if (raw === undefined || raw === null)
            {
                return { status: 'missing', reason: 'cache_missing' };
            }
            workspaceSnapshotExact(raw, ['schema', 'key', 'scope', 'workspaceId', 'sourceDigest', 'schemaVersion', 'serverRevision', 'serverUpdatedAt', 'snapshotDigest', 'snapshotBytes', 'fetchedAt', 'expiresAt', 'contentDigest']);
            const record = raw as unknown as WorkspaceSnapshotCacheRecord;
            const { contentDigest, ...unsigned } = record;
            if (record.schema !== workspaceSnapshotCachePolicy.schema || record.key !== this.key() || record.workspaceId !== 'default'
                || record.schemaVersion !== authoringWorkspaceSnapshotContract.schemaVersion || record.sourceDigest !== this.sourceDigest
                || workspaceSnapshotDigest(record.scope) !== workspaceSnapshotDigest(this.scope)
                || typeof record.snapshotBytes !== 'string' || new TextEncoder().encode(record.snapshotBytes).length > authoringWorkspaceSnapshotContract.maxBytes
                || workspaceSnapshotBytes(record) > workspaceSnapshotCachePolicy.maxEntryBytes
                || workspaceSnapshotDigest(unsigned) !== contentDigest || !workspaceSnapshotInteger(record.fetchedAt, 1)
                || !workspaceSnapshotInteger(record.expiresAt, 1) || record.fetchedAt > this.now()
                || record.expiresAt !== record.fetchedAt + workspaceSnapshotCachePolicy.maxAgeMs)
            {
                return { status: 'invalid', reason: 'cache_binding_invalid' };
            }
            if (record.expiresAt <= this.now())
            {
                return { status: 'stale', reason: 'cache_expired' };
            }
            const snapshot: unknown = JSON.parse(record.snapshotBytes);
            validateWorkspaceSnapshot(snapshot, this.scope, this.sourceDigest, this.now());
            if (snapshot.revision !== record.serverRevision || snapshot.updatedAt !== record.serverUpdatedAt
                || snapshot.contentDigest !== record.snapshotDigest)
            {
                return { status: 'invalid', reason: 'cache_revision_mismatch' };
            }
            return { status: 'cached-placeholder', snapshot: freezeWorkspaceSnapshot(snapshot), expiresAt: record.expiresAt };
        }
        catch (error)
        {
            return { status: error instanceof AuthoringWorkspaceSnapshotError || error instanceof SyntaxError ? 'invalid' : 'unavailable',
                reason: error instanceof AuthoringWorkspaceSnapshotError ? error.reason : 'cache_unavailable' };
        }
    }
    public async verifyAndReplace(observation: AuthoringWorkspaceServerObservation): Promise<'stored' | 'cleared' | 'unavailable'>
    {
        requireWorkspaceServerObservation(observation);
        if (workspaceSnapshotDigest(observation.receipt.scope) !== workspaceSnapshotDigest(this.scope)
            || observation.receipt.sourceDigest !== this.sourceDigest)
        {
            throw new AuthoringWorkspaceSnapshotError('cache_scope_mismatch');
        }
        if (observation.status === 'conflict')
        {
            throw new AuthoringWorkspaceSnapshotError('cache_server_success_required');
        }
        if (this.closed)
        {
            return 'unavailable';
        }
        const task = this.persist(observation);
        this.writes.add(task);
        try
        {
            return await task;
        }
        finally
        {
            this.writes.delete(task);
        }
    }
    private async persist(observation: AuthoringWorkspaceServerObservation): Promise<'stored' | 'cleared' | 'unavailable'>
    {
        try
        {
            if (!observation.snapshot)
            {
                await this.storage.remove(this.key());
                return 'cleared';
            }
            const snapshot = observation.snapshot;
            validateWorkspaceSnapshot(snapshot, this.scope, this.sourceDigest, this.now());
            const fetchedAt = this.now();
            const unsigned: Omit<WorkspaceSnapshotCacheRecord, 'contentDigest'> = {
                schema: workspaceSnapshotCachePolicy.schema, key: this.key(), scope: this.scope, workspaceId: 'default',
                sourceDigest: this.sourceDigest, schemaVersion: 1, serverRevision: snapshot.revision,
                serverUpdatedAt: snapshot.updatedAt, snapshotDigest: snapshot.contentDigest, snapshotBytes: JSON.stringify(snapshot),
                fetchedAt, expiresAt: fetchedAt + workspaceSnapshotCachePolicy.maxAgeMs
            };
            const record = { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
            if (workspaceSnapshotBytes(record) > workspaceSnapshotCachePolicy.maxEntryBytes)
            {
                return 'unavailable';
            }
            await this.storage.replace(record, fetchedAt);
            return 'stored';
        }
        catch
        {
            return 'unavailable';
        }
    }
    public async clearCurrentScope(): Promise<void>
    {
        await Promise.allSettled([...this.writes]);
        try
        {
            await this.storage.remove(this.key());
        }
        catch
        { /* Storage denial cannot block scope cleanup. */ }
    }
    public close(): void
    {
        this.closed = true;
        this.storage.close();
    }
    private key(): string
    {
        return workspaceSnapshotDigest({ scope: this.scope, workspaceId: 'default' });
    }
}
/// One atomic IDB transaction replaces the last verified value and enforces finite browser retention.
export class AuthoringWorkspaceSnapshotIndexedDbStorage implements WorkspaceSnapshotCacheStorage
{
    private database: Promise<IDBDatabase> | null = null;
    private closed = false;
    public constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB)
    { }
    public async get(key: string): Promise<unknown>
    {
        const database = await this.open();
        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(workspaceSnapshotCachePolicy.store, 'readonly');
            const request = transaction.objectStore(workspaceSnapshotCachePolicy.store).get(key);
            let result: unknown;
            request.onsuccess = () =>
            {
                result = request.result;
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = transaction.onabort = () => reject(new Error('cache_read_failed'));
        });
    }
    public async replace(record: WorkspaceSnapshotCacheRecord, now: number): Promise<void>
    {
        const database = await this.open();
        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(workspaceSnapshotCachePolicy.store, 'readwrite');
            const store = transaction.objectStore(workspaceSnapshotCachePolicy.store);
            const previous = store.get(record.key);
            previous.onsuccess = () =>
            {
                const old = previous.result as WorkspaceSnapshotCacheRecord | undefined;
                if (old?.sourceDigest === record.sourceDigest && old.serverRevision > record.serverRevision)
                {
                    return;
                }
                const count = store.count();
                count.onsuccess = () =>
                {
                    if (count.result > workspaceSnapshotCachePolicy.maxEntries)
                    {
                        // Tampered/unbounded cache is discarded without allocating all attacker-controlled rows.
                        store.clear();
                        store.put(record);
                        return;
                    }
                    store.put(record);
                    const request = store.getAll(undefined, workspaceSnapshotCachePolicy.maxEntries + 1);
                    request.onsuccess = () =>
                    {
                        const records = request.result as WorkspaceSnapshotCacheRecord[];
                        const retained = records.filter(row => row.expiresAt > now)
                            .sort((a, b) => b.fetchedAt - a.fetchedAt || a.key.localeCompare(b.key));
                        const keep = new Set([record.key, ...retained.filter(row => row.key !== record.key)
                            .slice(0, workspaceSnapshotCachePolicy.maxEntries - 1).map(row => row.key)]);
                        for (const row of records)
                        {
                            if (!keep.has(row.key))
                            {
                                store.delete(row.key);
                            }
                        }
                    };
                };
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(new Error('cache_replace_failed'));
        });
    }
    public async remove(key: string): Promise<void>
    {
        const database = await this.open();
        return new Promise((resolve, reject) =>
        {
            const transaction = database.transaction(workspaceSnapshotCachePolicy.store, 'readwrite');
            transaction.objectStore(workspaceSnapshotCachePolicy.store).delete(key);
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(new Error('cache_remove_failed'));
        });
    }
    public close(): void
    {
        this.closed = true;
        void this.database?.then(database => database.close(), () => undefined);
    }
    private open(): Promise<IDBDatabase>
    {
        if (this.closed || !this.factory)
        {
            return Promise.reject(new Error('cache_unavailable'));
        }
        this.database ??= new Promise((resolve, reject) =>
        {
            const request = this.factory!.open(workspaceSnapshotCachePolicy.database, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(workspaceSnapshotCachePolicy.store, { keyPath: 'key' });
            request.onsuccess = () =>
            {
                const database = request.result;
                if (this.closed)
                {
                    database.close();
                    reject(new Error('cache_closed'));
                    return;
                }
                database.onversionchange = () => database.close();
                resolve(database);
            };
            request.onerror = request.onblocked = () => reject(new Error('cache_open_failed'));
        });
        return this.database;
    }
}
