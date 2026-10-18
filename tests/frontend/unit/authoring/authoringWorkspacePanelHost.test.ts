// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultWorkspaceSnapshotLayout, workspaceSnapshotBytes, workspaceSnapshotDigest } from '@/api/authoringWorkspaceSnapshot';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import { articleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { projectArticleWriterWorkspaceDocument } from '@/services/authoring/articleWriterMountedEditorSource';
import { AuthoringTabGroupRegistry } from '@/services/authoring/authoringTabGroupRegistry';
import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';
import { authoringWorkspacePanelSlotId, createAuthoringWorkspacePanelHost } from '@/services/authoring/authoringWorkspacePanelHost';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

import type { AuthoringWorkspaceSnapshot, AuthoringWorkspaceSnapshotResult } from '@/api/authoringWorkspaceSnapshot';
import type { ArticleEditorMountedSessionPort } from '@/services/authoring/articleEditorContinuity';
import type { AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { AuthoringWorkspacePanelHost, AuthoringWorkspacePanelSpaceQuery, AuthoringWorkspacePanelWriteBinding } from '@/services/authoring/authoringWorkspacePanelHost';

// Controlled server responses enter the ORIGINAL getAdminMe/connection/receipt
// verification path. These fixtures are not real backend permission qualification.
const transport = vi.hoisted(() => ({
    principal: { id: '7', source: 'independent', adminSessionStatus: 'active', totpStepUpRequired: false, permissions: ['article.write'] },
    raw: null as unknown,
    read: null as ((signal: AbortSignal) => Promise<unknown>) | null,
    signals: [] as AbortSignal[],
    calls: 0
}));
vi.mock('@/api/auth', () => ({ getAdminMe: vi.fn(() => Promise.resolve(transport.principal)) }));
vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: vi.fn((options: { signal: AbortSignal; }) =>
{
    transport.calls += 1;
    transport.signals.push(options.signal);
    return transport.read ? transport.read(options.signal) : Promise.resolve(structuredClone(transport.raw));
}) }));

const hosts: AuthoringWorkspacePanelHost[] = [];
const cleanup: (() => void)[] = [];
let rectangles = new WeakMap<Element, DOMRect>();
const resizeCallbacks: (() => void)[] = [];
let disconnects = 0;
let fixtureSequence = 0;

function rect(left: number, top: number, width: number, height: number): DOMRect
{
    return new DOMRect(left, top, width, height);
}

function createQuery(overrides: Partial<AuthoringWorkspacePanelSpaceQuery> = {}): AuthoringWorkspacePanelSpaceQuery
{
    return { slotId: authoringWorkspacePanelSlotId, role: 0, platforms: [0], viewports: [0, 1],
        minimumSize: { inline: 20, block: 20 }, maximumSize: { inline: 1200, block: 600 },
        preferredSize: { inline: 200, block: 100 },
        budget: { modelBytes: 1024, observers: 0, timers: 0, networkRequests: 0, workers: 0, processes: 0 }, ...overrides };
}

function server(snapshot: AuthoringWorkspaceSnapshot): AuthoringWorkspaceSnapshotResult
{
    const receipt = { schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1' as const, action: 'read' as const,
        status: 'current' as const, reason: null, scope: snapshot.scope, workspaceId: 'default' as const,
        sourceDigest: snapshot.sourceDigest, revisionBefore: snapshot.revision, revisionAfter: snapshot.revision,
        tabCount: snapshot.layout.tabs.length, byteCount: workspaceSnapshotBytes(snapshot),
        inputDigest: workspaceSnapshotDigest(snapshot.scope), snapshotDigest: snapshot.contentDigest, contentDigest: '' };
    return { status: 'current', revision: snapshot.revision, snapshot,
        receipt: { ...receipt, contentDigest: workspaceSnapshotDigest(receipt) } };
}

