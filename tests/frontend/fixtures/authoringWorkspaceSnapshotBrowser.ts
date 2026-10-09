import {
    AuthoringWorkspaceSnapshotApi,
    defaultWorkspaceSnapshotLayout,
    requireWorkspaceServerObservation,
    workspaceSnapshotBytes,
    workspaceSnapshotDigest,
    type AuthoringWorkspaceSnapshot,
    type AuthoringWorkspaceSnapshotReceipt,
    type AuthoringWorkspaceSnapshotScope
} from '@/api/authoringWorkspaceSnapshot';
import {
    AuthoringWorkspaceSnapshotCache,
    AuthoringWorkspaceSnapshotIndexedDbStorage,
    workspaceSnapshotCachePolicy
} from '@/services/authoring/authoringWorkspaceSnapshotCache';
import { AuthoringWorkspaceSnapshotBroadcastChannel, AuthoringWorkspaceSnapshotWebLocks } from '@/services/authoring/authoringWorkspaceSnapshotSync';

const sourceDigest = 'a'.repeat(64);
const scope = (userId = 1): AuthoringWorkspaceSnapshotScope => ({ userId, siteId: 'site:browser-test' });
const cache = (userId = 1, clock = Date.now): AuthoringWorkspaceSnapshotCache =>
    new AuthoringWorkspaceSnapshotCache(new AuthoringWorkspaceSnapshotIndexedDbStorage(), scope(userId), sourceDigest, clock);

/// Explicit test server port; this fixture cannot certify real authenticated AEDS/session/editor acceptance.
export async function writeServerFixtureCache(userId = 1, revision = 1, fetchedAt = Date.now()): Promise<string>
{
    const layout = defaultWorkspaceSnapshotLayout();
    layout.tabs = Array.from({ length: 100 }, (_, index) => ({ tabId: `tab:${index}`, identity: { articleId: index + 1, draftId: `draft:${index}`, documentId: `document:${index}` }, isPinned: true, isPreview: false }));
    layout.groups[0].tabIds = layout.tabs.map(tab => tab.tabId);
    layout.groups[0].activeTabId = layout.tabs[0].tabId;
    const unsigned = { schemaVersion: 1 as const, workspaceId: 'default' as const, scope: scope(userId),
        sourceContract: 'fsusblog.authoring-workspace-snapshot.v1' as const, sourceDigest, revision, updatedAt: fetchedAt, layout };
    const snapshot: AuthoringWorkspaceSnapshot = { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
    const receipt: AuthoringWorkspaceSnapshotReceipt = {
        schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1', action: 'read', status: 'current', reason: null,
        scope: scope(userId), workspaceId: 'default', sourceDigest, revisionBefore: revision, revisionAfter: revision,
        tabCount: 100, byteCount: workspaceSnapshotBytes(snapshot), inputDigest: workspaceSnapshotDigest(scope(userId)),
        snapshotDigest: snapshot.contentDigest, contentDigest: ''
    };
    receipt.contentDigest = workspaceSnapshotDigest(receipt);
    const api = new AuthoringWorkspaceSnapshotApi({ read: async () => ({ status: 'current', revision, snapshot, receipt }),
        write: async () => { throw new Error('fixture_write_forbidden'); }, reset: async () => { throw new Error('fixture_reset_forbidden'); } }, scope(userId), sourceDigest);
    const store = cache(userId, () => fetchedAt);
    const result = await store.verifyAndReplace(await api.read());
    store.close();
    return result;
}

export async function inspectCache(userId = 1): Promise<{ status: string; revision: number | null; tabs: number; authorityRejected: boolean }>
{
    const store = cache(userId);
    const read = await store.read();
    store.close();
    let authorityRejected = false;
    if (read.status === 'cached-placeholder')
    {
        try { requireWorkspaceServerObservation(read as never); } catch { authorityRejected = true; }
        return { status: read.status, revision: read.snapshot.revision, tabs: read.snapshot.layout.tabs.length, authorityRejected };
    }
    return { status: read.status, revision: null, tabs: 0, authorityRejected };
}

export async function nativeCacheCount(): Promise<number>
{
    return new Promise((resolve, reject) =>
    {
        const request = indexedDB.open(workspaceSnapshotCachePolicy.database, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () =>
        {
            const database = request.result;
            const transaction = database.transaction(workspaceSnapshotCachePolicy.store, 'readonly');
            const count = transaction.objectStore(workspaceSnapshotCachePolicy.store).count();
            transaction.oncomplete = () => { database.close(); resolve(count.result); };
            transaction.onerror = () => reject(transaction.error);
        };
    });
}

let channel: AuthoringWorkspaceSnapshotBroadcastChannel | null = null;
const received: unknown[] = [];
export function listenNativeChannel(): void
{
    received.length = 0;
    channel = new AuthoringWorkspaceSnapshotBroadcastChannel(workspaceSnapshotDigest(scope()));
    channel.subscribe(value => received.push(value));
}
export function postNativeRevision(): void
{
    channel!.send({ schema: 'fsusblog.authoring-workspace-channel.v1', scopeDigest: workspaceSnapshotDigest(scope()),
        sourceDigest, ownerRef: 'browser:producer', kind: 'invalidated', revision: 2, leaseUntil: 0 });
}
export function nativeMessages(): unknown[] { return structuredClone(received); }

let releaseLock: (() => void) | null = null;
let lockEntered = false;
export function holdNativeLock(): void
{
    lockEntered = false;
    const lease = new AuthoringWorkspaceSnapshotWebLocks(navigator.locks);
    void lease.run('browser-test', async () =>
    {
        lockEntered = true;
        await new Promise<void>(resolve => { releaseLock = resolve; });
    });
}
export function nativeLockEntered(): boolean { return lockEntered; }
export function releaseNativeLock(): void { releaseLock?.(); releaseLock = null; }
export async function tryNativeLock(): Promise<boolean>
{
    return new AuthoringWorkspaceSnapshotWebLocks(navigator.locks).run('browser-test', async () => Promise.resolve());
}
