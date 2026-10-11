import { AppErrorCode, createAppError } from '@/utils/appError';
export type PrivateStateCleanupTrigger =
  | 'logout'
  | 'admin-logout'
  | 'account-switch'
  | 'session-expired'
  | 'account-deletion'
  | 'credential-revoked'
  | 'issuer-key-rotation'
  | 'root-retired'
  | 'epoch-changed'
  | 'feature-disabled'
  | 'panic'
  | 'migration-failure'
  | 'shared-device';

export type PrivateStorageDataScope = 'public' | 'account' | 'admin' | 'session' | 'temporary';
export type PrivateStorageMedium = 'local-storage' | 'session-storage' | 'indexed-db' | 'cache-storage' | 'runtime';
export type PrivateStorageCleanupStatus = 'retained' | 'not-present' | 'removed' | 'cleared' | 'inactive' | 'failed';

type WebStorageEntry = Readonly<{
    id: string;
    dataScope: PrivateStorageDataScope;
    dataClass: string;
    clearOn: readonly PrivateStateCleanupTrigger[];
    matcher: Readonly<{ type: 'exact' | 'prefix'; value: string; }>;
}> & Readonly<{ medium: 'local-storage'; } | { medium: 'session-storage'; }>;

type CacheStorageEntry = Readonly<{
    id: string;
    medium: 'cache-storage';
    dataScope: PrivateStorageDataScope;
    dataClass: string;
    clearOn: readonly PrivateStateCleanupTrigger[];
    matcher:
    | Readonly<{ type: 'cache-prefix'; values: readonly string[]; }>
    | Readonly<{ type: 'request-path-prefix'; cachePrefix: string; values: readonly string[]; }>;
}>;

type IndexedDbEntry = Readonly<{
    id: string;
    medium: 'indexed-db';
    dataScope: PrivateStorageDataScope;
    dataClass: string;
    clearOn: readonly PrivateStateCleanupTrigger[];
    matcher: Readonly<{ type: 'database'; value: string; }>;
}>;

type RuntimeStorageEntry = Readonly<{
    id: string;
    medium: 'runtime';
    dataScope: PrivateStorageDataScope;
    dataClass: string;
    clearOn: readonly PrivateStateCleanupTrigger[];
}>;

export type PrivateStorageRegistryEntry = WebStorageEntry | IndexedDbEntry | CacheStorageEntry | RuntimeStorageEntry;

const ACCOUNT_CLEAR_TRIGGERS = Object.freeze<PrivateStateCleanupTrigger[]>([
    'logout',
    'account-switch',
    'session-expired',
    'account-deletion',
    'panic',
    'migration-failure',
    'shared-device'
]);
const ADMIN_CLEAR_TRIGGERS = Object.freeze<PrivateStateCleanupTrigger[]>([
    'admin-logout',
    'panic',
    'migration-failure',
    'shared-device'
]);
const LEGACY_COMMENT_DRAFT_CLEAR_TRIGGERS = Object.freeze<PrivateStateCleanupTrigger[]>([
    ...ACCOUNT_CLEAR_TRIGGERS,
    'credential-revoked',
    'issuer-key-rotation',
    'root-retired',
    'epoch-changed',
    'feature-disabled'
]);
const AUTH_TRANSITION_TRIGGERS = Object.freeze<PrivateStateCleanupTrigger[]>([
    ...ACCOUNT_CLEAR_TRIGGERS,
    'admin-logout'
]);
const ARTICLE_RECOVERY_CLEAR_TRIGGERS = Object.freeze<PrivateStateCleanupTrigger[]>([
    ...new Set([
        ...ACCOUNT_CLEAR_TRIGGERS,
        ...ADMIN_CLEAR_TRIGGERS
    ])
]);
export const RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY = 'fsus:article-draft:create';
export const RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX = 'fsus:article-draft:edit:';