function createFixture(userScope = 'user:7', sourceRevision = 0)
{
    fixtureSequence += 1;
    const documentOwner = articleDocumentContextAuthority.acquire({ articleId: fixtureSequence,
        siteScope: 'primary-site', userScope, content: 'selected document' });
    const adapter = documentOwner.adapter;
    if (sourceRevision > 0) adapter.updateSource(`selected document revision ${sourceRevision}`, sourceRevision);
    const documentContext = adapter.context;
    cleanup.push(() => documentOwner.release());
    const registry = new OpenArticleDocumentRegistry();
    const ratio = authoringWorkspaceRatioOwner.openWorkspace();
    cleanup.push(() => authoringWorkspaceRatioOwner.releaseWorkspace(ratio));
    const groups = new AuthoringTabGroupRegistry(registry, { initialGroupId: 'group:primary', ratioScope: ratio,
        splitRatioRef: authoringWorkspaceRatioOwner.read(ratio).ratioRef, historyCapacity: 8 });
    const tabId = 'tab:current';
    const sessionRef = 'session:current';
    const projected = projectArticleWriterWorkspaceDocument(documentContext);
    const opened = registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: 'command:open', idempotencyKey: 'command:open', expectedRevision: 0,
        intent: 'workspace', entrypoint: 'direct-route', ...projected, editorSessionRef: sessionRef,
        tabId, targetGroupId: 'group:primary', tabKind: 'pinned',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' }, lastActiveAnchorRef: null });
    expect(opened.status).toBe('applied');
    const root = document.createElement('main');
    const editorCore = document.createElement('div');
    editorCore.setAttribute('data-editor-panel', 'true');
    const editorElement = document.createElement('div');
    editorCore.append(editorElement);
    const region = document.createElement('section');
    region.setAttribute('data-authoring-workspace-extension-region', authoringWorkspacePanelSlotId);
    region.textContent = 'selected extension presentation';
    root.append(editorCore, region);
    document.body.append(root);
    cleanup.push(() => root.remove());
    rectangles.set(root, rect(0, 0, 1200, 900));
    rectangles.set(editorCore, rect(0, 0, 1000, 200));
    rectangles.set(editorElement, rect(0, 0, 1000, 200));
    rectangles.set(region, rect(0, 220, 600, 160));
    const session = { inspectDocumentState: () => ({ documentIdentity: adapter.documentIdentity, revision: adapter.context.sourceRevision }) };
    // A controlled native port double; the context, registry, ratio and group
    // are genuine original owners. Real DOM measurements are verified separately.
    const nativeEditor = { getSession: () => session } as unknown as ArticleEditorMountedSessionPort;
    const mountedSource = { readMountedEditor: () => nativeEditor,
        readDocumentBinding: () => projectArticleWriterWorkspaceDocument(adapter.context) };
    const layoutListeners = new Set<() => void>();
    const measured = {
        layoutViewportWidthCssPx: 1200, layoutViewportHeightCssPx: 900,
        browserZoomPercent: 100, visualViewportScale: 1, frame: { left: 0, top: 0, width: 1000, height: 200 },
        visualViewport: { left: 0, top: 0, width: 1200, height: 900 },
        railWidthCssPx: 0, inspectorWidthCssPx: 0, pageChromeStartCssPx: 0, pageChromeEndCssPx: 0,
        pageChromeTopCssPx: 0, pageChromeBottomCssPx: 0, scrollbarWidthCssPx: 0, splitterFootprintCssPx: 40,
        leadingGroupChromeWidthCssPx: 0, trailingGroupChromeWidthCssPx: 0, focusedGroupChromeWidthCssPx: 0,
        safeAreaLeftCssPx: 0, safeAreaRightCssPx: 0, safeAreaTopCssPx: 0, safeAreaBottomCssPx: 0,
        mobile: false, softKeyboardOpen: false
    };
    const layoutSource = { groups, sessions: { groups }, mountedEditors: mountedSource,
        measure: () => measured, reserveOperationIdentity: () => ({ commandId: 'unused', idempotencyKey: 'unused' }),
        cancelSeparator: () => undefined,
        subscribeInvalidation: (listener: () => void) =>
        {
            layoutListeners.add(listener);
            return () => layoutListeners.delete(listener);
        } } as AuthoringWorkspaceLayoutSource;
    const binding: AuthoringWorkspacePanelWriteBinding = { root, editorElement, adapter, registry, tabId, layoutSource,
        layoutPort: { refresh: () => undefined, invalidate: () => undefined, readFrameRect: () => measured.frame,
            readSeparatorRect: () => ({ left: 480, top: 0, width: 40, height: 200 }) },
        mountedSource, nativeEditor, readNativeEditor: () => nativeEditor };
    const lifetime = new AbortController();
    let current: AuthoringWorkspacePanelWriteBinding | null = binding;
    const host = createAuthoringWorkspacePanelHost({ root, region, signal: lifetime.signal, readBinding: () => current });
    hosts.push(host);
    const layout = defaultWorkspaceSnapshotLayout();
    layout.tabs = [{ tabId, identity: projected.identity, isPinned: true, isPreview: false }];
    layout.groups = [{ groupId: 'group:primary', tabIds: [tabId], activeTabId: tabId }];
    layout.activeGroupId = 'group:primary';
    const unsigned = { schemaVersion: 1 as const, workspaceId: 'default' as const, scope: { userId: 7, siteId: 'site:real' },
        sourceContract: 'fsusblog.authoring-workspace-snapshot.v1' as const, sourceDigest: 'a'.repeat(64),
        revision: 1, updatedAt: Date.now(), layout };
    const snapshot = { ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) };
    transport.raw = server(snapshot);
    return { host, root, region, editorCore, editorElement, binding, adapter, registry, groups, snapshot, measured,
        lifetime, layoutListeners, setCurrent: (value: AuthoringWorkspacePanelWriteBinding | null) => { current = value; } };
}

