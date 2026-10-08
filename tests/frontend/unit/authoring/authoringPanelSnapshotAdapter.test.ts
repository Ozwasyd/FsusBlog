import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoringWorkspaceSnapshotApi, defaultWorkspaceSnapshotLayout, workspaceSnapshotBytes, workspaceSnapshotDigest, type AuthoringWorkspaceSnapshot, type AuthoringWorkspaceSnapshotReceipt } from '@/api/authoringWorkspaceSnapshot';
import { AuthoringPanelSnapshotBindingAdapter, authoringPanelSnapshotBindingSchema, type AuthoringPanelSnapshotBinding } from '@/services/authoring/authoringPanelSnapshotAdapter';
import { ArticleWorkspaceTabRouter } from '@/services/authoring/articleWorkspaceTabRouter';
import { AuthoringWorkspaceSnapshotCache } from '@/services/authoring/authoringWorkspaceSnapshotCache';
import { AuthoringWorkspaceSnapshotSync } from '@/services/authoring/authoringWorkspaceSnapshotSync';

const now = 1800000000000;
const scope = { userId: 73, siteId: 'site:primary' };
const sourceDigest = 'a'.repeat(64);
const active: { adapter: AuthoringPanelSnapshotBindingAdapter; sync: AuthoringWorkspaceSnapshotSync }[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => { for (const owned of active.splice(0)) { owned.adapter.dispose(); await owned.sync.stop(false); } vi.useRealTimers(); });

// Verified transport fixtures and explicit test admission do not establish production grants.
async function setup() {
    const tabs = new ArticleWorkspaceTabRouter();
    const input = { identity: { articleId: 8, draftId: 'draft:008', documentId: 'document:008' },
        documentContext: { documentEpoch: 2, sourceRevision: 'source:011', draftRevision: 'draft-revision:011' }, title: 'Test article',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false, permission: 'allowed' as const, lifecycle: 'current' as const, statusRef: 'status:008' },
        targetGroupId: 'group:primary', tabKind: 'pinned' as const, entrypoint: 'rail' as const };
    await tabs.openOrActivate(input);
    const entry = tabs.getRegistry().listEntries()[0]!;
    const layout = defaultWorkspaceSnapshotLayout();
    layout.tabs = [{ tabId: entry.tabId, identity: entry.identity, isPreview: false, isPinned: true }];
    layout.groups = [{ groupId: entry.owningGroupId, tabIds: [entry.tabId], activeTabId: entry.tabId }];
    layout.activeGroupId = entry.owningGroupId;
    const unsigned = { schemaVersion: 1 as const, workspaceId: 'default' as const, scope, sourceContract: 'fsusblog.authoring-workspace-snapshot.v1' as const,
        sourceDigest, revision: 1, updatedAt: now, layout };
    const snapshot: AuthoringWorkspaceSnapshot = { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
    const receipt: AuthoringWorkspaceSnapshotReceipt = { schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1', action: 'read', status: 'current', reason: null,
        scope, workspaceId: 'default', sourceDigest, revisionBefore: 1, revisionAfter: 1, tabCount: 1, byteCount: workspaceSnapshotBytes(snapshot),
        inputDigest: workspaceSnapshotDigest(scope), snapshotDigest: snapshot.contentDigest, contentDigest: '' };
    const server = { status: 'current', revision: 1, snapshot, receipt: { ...receipt, contentDigest: workspaceSnapshotDigest(receipt) } };
    const transport = { read: vi.fn(async () => structuredClone(server)), write: vi.fn(async () => { throw new Error('panel must not write workspace'); }), reset: vi.fn(async () => { throw new Error('panel must not reset workspace'); }) };
    const api = new AuthoringWorkspaceSnapshotApi(transport, scope, sourceDigest);
    const storage = { get: async () => null, replace: async () => {}, remove: async () => {}, close: () => {} };
    const sync = new AuthoringWorkspaceSnapshotSync(api, new AuthoringWorkspaceSnapshotCache(storage, scope, sourceDigest), null, 'browser:test');
    await sync.start();
    const admission = { isCurrent: vi.fn(() => true) };
    const adapter = new AuthoringPanelSnapshotBindingAdapter(sync, tabs, admission);
    active.push({ adapter, sync });
    const binding: AuthoringPanelSnapshotBinding = { schema: authoringPanelSnapshotBindingSchema, panelId: 'acme.panel:one', extensionId: 'acme.extension', extensionVersion: '1.0.0', packageSha256: 'b'.repeat(64),
        scope, sourceDigest, snapshotRevision: 1, snapshotDigest: snapshot.contentDigest, groupId: entry.owningGroupId, tabId: entry.tabId,
        documentIdentity: entry.identity, documentContext: entry.documentContext, requestId: 'request:one', grantReference: 'grant:one', deadline: now + 1000 };
    return { tabs, sync, api, adapter, admission, binding, transport, server, input };
}