export const PRIVATE_STORAGE_REGISTRY: readonly PrivateStorageRegistryEntry[] = Object.freeze([
    { id: 'theme-mode', medium: 'local-storage', dataScope: 'public', dataClass: 'public-preference', clearOn: [], matcher: { type: 'exact', value: 'fsus:theme-mode' } },
    { id: 'image-upload-preferences', medium: 'local-storage', dataScope: 'public', dataClass: 'public-preference', clearOn: [], matcher: { type: 'exact', value: 'fsus:image-upload-preferences' } },
    { id: 'legacy-account-cache', medium: 'local-storage', dataScope: 'account', dataClass: 'auth-state', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'fsus_user_storage' } },
    { id: 'legacy-comment-drafts', medium: 'local-storage', dataScope: 'account', dataClass: 'unsafe-legacy-draft', clearOn: LEGACY_COMMENT_DRAFT_CLEAR_TRIGGERS, matcher: { type: 'prefix', value: 'fsus:comment-draft:v1:' } },
    { id: 'public-comment-drafts', medium: 'local-storage', dataScope: 'account', dataClass: 'public-draft', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'prefix', value: 'fsus:comment-public-draft:v3:' } },
    { id: 'public-comment-draft-scope', medium: 'local-storage', dataScope: 'account', dataClass: 'local-unlinkable-scope', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'fsus:comment-public-draft-scope:v3' } },
    { id: 'image-upload-sessions', medium: 'local-storage', dataScope: 'account', dataClass: 'upload-session', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'prefix', value: 'fsus:image-upload-session:' } },
    { id: 'article-recovery-journal', medium: 'indexed-db', dataScope: 'admin', dataClass: 'bounded-unconfirmed-article-body', clearOn: ARTICLE_RECOVERY_CLEAR_TRIGGERS, matcher: { type: 'database', value: 'fsusblog-article-recovery-journal' } },
    { id: 'retired-article-draft-create-metadata', medium: 'local-storage', dataScope: 'admin', dataClass: 'retired-metadata-only', clearOn: ARTICLE_RECOVERY_CLEAR_TRIGGERS, matcher: { type: 'exact', value: RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY } },
    { id: 'retired-article-draft-edit-metadata', medium: 'local-storage', dataScope: 'admin', dataClass: 'retired-metadata-only', clearOn: ARTICLE_RECOVERY_CLEAR_TRIGGERS, matcher: { type: 'prefix', value: RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX } },
    { id: 'console-welcome-identity', medium: 'local-storage', dataScope: 'admin', dataClass: 'identity-preference', clearOn: ADMIN_CLEAR_TRIGGERS, matcher: { type: 'prefix', value: 'fsus:console-welcome-callout:dismissed:' } },
    { id: 'local-fixture-account', medium: 'session-storage', dataScope: 'account', dataClass: 'local-fixture', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'fsusblog_local_fixture_session' } },
    { id: 'local-fixture-admin', medium: 'session-storage', dataScope: 'admin', dataClass: 'local-fixture', clearOn: ADMIN_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'fsusblog_local_fixture_admin_session' } },
    { id: 'notification-guest-pow', medium: 'session-storage', dataScope: 'session', dataClass: 'challenge-proof', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'notification_stream_guest_pow' } },
    { id: 'auth-refresh-last-success', medium: 'local-storage', dataScope: 'session', dataClass: 'request-cache', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'exact', value: 'fsus:auth:refresh:last-success' } },
    { id: 'bootstrap-import-retry', medium: 'session-storage', dataScope: 'temporary', dataClass: 'bootstrap-retry', clearOn: AUTH_TRANSITION_TRIGGERS, matcher: { type: 'exact', value: 'fsus:bootstrap-import-retry' } },
    { id: 'auth-broadcast-fallback', medium: 'local-storage', dataScope: 'temporary', dataClass: 'cross-tab-signal', clearOn: AUTH_TRANSITION_TRIGGERS, matcher: { type: 'exact', value: 'fsus:auth:broadcast' } },
    { id: 'privacy-broadcast-fallback', medium: 'local-storage', dataScope: 'temporary', dataClass: 'cross-tab-signal', clearOn: AUTH_TRANSITION_TRIGGERS, matcher: { type: 'exact', value: 'fsus:comment-privacy:purge' } },
    { id: 'panic-all-caches', medium: 'cache-storage', dataScope: 'temporary', dataClass: 'emergency-wipe', clearOn: ['panic'], matcher: { type: 'cache-prefix', values: ['fsus-'] } },
    { id: 'offline-private-history', medium: 'cache-storage', dataScope: 'session', dataClass: 'offline-history', clearOn: AUTH_TRANSITION_TRIGGERS, matcher: { type: 'cache-prefix', values: ['fsus-shell-', 'fsus-search-', 'fsus-search-meta-'] } },
    { id: 'account-request-cache', medium: 'cache-storage', dataScope: 'account', dataClass: 'request-cache', clearOn: ACCOUNT_CLEAR_TRIGGERS, matcher: { type: 'request-path-prefix', cachePrefix: 'fsus-', values: ['/api/', '/user/', '/account/', '/private/', '/notification', '/login'] } },
    { id: 'admin-request-cache', medium: 'cache-storage', dataScope: 'admin', dataClass: 'request-cache', clearOn: ADMIN_CLEAR_TRIGGERS, matcher: { type: 'request-path-prefix', cachePrefix: 'fsus-', values: ['/api/', '/admin/', '/manage/', '/author/', '/private/', '/login'] } },
    { id: 'account-pinia', medium: 'runtime', dataScope: 'account', dataClass: 'pinia-state', clearOn: ACCOUNT_CLEAR_TRIGGERS },
    { id: 'admin-pinia', medium: 'runtime', dataScope: 'admin', dataClass: 'pinia-state', clearOn: ADMIN_CLEAR_TRIGGERS },
    { id: 'author-query-projection-runtime', medium: 'runtime', dataScope: 'admin', dataClass: 'bounded-verified-author-projection', clearOn: [...AUTH_TRANSITION_TRIGGERS, 'credential-revoked', 'issuer-key-rotation', 'root-retired', 'epoch-changed', 'feature-disabled'] },
    { id: 'notification-runtime', medium: 'runtime', dataScope: 'session', dataClass: 'private-cursor', clearOn: ACCOUNT_CLEAR_TRIGGERS },
    { id: 'challenge-proof-runtime', medium: 'runtime', dataScope: 'temporary', dataClass: 'challenge-proof', clearOn: AUTH_TRANSITION_TRIGGERS }
]);