beforeEach(() =>
{
    privateSurfaceRuntime.resetForTests();
    privateRequestRuntime.resetForTests();
    transport.principal = { id: '7', source: 'independent', adminSessionStatus: 'active', totpStepUpRequired: false, permissions: ['article.write'] };
    transport.read = null;
    transport.signals = [];
    transport.calls = 0;
    rectangles = new WeakMap();
    resizeCallbacks.length = 0;
    disconnects = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element)
    {
        return rectangles.get(this) ?? rect(0, 0, 0, 0);
    });
    vi.stubGlobal('ResizeObserver', class
    {
        constructor(callback: () => void) { resizeCallbacks.push(callback); }
        observe() { /* controlled observer notification below */ }
        disconnect() { disconnects += 1; }
    });
});

afterEach(() =>
{
    hosts.splice(0).forEach(host => host.dispose());
    cleanup.splice(0).reverse().forEach(release => release());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('authoring workspace live panel host', () =>
{
    it('joins original numeric document, group/tab, mounted source and verified server receipt', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const result = f.host.observe(createQuery());
        expect(result.status).toBe('observed');
        if (result.status !== 'observed') { return; }
        expect(result.availableSize).toEqual({ inline: 600, block: 160 });
        expect(result.binding.documentEpoch).toBe(f.adapter.context.documentEpoch);
        expect(result.binding.sourceRevision).toBe(f.adapter.context.sourceRevision);
        expect(result.binding.tabId).toBe('tab:current');
        expect(result.binding.groupId).toBe('group:primary');
        expect(result.scope).toMatchObject({ userId: 7, siteId: 'site:real', workspaceId: 'default', snapshotDigest: f.snapshot.contentDigest });
        expect(result.scope.siteId).not.toBe(f.adapter.context.siteScope);
        expect(result.commandsEnabled).toBe(false);
        expect(result.role).toBe(0);
        expect(result.signal.aborted).toBe(false);
        expect(f.host.assertCurrent(result)).toBe(true);
        expect(f.host.assertCurrent({ ...result })).toBe(false);
        expect(transport.calls).toBe(3);
    });

    it('observes an explicit nonzero original numeric revision after canonical registry publication', async () =>
    {
        const f = createFixture('user:7', 47);
        expect(await f.host.refreshAuthority()).toBe(true);
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'observed', binding: { sourceRevision: 47,
            documentEpoch: f.adapter.context.documentEpoch } });
    });

    it('uses native region measurements instead of a caller override or desired size', async () =>
    {
        const f = createFixture();
        f.region.getBoundingClientRect = () => rect(0, 220, 9999, 9999);
        expect(await f.host.refreshAuthority()).toBe(true);
        const result = f.host.observe(createQuery());
        expect(result.status === 'observed' && result.availableSize.inline).toBe(600);
        rectangles.set(f.region, rect(0, 220, 150, 80));
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'size-unavailable' });
    });

    it.each(['user:unknown', 'user:8'])('refuses unknown or mismatched document user scope %s', async userScope =>
    {
        const f = createFixture(userScope);
        expect(await f.host.refreshAuthority()).toBe(false);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it.each(['permission', 'principal-source', 'step-up', 'inactive'])('does not treat local scopes as %s authority', async reason =>
    {
        const f = createFixture();
        if (reason === 'permission') transport.principal.permissions = [];
        if (reason === 'principal-source') transport.principal.source = 'account';
        if (reason === 'step-up') transport.principal.totpStepUpRequired = true;
        if (reason === 'inactive') transport.principal.adminSessionStatus = 'expired';
        expect(await f.host.refreshAuthority()).toBe(false);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it('rejects malformed receipt, cross-scope response and unmatched snapshot document', async () =>
    {
        const f = createFixture();
        transport.raw = { ...server(f.snapshot), receipt: { ...server(f.snapshot).receipt, contentDigest: '0'.repeat(64) } };
        expect(await f.host.refreshAuthority()).toBe(false);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it('refuses scope drift between coordinate discovery and the original verified GET', async () =>
    {
        const f = createFixture();
        transport.read = () =>
        {
            if (transport.calls === 1) return Promise.resolve(server(f.snapshot));
            const scope = { userId: 7, siteId: 'site:other' };
            const { contentDigest: ignored, ...unsigned } = f.snapshot;
            void ignored;
            return Promise.resolve(server({ ...unsigned, scope, contentDigest: workspaceSnapshotDigest({ ...unsigned, scope }) }));
        };
        expect(await f.host.refreshAuthority()).toBe(false);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it('requires matching server group/tab/document references, not just a valid receipt', async () =>
    {
        const f = createFixture();
        const other = structuredClone(f.snapshot);
        other.layout.tabs[0]!.identity.documentId = 'document:foreign';
        const { contentDigest: ignored, ...unsigned } = other;
        void ignored;
        transport.raw = server({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
        expect(await f.host.refreshAuthority()).toBe(true);
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'snapshot-document-mismatch' });
    });

    it.each(['rail', 'unknown', 'fsusblog.core.inspector'])('rejects an unregistered requested slot %s', async slotId =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        expect(f.host.observe(createQuery({ slotId }))).toMatchObject({ status: 'blocked', reason: 'unknown-slot' });
    });

    it('refuses a region moved into core or overlapping a protected core rectangle', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        f.editorCore.append(f.region);
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'core-region-conflict' });
        f.root.append(f.region);
        rectangles.set(f.region, rect(0, 80, 600, 160));
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'core-region-conflict' });
    });

    it('refuses empty, detached and hidden regions and a duplicate registration marker', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        rectangles.set(f.region, rect(0, 220, 600, 0));
        expect(f.host.observe(createQuery()).status).toBe('blocked');
        rectangles.set(f.region, rect(0, 220, 600, 160));
        f.region.hidden = true;
        expect(f.host.observe(createQuery()).status).toBe('blocked');
        f.region.hidden = false;
        const clone = f.region.cloneNode() as HTMLElement;
        f.root.append(clone);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
        clone.remove();
        f.region.remove();
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it.each(['platform', 'mobile', 'viewport', 'editor-width', 'budget', 'size-order', 'unknown-role', 'command-role', 'hole'])('keeps closed %s constraints', async reason =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        let query = createQuery();
        if (reason === 'platform') query = createQuery({ platforms: [2] });
        if (reason === 'mobile') f.measured.mobile = true;
        if (reason === 'viewport') query = createQuery({ viewports: [1] });
        if (reason === 'editor-width') rectangles.set(f.editorElement, rect(0, 0, 90, 200));
        if (reason === 'budget') query = createQuery({ budget: { ...query.budget, workers: 1 } });
        if (reason === 'size-order') query = createQuery({ minimumSize: { inline: 201, block: 20 } });
        if (reason === 'unknown-role') query = createQuery({ role: 2 as 0 });
        if (reason === 'command-role') query = createQuery({ role: 1 });
        if (reason === 'hole') query = createQuery({ platforms: [0, ,] as unknown as readonly 0[] });
        expect(f.host.observe(query).status).toBe('blocked');
        if (reason === 'command-role') expect(f.host.observe(query)).toMatchObject({ reason: 'unsupported-role' });
    });

    it('revokes real observation signals on ResizeObserver notification and position drift', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const observation = f.host.observe(createQuery());
        expect(observation.status).toBe('observed');
        if (observation.status !== 'observed') { return; }
        resizeCallbacks.forEach(notify => notify());
        expect(observation.signal.aborted).toBe(true);
        const second = f.host.observe(createQuery());
        if (second.status !== 'observed') { throw new Error('positive observation required'); }
        rectangles.set(f.region, rect(20, 220, 600, 160));
        expect(f.host.assertCurrent(second)).toBe(false);
    });

    it('retains original numeric revision semantics and rejects stale registry strings', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const observation = f.host.observe(createQuery());
        if (observation.status !== 'observed') { throw new Error('positive observation required'); }
        f.adapter.updateSource('new source', 23);
        expect(observation.signal.aborted).toBe(true);
        expect(f.adapter.context.sourceRevision).toBe(23);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it.each(['layout', 'invalidation'])('refuses %s drift during the final native owner callback', async reason =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        let reads = 0;
        f.setCurrent({ ...f.binding, readNativeEditor: () =>
        {
            reads += 1;
            // capture reads this original producer twice. Mutate only in the
            // final capture, after the first measured physical facts exist.
            if (reads === 3)
            {
                if (reason === 'layout') rectangles.set(f.region, rect(20, 220, 600, 160));
                else f.host.invalidate();
            }
            return f.binding.nativeEditor;
        } });
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'changed' });
    });

    it('rejects current tab/mount substitution and original layout invalidation', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const observed = f.host.observe(createQuery());
        if (observed.status !== 'observed') { throw new Error('positive observation required'); }
        f.layoutListeners.forEach(notify => notify());
        expect(observed.signal.aborted).toBe(true);
        f.setCurrent({ ...f.binding, tabId: 'tab:foreign' });
        expect(f.host.observe(createQuery()).status).toBe('blocked');
        f.setCurrent({ ...f.binding, readNativeEditor: () => null });
        expect(f.host.observe(createQuery()).status).toBe('blocked');
    });

    it('aborts on actual private request or auth-generation change and unmount lifetime', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const observed = f.host.observe(createQuery());
        if (observed.status !== 'observed') { throw new Error('positive observation required'); }
        privateRequestRuntime.advance('admin');
        expect(observed.signal.aborted).toBe(true);
        expect(f.host.observe(createQuery()).status).toBe('blocked');
        await privateSurfaceRuntime.invalidate('account-switch', () => undefined);
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'disposed' });
        f.lifetime.abort();
        expect(disconnects).toBeGreaterThan(0);
    });

    it('cancels an in-flight original HTTP read on unmount and refuses its late response', async () =>
    {
        const f = createFixture();
        let finish: ((value: unknown) => void) | undefined;
        transport.read = () => new Promise(resolve => { finish = resolve; });
        const pending = f.host.refreshAuthority();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        f.lifetime.abort();
        expect(transport.signals[0]!.aborted).toBe(true);
        finish!(server(f.snapshot));
        expect(await pending).toBe(false);
        expect(f.host.observe(createQuery())).toMatchObject({ status: 'blocked', reason: 'disposed' });
    });

    it('keeps one live observation, snapshots query requirements and rejects unknown fields', async () =>
    {
        const f = createFixture();
        expect(await f.host.refreshAuthority()).toBe(true);
        const query = createQuery();
        const first = f.host.observe(query);
        if (first.status !== 'observed') { throw new Error('positive observation required'); }
        (query.preferredSize as { inline: number; }).inline = 9000;
        expect(f.host.assertCurrent(first)).toBe(true);
        const second = f.host.observe(createQuery());
        expect(second.status).toBe('observed');
        expect(first.signal.aborted).toBe(true);
        expect(f.host.observe({ ...createQuery(), AvailableSize: { inline: 9000, block: 9000 } } as AuthoringWorkspacePanelSpaceQuery).status).toBe('blocked');
    });
});