describe('panel binding to actual snapshot and document owners', () => {
    it('returns frozen content-free coordinates without writing a workspace or admitting a slot', async () => {
        const f = await setup(); const session = f.adapter.begin(f.binding);
        expect(f.adapter.isCurrent(session)).toBe(true);
        expect(Object.isFrozen(session.binding.documentContext)).toBe(true);
        expect(f.transport.write).not.toHaveBeenCalled(); expect(f.transport.reset).not.toHaveBeenCalled();
        expect(Object.keys(session)).toEqual(['binding', 'signal']);
    });
    it.each(['scope', 'revision', 'snapshot', 'source', 'group', 'tab', 'epoch', 'document'] as const)('rejects %s drift', async drift => {
        const f = await setup(); const binding = structuredClone(f.binding);
        if (drift === 'scope') binding.scope.userId = 42;
        if (drift === 'revision') binding.snapshotRevision++;
        if (drift === 'snapshot') binding.snapshotDigest = 'c'.repeat(64);
        if (drift === 'source') binding.sourceDigest = 'c'.repeat(64);
        if (drift === 'group') binding.groupId = 'group:other';
        if (drift === 'tab') binding.tabId = 'tab:other';
        if (drift === 'epoch') binding.documentContext.documentEpoch++;
        if (drift === 'document') binding.documentIdentity.documentId = 'document:other';
        expect(() => f.adapter.begin(binding)).toThrow('authoring_panel_snapshot_not_current'); expect(f.adapter.current).toBeNull();
    });
    it('rejects a cloned observation even with a valid content digest', async () => {
        const f = await setup(); vi.spyOn(f.sync, 'getServerObservation').mockReturnValue(structuredClone(f.sync.getServerObservation()));
        expect(() => f.adapter.begin(f.binding)).toThrow('server_observation_required');
    });
    it('cancels superseded provenance and refuses offline/cache or stopped authority', async () => {
        const f = await setup(); const session = f.adapter.begin(f.binding); f.api.invalidateObservations();
        expect(f.adapter.current).toBeNull(); expect(session.signal.aborted).toBe(true);
        await f.sync.setOnline(false); expect(() => f.adapter.begin(f.binding)).toThrow('authoring_panel_snapshot_not_current');
        await f.sync.stop(false); expect(() => f.adapter.begin(f.binding)).toThrow('authoring_panel_snapshot_not_current');
    });
    it('cancels current document permission revocation immediately', async () => {
        const f = await setup(); const session = f.adapter.begin(f.binding); const tab = f.tabs.getTab(f.binding.tabId)!;
        f.tabs.markStatus(tab.tabId, { ...tab.status, permission: 'revoked' });
        expect(session.signal.aborted).toBe(true); expect(f.adapter.current).toBeNull();
    });
    it('cancels when another article becomes active', async () => {
        const f = await setup(); const session = f.adapter.begin(f.binding);
        await f.tabs.openOrActivate({ ...f.input, identity: { articleId: 9, draftId: 'draft:009', documentId: 'document:009' } });
        expect(session.signal.aborted).toBe(true);
    });
    it('hidden and expired requests abort and do not resurrect old sessions', async () => {
        const f = await setup(); const first = f.adapter.begin(f.binding); f.adapter.setVisible(false); expect(first.signal.aborted).toBe(true);
        expect(() => f.adapter.begin(f.binding)).toThrow('authoring_panel_snapshot_not_current'); f.adapter.setVisible(true);
        const second = f.adapter.begin(f.binding); await vi.advanceTimersByTimeAsync(1000);
        expect(second.signal.aborted).toBe(true); expect(f.adapter.current).toBeNull();
    });
    it('host admission cannot publish a session after cancelling it', async () => {
        const f = await setup(); f.admission.isCurrent.mockImplementation(() => { f.adapter.cancel(); return true; });
        expect(() => f.adapter.begin(f.binding)).toThrow('authoring_panel_snapshot_not_current'); expect(f.adapter.current).toBeNull();
    });
    it('keeps a replacement begun from the previous abort callback', async () => {
        const f = await setup(); const first = f.adapter.begin(f.binding);
        first.signal.addEventListener('abort', () => f.adapter.begin({ ...f.binding, requestId: 'request:replacement' }), { once: true });
        expect(() => f.adapter.begin({ ...f.binding, requestId: 'request:outer' })).toThrow('authoring_panel_snapshot_not_current');
        expect(f.adapter.current?.binding.requestId).toBe('request:replacement');
    });
    it('blocks two-group layouts without the missing official group integration', async () => {
        const f = await setup(); f.server.snapshot.layout.groups.push({ groupId: 'group:secondary', tabIds: [], activeTabId: null });
        const { contentDigest: _, ...unsigned } = f.server.snapshot; f.server.snapshot.contentDigest = workspaceSnapshotDigest(unsigned);
        f.server.receipt.snapshotDigest = f.server.snapshot.contentDigest; f.server.receipt.byteCount = workspaceSnapshotBytes(f.server.snapshot);
        f.server.receipt.contentDigest = workspaceSnapshotDigest({ ...f.server.receipt, contentDigest: '' });
        const observation = await f.api.read(); vi.spyOn(f.sync, 'getServerObservation').mockReturnValue(observation);
        expect(() => f.adapter.begin({ ...f.binding, snapshotDigest: observation.snapshot!.contentDigest })).toThrow('authoring_panel_snapshot_not_current');
    });
    it.each(['model', 'componentName', 'slotId'])('rejects unregistered %s', async field => {
        const f = await setup(); expect(() => f.adapter.begin({ ...f.binding, [field]: 'unregistered' })).toThrow('unknown_or_missing_field');
    });
    it('rejects accessors before evaluating them and closes on repeated disposal', async () => {
        const f = await setup(); const getter = vi.fn(() => 'panel:getter'); const forged = { ...f.binding };
        Object.defineProperty(forged, 'panelId', { enumerable: true, get: getter }); expect(() => f.adapter.begin(forged)).toThrow('plain_data_required'); expect(getter).not.toHaveBeenCalled();
        const session = f.adapter.begin(f.binding); f.adapter.dispose(); f.adapter.dispose(); expect(session.signal.aborted).toBe(true);
        expect(() => f.adapter.begin(f.binding)).toThrow('authoring_panel_snapshot_not_current');
    });
});