export interface PrivateStorageCleanupItemResult {
    id: string;
    medium: PrivateStorageMedium;
    dataScope: PrivateStorageDataScope;
    status: PrivateStorageCleanupStatus;
    affected: number;
}

export interface PrivateStorageCleanupResult {
    trigger: PrivateStateCleanupTrigger;
    complete: boolean;
    items: readonly PrivateStorageCleanupItemResult[];
    removed: readonly string[];
    failed: readonly string[];
}

export type PrivateStateCleanupHandler = (trigger: PrivateStateCleanupTrigger) => void | Promise<void>;

interface CacheStorageLike {
    keys(): Promise<readonly string[]>;
    delete(cacheName: string): Promise<boolean>;
    open(cacheName: string): Promise<Pick<Cache, 'keys' | 'delete'>>;
}

interface IndexedDbLike {
    deleteDatabase(name: string): IDBOpenDBRequest;
}

const runtimeCleanupHandlers = new Map<string, Set<PrivateStateCleanupHandler>>();

function findRuntimeEntry(id: string): RuntimeStorageEntry | undefined
{
    return PRIVATE_STORAGE_REGISTRY.find((entry): entry is RuntimeStorageEntry => entry.id === id && entry.medium === 'runtime');
}

export function registerPrivateStateCleanupHandler(id: string, handler: PrivateStateCleanupHandler): () => void
{
    if (!findRuntimeEntry(id))
    {
        throw createAppError(AppErrorCode.InfraFailure, `private_state_cleanup_handler_not_registered:${id}`);
    }
    const handlers = runtimeCleanupHandlers.get(id) ?? new Set<PrivateStateCleanupHandler>();
    handlers.add(handler);
    runtimeCleanupHandlers.set(id, handlers);
    return () =>
    {
        handlers.delete(handler);
        if (handlers.size === 0)
        {
            runtimeCleanupHandlers.delete(id);
        }
    };
}

