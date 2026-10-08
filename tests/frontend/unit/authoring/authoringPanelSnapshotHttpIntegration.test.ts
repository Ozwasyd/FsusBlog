import { afterEach, expect, it, vi } from 'vitest';
import { decode } from '@wasm/aeds';
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { AuthoringWorkspaceSnapshotApi, defaultWorkspaceSnapshotLayout, requireWorkspaceServerObservation,
    workspaceSnapshotBytes, workspaceSnapshotDigest, type AuthoringWorkspaceServerObservation,
    type AuthoringWorkspaceSnapshot, type AuthoringWorkspaceSnapshotReceipt } from '@/api/authoringWorkspaceSnapshot';
import { createAuthoringWorkspaceSnapshotHttpTransport } from '@/api/authoringWorkspaceSnapshotHttpTransport';
import { encodeAuthoringWorkspaceSnapshotResponse } from '@/codecs/binary/authoringWorkspaceSnapshotWire.generated';
import { AuthoringPanelSnapshotBindingAdapter, authoringPanelSnapshotBindingSchema } from '@/services/authoring/authoringPanelSnapshotAdapter';
import { ArticleWorkspaceTabRouter } from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringWorkspaceSnapshotCache, type WorkspaceSnapshotCacheStorage } from '@/services/authoring/authoringWorkspaceSnapshotCache';
import { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

afterEach(() => { privateRequestRuntime.resetForTests(); vi.unstubAllGlobals(); });

it('composes actual typed HTTP, verified snapshot/cache and panel fence without granting a panel or acquiring a write lease', async () =>
{
    // Synthetic reference-only wire data exercises owner composition, not a
    // production authenticated save, editor model, panel slot or read grant.
    const scope = { userId: 73, siteId: 'site:primary' };
    const sourceDigest = 'a'.repeat(64);
    const tabs = new ArticleWorkspaceTabRouter();
    await tabs.openOrActivate({ identity: { articleId: 8, draftId: 'draft:008', documentId: 'document:008' },
        documentContext: { documentEpoch: 2, sourceRevision: 'source:011', draftRevision: 'draft-revision:011' },
        title: 'Diagnostic document', status: { dirty: false, saving: false, conflict: false, recovery: false,
            pendingAttachments: false, permission: 'allowed', lifecycle: 'current', statusRef: 'status:008' },
        targetGroupId: 'group:primary', tabKind: 'pinned', entrypoint: 'rail' });
    const entry = tabs.getRegistry().listEntries()[0]!;
    const layout = defaultWorkspaceSnapshotLayout();
    layout.tabs = [{ tabId: entry.tabId, identity: entry.identity, isPreview: false, isPinned: true }];
    layout.groups = [{ groupId: entry.owningGroupId, tabIds: [entry.tabId], activeTabId: entry.tabId }];
    layout.activeGroupId = entry.owningGroupId;
    const unsigned = { schemaVersion: 1 as const, workspaceId: 'default' as const, scope,
        sourceContract: 'fsusblog.authoring-workspace-snapshot.v1' as const,
        sourceDigest, revision: 1, updatedAt: Date.now(), layout };
    const snapshot: AuthoringWorkspaceSnapshot = { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
    const receipt: AuthoringWorkspaceSnapshotReceipt = { schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1',
        action: 'read', status: 'current', reason: null, scope, workspaceId: 'default', sourceDigest,
        revisionBefore: 1, revisionAfter: 1, tabCount: 1, byteCount: workspaceSnapshotBytes(snapshot),
        inputDigest: workspaceSnapshotDigest(scope), snapshotDigest: snapshot.contentDigest, contentDigest: '' };
    receipt.contentDigest = workspaceSnapshotDigest(receipt);
    const body = encodeAedsFrame(FrameType.AuthoringWorkspaceSnapshotResponse,
        encodeAuthoringWorkspaceSnapshotResponse({ status: 'current', revision: 1, snapshot, receipt }));
    const fetchBoundary = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchBoundary);
    vi.mocked(decode).mockImplementation(buffer =>
    {
        const view = new DataView(buffer);
        if (buffer.byteLength < AEDS_HEADER_LENGTH || view.getUint32(0, true) !== AEDS_MAGIC || view.getUint8(4) !== AEDS_VERSION)
        {
            return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(), error: 'diagnostic-invalid-frame' };
        }
        return { ok: true, frameType: view.getUint16(8, true) as FrameType,
            payloadView: new Uint8Array(buffer).subarray(view.getUint8(5)), error: '' };
    });
    type CacheRecord = Parameters<WorkspaceSnapshotCacheStorage['replace']>[0];
    let persisted: CacheRecord | null = null;
    const storage = { get: async () => persisted, replace: vi.fn(async (record: CacheRecord) => { persisted = structuredClone(record); }),
        remove: async () => { persisted = null; }, close: () => {} };
    const cache = new AuthoringWorkspaceSnapshotCache(storage, scope, sourceDigest);
    const api = new AuthoringWorkspaceSnapshotApi(createAuthoringWorkspaceSnapshotHttpTransport(sourceDigest), scope, sourceDigest);
    const lease = { run: vi.fn(async () => false) };
    const sync = new AuthoringWorkspaceSnapshotSync(api, cache, null, 'browser:diagnostic-panel', lease);
    const admission = { isCurrent: vi.fn(() => false) };
    const adapter = new AuthoringPanelSnapshotBindingAdapter(sync, tabs, admission);
    try
    {
        await sync.start();
        const observed = sync.getServerObservation();
        expect(observed).not.toBeNull();
        expect(() => requireWorkspaceServerObservation(observed!)).not.toThrow();
        expect(observed?.snapshot).toEqual(snapshot);
        expect(storage.replace).toHaveBeenCalledOnce();
        const cached = await cache.read();
        expect(cached.status).toBe('cached-placeholder');
        expect(() => requireWorkspaceServerObservation(cached as unknown as AuthoringWorkspaceServerObservation))
            .toThrow('server_observation_required');
        const binding = { schema: authoringPanelSnapshotBindingSchema, panelId: 'diagnostic.panel',
            extensionId: 'diagnostic.extension', extensionVersion: '1.0.0', packageSha256: 'b'.repeat(64),
            scope, sourceDigest, snapshotRevision: 1, snapshotDigest: snapshot.contentDigest,
            groupId: entry.owningGroupId, tabId: entry.tabId, documentIdentity: entry.identity,
            documentContext: entry.documentContext, requestId: 'diagnostic:request', grantReference: 'diagnostic:denied',
            deadline: Date.now() + 1000 };
        expect(() => adapter.begin(binding)).toThrow('authoring_panel_snapshot_not_current');
        expect(admission.isCurrent).toHaveBeenCalledOnce();
        expect(adapter.current).toBeNull();
        expect(lease.run).not.toHaveBeenCalled();
        expect(fetchBoundary).toHaveBeenCalledOnce();
        const [url, options] = fetchBoundary.mock.calls[0] as unknown as [string, RequestInit];
        expect(new URL(url).pathname).toBe('/api/binary/author/workspace/default');
        expect(options).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'include' });
        expect(options.body).toBeUndefined();
        api.invalidateObservations();
        expect(sync.getServerObservation()).toBeNull();
        expect(() => adapter.begin(binding)).toThrow('authoring_panel_snapshot_not_current');
        expect(lease.run).not.toHaveBeenCalled();
    }
    finally
    {
        adapter.dispose();
        await sync.stop(false);
    }
});