export function resetPrivateStateCleanupHandlersForTests(): void
{
    runtimeCleanupHandlers.clear();
}

function registeredKeys(storage: Storage, entry: WebStorageEntry): string[]
{
    if (entry.matcher.type === 'exact')
    {
        return storage.getItem(entry.matcher.value) === null ? [] : [entry.matcher.value];
    }
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1)
    {
        const key = storage.key(index);
        if (key?.startsWith(entry.matcher.value))
        {
            keys.push(key);
        }
    }
    return keys;
}

export function purgeRetiredArticleDraftMetadata(
    storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage
): readonly string[]
{
    if (!storage)
    {
        return [];
    }
    const keys: string[] = [];
    try
    {
        for (let index = 0; index < storage.length; index += 1)
        {
            const key = storage.key(index);
            if (key === RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY
        || key?.startsWith(RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX))
            {
                keys.push(key);
            }
        }
        for (const key of keys)
        {
            storage.removeItem(key);
        }
        return keys;
    }
    catch
    {
        return [];
    }
}

function retainedResult(entry: PrivateStorageRegistryEntry): PrivateStorageCleanupItemResult
{
    return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'retained', affected: 0 };
}

function appliesToTrigger(entry: PrivateStorageRegistryEntry, trigger: PrivateStateCleanupTrigger): boolean
{
    return entry.clearOn.includes(trigger);
}

function clearWebStorageEntry(
    entry: WebStorageEntry,
    storage: Storage | undefined,
    removed: string[]
): PrivateStorageCleanupItemResult
{
    if (!storage)
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'inactive', affected: 0 };
    }
    try
    {
        const keys = registeredKeys(storage, entry);
        for (const key of keys)
        {
            storage.removeItem(key);
            removed.push(key);
        }
        return {
            id: entry.id,
            medium: entry.medium,
            dataScope: entry.dataScope,
            status: keys.length > 0 ? 'removed' : 'not-present',
            affected: keys.length
        };
    }
    catch
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'failed', affected: 0 };
    }
}

async function clearCacheStorageEntry(
    entry: CacheStorageEntry,
    cacheStorage: CacheStorageLike | undefined
): Promise<PrivateStorageCleanupItemResult>
{
    if (!cacheStorage)
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'inactive', affected: 0 };
    }
    try
    {
        const cacheNames = await cacheStorage.keys();
        let affected = 0;
        if (entry.matcher.type === 'cache-prefix')
        {
            for (const cacheName of cacheNames)
            {
                if (entry.matcher.values.some(prefix => cacheName.startsWith(prefix)) && await cacheStorage.delete(cacheName))
                {
                    affected += 1;
                }
            }
        }
        else
        {
            for (const cacheName of cacheNames)
            {
                if (!cacheName.startsWith(entry.matcher.cachePrefix))
                {
                    continue;
                }
                const cache = await cacheStorage.open(cacheName);
                const requests = await cache.keys();
                for (const request of requests)
                {
                    const pathname = new URL(request.url).pathname;
                    if (entry.matcher.values.some(prefix => pathname === prefix || pathname.startsWith(prefix)))
                    {
                        if (await cache.delete(request))
                        {
                            affected += 1;
                        }
                    }
                }
            }
        }
        return {
            id: entry.id,
            medium: entry.medium,
            dataScope: entry.dataScope,
            status: affected > 0 ? 'removed' : 'not-present',
            affected
        };
    }
    catch
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'failed', affected: 0 };
    }
}

async function clearIndexedDbEntry(
    entry: IndexedDbEntry,
    indexedDb: IndexedDbLike | undefined
): Promise<PrivateStorageCleanupItemResult>
{
    if (!indexedDb)
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'inactive', affected: 0 };
    }
    try
    {
        const deleted = await new Promise<boolean>((resolve, reject) =>
        {
            const request = indexedDb.deleteDatabase(entry.matcher.value);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error ?? new Error('private_indexeddb_cleanup_failed'));
            request.onblocked = () => reject(new Error('private_indexeddb_cleanup_blocked'));
        });
        return {
            id: entry.id,
            medium: entry.medium,
            dataScope: entry.dataScope,
            status: deleted ? 'removed' : 'not-present',
            affected: deleted ? 1 : 0
        };
    }
    catch
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'failed', affected: 0 };
    }
}

async function clearRuntimeEntry(entry: RuntimeStorageEntry, trigger: PrivateStateCleanupTrigger): Promise<PrivateStorageCleanupItemResult>
{
    const handlers = [...(runtimeCleanupHandlers.get(entry.id) ?? [])];
    if (handlers.length === 0)
    {
        return { id: entry.id, medium: entry.medium, dataScope: entry.dataScope, status: 'inactive', affected: 0 };
    }
    const outcomes = await Promise.allSettled(handlers.map(handler => Promise.resolve().then(() => handler(trigger))));
    return {
        id: entry.id,
        medium: entry.medium,
        dataScope: entry.dataScope,
        status: outcomes.some(outcome => outcome.status === 'rejected') ? 'failed' : 'cleared',
        affected: outcomes.filter(outcome => outcome.status === 'fulfilled').length
    };
}

export async function clearRegisteredPrivateState(options: {
    trigger: PrivateStateCleanupTrigger;
    local?: Storage;
    session?: Storage;
    indexedDb?: IndexedDbLike;
    cacheStorage?: CacheStorageLike;
}): Promise<PrivateStorageCleanupResult>
{
    const local = options.local ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const session = options.session ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    const indexedDb = options.indexedDb ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    const cacheStorage = options.cacheStorage ?? (typeof caches === 'undefined' ? undefined : caches);
    const removed: string[] = [];
    const items: PrivateStorageCleanupItemResult[] = [];

    for (const entry of PRIVATE_STORAGE_REGISTRY)
    {
        if (!appliesToTrigger(entry, options.trigger))
        {
            items.push(retainedResult(entry));
            continue;
        }
        if (entry.medium === 'local-storage')
        {
            items.push(clearWebStorageEntry(entry, local, removed));
        }
        else if (entry.medium === 'session-storage')
        {
            items.push(clearWebStorageEntry(entry, session, removed));
        }
        else if (entry.medium === 'indexed-db')
        {
            items.push(await clearIndexedDbEntry(entry, indexedDb));
        }
        else if (entry.medium === 'cache-storage')
        {
            items.push(await clearCacheStorageEntry(entry, cacheStorage));
        }
        else
        {
            items.push(await clearRuntimeEntry(entry, options.trigger));
        }
    }

    const failed = items.filter(item => item.status === 'failed').map(item => item.id);
    return {
        trigger: options.trigger,
        complete: failed.length === 0,
        items,
        removed,
        failed
    };
}

export function clearRegisteredPrivateStorage(options: {
    local?: Storage;
    session?: Storage;
    trigger?: PrivateStateCleanupTrigger;
} = {}): PrivateStorageCleanupResult
{
    const trigger = options.trigger ?? 'logout';
    const local = options.local ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const session = options.session ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    const removed: string[] = [];
    const items = PRIVATE_STORAGE_REGISTRY
        .filter((entry): entry is WebStorageEntry => entry.medium === 'local-storage' || entry.medium === 'session-storage')
        .map(entry => appliesToTrigger(entry, trigger)
            ? clearWebStorageEntry(entry, entry.medium === 'local-storage' ? local : session, removed)
            : retainedResult(entry));
    const failed = items.filter(item => item.status === 'failed').map(item => item.id);
    return { trigger, complete: failed.length === 0, items, removed, failed };
}
