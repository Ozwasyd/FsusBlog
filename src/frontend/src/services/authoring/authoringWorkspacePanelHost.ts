import { watch } from 'vue';

import { requireWorkspaceServerObservation } from '@/api/authoringWorkspaceSnapshot';
import type { AuthoringWorkspaceServerObservation } from '@/api/authoringWorkspaceSnapshot';
import { connectAuthoringWorkspaceSnapshotHttp } from '@/api/authoringWorkspaceSnapshotConnection';
import type { AuthoringWorkspaceSnapshotConnection } from '@/api/authoringWorkspaceSnapshotConnection';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

import { articleDocumentContextAuthority, ArticleDocumentContextAdapter } from './articleDocumentContext';
import { projectArticleWriterWorkspaceDocument } from './articleWriterMountedEditorSource';
import { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import { calculateAuthoringWorkspaceGeometry } from './authoringWorkspaceGeometryPolicy';
import { calculateOpenArticleDocumentDigest, OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';


import type { ArticleDocumentContext } from './articleDocumentContext';
import type { ArticleEditorMountedSessionPort } from './articleEditorContinuity';
import type { ArticleWorkspaceMountedEditorSource } from './articleWorkspaceMountedEditorResolver';
import type { AuthoringWorkspaceLayoutPort } from './authoringWorkspaceLayoutContext';
import type { AuthoringWorkspaceLayoutSource } from './authoringWorkspaceLayoutController';
import type { OpenArticleDocumentEntry } from './openArticleDocumentRegistry';

/** One host-owned document-flow region, never a Rail/Inspector/Tab/Group slot. */
export const authoringWorkspacePanelSlotId = 'authoring.extension.document';

type Size = Readonly<{ inline: number; block: number; }>;
type Resources = Readonly<{
    modelBytes: number; observers: number; timers: number;
    networkRequests: number; workers: number; processes: number;
}>;
type PhysicalSpace = Readonly<{
    status: 'available'; availableSize: Size;
    rect: DOMRect; editor: DOMRect; rootRect: DOMRect;
    viewport: 0 | 1; minimumEditorInline: number; browserZoomPercent: number;
}>;

/** A readonly space query projected from v1 requirements, not a wire DTO or verified declaration. */
export interface AuthoringWorkspacePanelSpaceQuery
{
    readonly slotId: string;
    readonly role: 0 | 1;
    readonly platforms: readonly (0 | 1 | 2)[];
    readonly viewports: readonly (0 | 1 | 2)[];
    readonly minimumSize: Size;
    readonly maximumSize: Size;
    readonly preferredSize: Size;
    readonly budget: Resources;
}

/** Only the actual Write owner supplies these original references. No slot facts are input. */
export interface AuthoringWorkspacePanelWriteBinding
{
    readonly root: HTMLElement;
    readonly editorElement: HTMLElement;
    readonly adapter: ArticleDocumentContextAdapter;
    readonly registry: OpenArticleDocumentRegistry;
    readonly tabId: string;
    readonly layoutSource: AuthoringWorkspaceLayoutSource;
    readonly layoutPort: AuthoringWorkspaceLayoutPort;
    readonly mountedSource: ArticleWorkspaceMountedEditorSource;
    readonly nativeEditor: ArticleEditorMountedSessionPort;
    readonly readNativeEditor: () => ArticleEditorMountedSessionPort | null;
}

export type AuthoringWorkspacePanelHostBlockReason =
    | 'disposed' | 'reentrant' | 'invalid-query' | 'unknown-slot' | 'region-unavailable'
    | 'core-region-conflict' | 'binding-unavailable' | 'authority-unavailable'
    | 'snapshot-document-mismatch' | 'unsupported-role' | 'unsupported-platform' | 'unsupported-viewport'
    | 'size-unavailable' | 'editor-width-unavailable' | 'resource-limit' | 'changed';

interface CapturedBinding
{
    readonly owner: AuthoringWorkspacePanelWriteBinding;
    readonly document: ArticleDocumentContext;
    readonly entry: OpenArticleDocumentEntry;
    readonly entryDigest: string;
    readonly registryRevision: number;
    readonly groupRevision: number;
    readonly groupDigest: string;
    readonly nativeEditor: NonNullable<ReturnType<ArticleWorkspaceMountedEditorSource['readMountedEditor']>>;
}

export interface AuthoringWorkspacePanelSpaceObservation
{
    readonly status: 'observed';
    readonly commandsEnabled: false;
    readonly slotId: typeof authoringWorkspacePanelSlotId;
    readonly availableSize: Size;
    readonly regionRect: Readonly<{ left: number; top: number; width: number; height: number; }>;
    readonly editorInline: number;
    readonly minimumEditorInline: number;
    readonly browserZoomPercent: number;
    readonly platform: 0;
    readonly viewport: 0 | 1;
    readonly role: 0;
    readonly maximumActivePanels: 1;
    readonly maximumResources: Resources;
    readonly scope: Readonly<{
        userId: number; siteId: string; workspaceId: 'default';
        sourceDigest: string; receiptDigest: string; snapshotDigest: string;
    }>;
    readonly binding: Readonly<{
        groupId: string; tabId: string; editorSessionRef: string; documentId: string;
        documentEpoch: number; sourceRevision: number; contextDigest: string;
        registryRevision: number; groupRevision: number;
    }>;
    readonly authGeneration: string;
    readonly requestGeneration: number;
    /** A genuine host/private-request lifetime, not an identifier reconstructed by a caller. */
    readonly signal: AbortSignal;
}

export type AuthoringWorkspacePanelHostResult = AuthoringWorkspacePanelSpaceObservation
    | Readonly<{ status: 'blocked'; reason: AuthoringWorkspacePanelHostBlockReason; commandsEnabled: false; }>;

export interface AuthoringWorkspacePanelHost
{
    refreshAuthority(): Promise<boolean>;
    observe(query: AuthoringWorkspacePanelSpaceQuery): AuthoringWorkspacePanelHostResult;
    assertCurrent(observation: AuthoringWorkspacePanelSpaceObservation): boolean;
    invalidate(): void;
    dispose(): void;
}

// Host-owned capacity for this read-only presentation leaf. It starts no plugin
// timer/network/worker/process. Backend manifest/identity/model admission is separate.
const maximumResources: Resources = Object.freeze({ modelBytes: 65536, observers: 0, timers: 0,
    networkRequests: 0, workers: 0, processes: 0 });
// Original AccountRouteFrame owns both before-content chrome and routed Write.
const coreOwnerSelector = '.account-route-frame.admin-workspace-frame';
const coreRegions = '[data-editor-panel], [data-active-inspector], [data-group-ref], [data-workspace-tab-strip], '
    + '[data-article-workspace-tab-strip], [data-article-library-rail], .account-route-frame__sidebar';
const regionOwners = new WeakMap<HTMLElement, object>();

function block(reason: AuthoringWorkspacePanelHostBlockReason): Extract<AuthoringWorkspacePanelHostResult, { status: 'blocked'; }>
{
    return Object.freeze({ status: 'blocked', reason, commandsEnabled: false });
}

function exactData(value: unknown, fields: readonly string[]): boolean
{
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length && fields.every(field =>
        Object.hasOwn(value, field) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, 'value'));
}

function validSize(value: Size): boolean
{
    return exactData(value, ['inline', 'block']) && [value.inline, value.block].every(number =>
        Number.isSafeInteger(number) && number >= 1 && number <= 16384);
}

function fits(value: Size, bound: Size): boolean
{
    return value.inline <= bound.inline && value.block <= bound.block;
}

function validEnums(values: readonly number[]): boolean
{
    if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype
        || values.length < 1 || values.length > 3 || Reflect.ownKeys(values).length !== values.length + 1)
    {
        return false;
    }
    for (let index = 0; index < values.length; index += 1)
    {
        const descriptor = Object.getOwnPropertyDescriptor(values, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || ![0, 1, 2].includes(descriptor.value as number))
        {
            return false;
        }
    }
    return new Set(values).size === values.length;
}

function validQuery(query: AuthoringWorkspacePanelSpaceQuery): boolean
{
    return exactData(query, ['slotId', 'role', 'platforms', 'viewports', 'minimumSize', 'maximumSize', 'preferredSize', 'budget'])
        && typeof query.slotId === 'string' && (query.role === 0 || query.role === 1)
        && validEnums(query.platforms) && validEnums(query.viewports)
        && validSize(query.minimumSize) && validSize(query.maximumSize) && validSize(query.preferredSize)
        && fits(query.minimumSize, query.preferredSize) && fits(query.preferredSize, query.maximumSize)
        && exactData(query.budget, ['modelBytes', 'observers', 'timers', 'networkRequests', 'workers', 'processes'])
        && Object.values(query.budget).every(value => Number.isSafeInteger(value) && value >= 0)
        && query.budget.modelBytes > 0;
}

function sameBinding(left: CapturedBinding, right: CapturedBinding): boolean
{
    return left.owner.root === right.owner.root && left.owner.editorElement === right.owner.editorElement
        && left.owner.adapter === right.owner.adapter && left.owner.registry === right.owner.registry
        && left.owner.layoutSource === right.owner.layoutSource && left.owner.layoutPort === right.owner.layoutPort
        && left.owner.mountedSource === right.owner.mountedSource && left.owner.tabId === right.owner.tabId
        && left.document === right.document && left.entryDigest === right.entryDigest
        && left.registryRevision === right.registryRevision && left.groupRevision === right.groupRevision
        && left.groupDigest === right.groupDigest && left.nativeEditor === right.nativeEditor;
}

/** observe a deployed region and original owners; never issue admission, execute or persist. */
export function createAuthoringWorkspacePanelHost(options: Readonly<{
    root: HTMLElement;
    region: HTMLElement;
    signal: AbortSignal;
    readBinding: () => AuthoringWorkspacePanelWriteBinding | null;
}>): AuthoringWorkspacePanelHost
{
    const { root, region, signal, readBinding } = options;
    const coreOwner = root.closest<HTMLElement>(coreOwnerSelector);
    const token = Object.freeze({});
    const lease = privateRequestRuntime.open('admin', signal);
    const lifetime = new AbortController();
    const lifetimeSignal = AbortSignal.any([signal, lease.signal!, lifetime.signal]);
    const authGeneration = privateSurfaceRuntime.authGeneration.value;
    let generation = 0n;
    let disposed = false;
    let observing = false;
    let attempted = false;
    let connection: AuthoringWorkspaceSnapshotConnection | null = null;
    let server: AuthoringWorkspaceServerObservation | null = null;
    let stopDocument: (() => void) | null = null;
    let stopLayout: (() => void) | null = null;
    let pendingAuthority: AbortController | null = null;
    const active = new Set<AbortController>();
    const issued = new WeakMap<AuthoringWorkspacePanelSpaceObservation,
        { binding: CapturedBinding; query: AuthoringWorkspacePanelSpaceQuery; controller: AbortController; generation: bigint; }>();

    function invalidate(): void
    {
        generation += 1n;
        pendingAuthority?.abort();
        const previous = [...active];
        active.clear();
        previous.forEach(controller => controller.abort());
    }

    function check(): void
    {
        lifetimeSignal.throwIfAborted();
        lease.assertCurrent();
        if (disposed || privateSurfaceRuntime.isClearing.value || authGeneration !== privateSurfaceRuntime.authGeneration.value)
        {
            throw new Error('panel-host-current-lifetime-required');
        }
    }

    function capture(): CapturedBinding
    {
        check();
        const owner = readBinding();
        if (owner?.root !== root || !(owner.adapter instanceof ArticleDocumentContextAdapter)
            || !(owner.registry instanceof OpenArticleDocumentRegistry)
            || !(owner.layoutSource.groups instanceof AuthoringTabGroupRegistry)
            || !owner.layoutSource.groups.verifyBinding(owner.registry)
            || owner.layoutSource.sessions?.groups !== owner.layoutSource.groups || !owner.layoutSource.mountedEditors
            || !root.isConnected || !owner.editorElement.isConnected || !root.contains(owner.editorElement)
            || root.ownerDocument !== owner.editorElement.ownerDocument)
        {
            throw new Error('panel-host-original-owner-required');
        }
        const document = owner.adapter.context;
        const entry = owner.registry.getEntry(owner.tabId);
        const projection = owner.layoutSource.groups.exportProjection();
        const group = projection.state.groups.find(item => item.groupId === entry?.owningGroupId);
        const tab = group?.tabs.find(item => item.tabId === owner.tabId);
        const projectedDocument = projectArticleWriterWorkspaceDocument(document);
        if (articleDocumentContextAuthority.context !== document || !owner.adapter.isCurrentContext(document)
            || !/^user:[1-9][0-9]*$/u.test(document.userScope)
            || !Number.isSafeInteger(document.documentEpoch) || document.documentEpoch < 1
            || !Number.isSafeInteger(document.sourceRevision) || document.sourceRevision < 0
            || !entry || !entry.isActive || entry.status.lifecycle !== 'current'
            || (entry.status.permission !== 'allowed' && entry.status.permission !== 'read-only')
            || !tab || group?.activeTabId !== entry.tabId || projection.state.activeGroupId !== group.groupId
            || projection.state.articleRegistryRevision !== owner.registry.getRevision()
            || tab.editorSessionRef !== entry.editorSessionRef || tab.documentEpoch !== document.documentEpoch
            || tab.lifecycleRevision !== entry.lifecycleRevision
            || calculateOpenArticleDocumentDigest(entry.identity) !== calculateOpenArticleDocumentDigest(projectedDocument.identity)
            || calculateOpenArticleDocumentDigest(entry.documentContext) !== calculateOpenArticleDocumentDigest(projectedDocument.documentContext))
        {
            throw new Error('panel-host-current-document-required');
        }
        const nativeEditor = owner.mountedSource.readMountedEditor(entry.editorSessionRef);
        const nativeBinding = owner.mountedSource.readDocumentBinding(entry.editorSessionRef);
        if (!nativeEditor || nativeEditor !== owner.nativeEditor || nativeEditor !== owner.readNativeEditor() || !nativeBinding
            || owner.layoutSource.mountedEditors.readMountedEditor(entry.editorSessionRef) !== nativeEditor
            || calculateOpenArticleDocumentDigest(owner.layoutSource.mountedEditors.readDocumentBinding(entry.editorSessionRef))
                !== calculateOpenArticleDocumentDigest(projectedDocument)
            || calculateOpenArticleDocumentDigest(nativeBinding) !== calculateOpenArticleDocumentDigest(projectedDocument))
        {
            throw new Error('panel-host-original-mount-required');
        }
        const session = nativeEditor.getSession(entry.editorSessionRef);
        const nativeDocument = session.inspectDocumentState();
        if (nativeDocument.documentIdentity.id !== document.documentId
            || nativeDocument.documentIdentity.epoch !== document.documentEpoch || nativeDocument.revision !== document.sourceRevision
            || owner.mountedSource.readMountedEditor(entry.editorSessionRef) !== nativeEditor
            || owner.readNativeEditor() !== nativeEditor
            || nativeEditor.getSession(entry.editorSessionRef) !== session || !owner.adapter.isCurrentContext(document))
        {
            throw new Error('panel-host-mounted-document-changed');
        }
        check();
        return { owner, document, entry, entryDigest: calculateOpenArticleDocumentDigest(entry),
            registryRevision: owner.registry.getRevision(), groupRevision: projection.state.revision,
            groupDigest: projection.state.contentDigest, nativeEditor };
    }

    // Original context/registry/group reads only; no native/layout producer callback.
    function bindingCurrent(binding: CapturedBinding): boolean
    {
        const { owner, document } = binding;
        const projection = owner.layoutSource.groups.exportProjection();
        return articleDocumentContextAuthority.context === document && owner.adapter.isCurrentContext(document)
            && owner.registry.getRevision() === binding.registryRevision
            && calculateOpenArticleDocumentDigest(owner.registry.getEntry(owner.tabId)) === binding.entryDigest
            && owner.layoutSource.groups.verifyBinding(owner.registry)
            && owner.layoutSource.sessions?.groups === owner.layoutSource.groups
            && projection.state.revision === binding.groupRevision && projection.state.contentDigest === binding.groupDigest;
    }

    function readGeometry(binding: CapturedBinding)
    {
        const projection = binding.owner.layoutSource.groups.exportProjection();
        // Copy at each producer boundary: a later callback must not rewrite an
        // earlier sample through a shared frame/viewport/measurement object.
        const measured = structuredClone(binding.owner.layoutSource.measure(projection));
        check();
        const frame = structuredClone(binding.owner.layoutPort.readFrameRect());
        check();
        return { projection, measured, frame,
            digest: calculateOpenArticleDocumentDigest({ measured, frame, state: projection.state }) };
    }

    function regionAvailable(binding: CapturedBinding): boolean
    {
        return !!coreOwner?.isConnected && coreOwner.ownerDocument === root.ownerDocument && coreOwner.contains(root)
            && root.closest(coreOwnerSelector) === coreOwner
            && regionOwners.get(region) === token && region.isConnected && root.contains(region)
            && region.ownerDocument === root.ownerDocument && region !== binding.owner.editorElement
            && !region.contains(binding.owner.editorElement) && !binding.owner.editorElement.contains(region)
            && region.getAttribute('data-authoring-workspace-extension-region') === authoringWorkspacePanelSlotId
            && root.querySelectorAll(`[data-authoring-workspace-extension-region="${authoringWorkspacePanelSlotId}"]`).length === 1
            && !region.closest('[hidden], [inert], [aria-hidden="true"]');
    }

    function visibleRect(view: Window, rect: DOMRect): { left: number; top: number; right: number; bottom: number; } | null
    {
        const visible = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        for (let element: HTMLElement | null = region; element; element = element.parentElement)
        {
            const style = view.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                || style.contentVisibility === 'hidden' || style.opacity !== '' && Number(style.opacity) === 0)
            {
                return null;
            }
            if (element === region)
            {
                continue;
            }
            const clips = (overflow: string): boolean => ['hidden', 'clip', 'auto', 'scroll', 'overlay'].includes(overflow);
            const clipInline = clips(style.overflowX || style.overflow);
            const clipBlock = clips(style.overflowY || style.overflow);
            if (!clipInline && !clipBlock)
            {
                continue;
            }
            const bounds = Element.prototype.getBoundingClientRect.call(element);
            // Client dimensions describe the padding clip box. Convert its
            // local dimensions to the current measured CSS coordinate space.
            const scaleInline = element.offsetWidth > 0 ? bounds.width / element.offsetWidth : 1;
            const scaleBlock = element.offsetHeight > 0 ? bounds.height / element.offsetHeight : 1;
            const left = bounds.left + element.clientLeft * scaleInline;
            const top = bounds.top + element.clientTop * scaleBlock;
            if (clipInline)
            {
                visible.left = Math.max(visible.left, left);
                visible.right = Math.min(visible.right, left + element.clientWidth * scaleInline);
            }
            if (clipBlock)
            {
                visible.top = Math.max(visible.top, top);
                visible.bottom = Math.min(visible.bottom, top + element.clientHeight * scaleBlock);
            }
        }
        return visible;
    }

    /** Native DOM/pure geometry only: no producer callback may follow the final read. */
    function readPhysical(binding: CapturedBinding, query: AuthoringWorkspacePanelSpaceQuery,
        measured: ReturnType<AuthoringWorkspaceLayoutSource['measure']>,
        frame: ReturnType<AuthoringWorkspaceLayoutPort['readFrameRect']>,
        projection: ReturnType<AuthoringTabGroupRegistry['exportProjection']>): PhysicalSpace
        | Extract<AuthoringWorkspacePanelHostResult, { status: 'blocked'; }>
    {
        if (!resize || !mutation || !regionAvailable(binding))
        {
            return block('region-unavailable');
        }
        const cores = [...coreOwner!.querySelectorAll(coreRegions)];
        if (region.closest(coreRegions) || cores.some(element => region.contains(element)))
        {
            return block('core-region-conflict');
        }
        const geometry = calculateAuthoringWorkspaceGeometry({ ...measured,
            requestedLayout: projection.state.layoutState, splitRatioPermille: projection.state.splitRatio.splitRatioPermille });
        const view = root.ownerDocument.defaultView;
        if (!view || !frame || geometry.status !== 'planned'
            || [frame.left, frame.top, frame.width, frame.height].some((value, index) =>
                value !== [measured.frame.left, measured.frame.top, measured.frame.width, measured.frame.height][index]))
        {
            return block('binding-unavailable');
        }
        if (!query.platforms.includes(0))
        {
            return block('unsupported-platform');
        }
        if (measured.mobile)
        {
            return block('unsupported-viewport');
        }
        const viewport = measured.layoutViewportWidthCssPx >= 1024 ? 0 : 1;
        if (!query.viewports.includes(viewport))
        {
            return block('unsupported-viewport');
        }
        const rect = Element.prototype.getBoundingClientRect.call(region);
        const editor = Element.prototype.getBoundingClientRect.call(binding.owner.editorElement);
        const rootRect = Element.prototype.getBoundingClientRect.call(root);
        if (cores.some(element =>
        {
            const core = Element.prototype.getBoundingClientRect.call(element);
            return core.width > 0 && core.height > 0 && rect.left < core.right && rect.right > core.left
                && rect.top < core.bottom && rect.bottom > core.top;
        }))
        {
            return block('core-region-conflict');
        }
        const visible = visibleRect(view, rect);
        if (!visible)
        {
            return block('size-unavailable');
        }
        const clip = measured.visualViewport;
        const availableSize = Object.freeze({
            inline: Math.floor(Math.min(visible.right, rootRect.right, clip.left + clip.width,
                geometry.available.left + geometry.available.width) - Math.max(visible.left, rootRect.left, clip.left, geometry.available.left)),
            block: Math.floor(Math.min(visible.bottom, rootRect.bottom, clip.top + clip.height) - Math.max(visible.top, rootRect.top, clip.top))
        });
        if (!validSize(availableSize) || !fits(query.preferredSize, availableSize)
            || measured.browserZoomPercent < 50 || measured.browserZoomPercent > 400)
        {
            return block('size-unavailable');
        }
        if (editor.width < geometry.minimumUsableWidthCssPx)
        {
            return block('editor-width-unavailable');
        }
        if (Object.entries(maximumResources).some(([key, value]) => query.budget[key as keyof Resources] > value))
        {
            return block('resource-limit');
        }
        return { status: 'available' as const, availableSize, rect, editor, rootRect, viewport,
            minimumEditorInline: geometry.minimumUsableWidthCssPx, browserZoomPercent: measured.browserZoomPercent };
    }

    async function refreshAuthority(): Promise<boolean>
    {
        if (attempted || disposed)
        {
            return false;
        }
        attempted = true;
        const epoch = generation;
        let opened: AuthoringWorkspaceSnapshotConnection | null = null;
        try
        {
            const before = capture();
            if (!regionAvailable(before))
            {
                return false;
            }
            stopDocument = before.owner.adapter.subscribeContext(invalidate);
            stopLayout = before.owner.layoutSource.subscribeInvalidation(invalidate);
            const subscribed = capture();
            if (!sameBinding(before, subscribed) || epoch !== generation)
            {
                return false;
            }
            pendingAuthority = new AbortController();
            const requestSignal = AbortSignal.any([lifetimeSignal, pendingAuthority.signal]);
            opened = await connectAuthoringWorkspaceSnapshotHttp(requestSignal);
            const observed = await opened.api.read(requestSignal);
            requireWorkspaceServerObservation(observed);
            opened.assertCurrent();
            check();
            const after = capture();
            if (!sameBinding(before, after) || epoch !== generation
                || observed.status !== 'current' || !observed.snapshot
                || before.document.userScope !== `user:${observed.receipt.scope.userId}`)
            {
                opened.dispose();
                return false;
            }
            connection = opened;
            server = observed;
            return true;
        }
        catch
        {
            opened?.dispose();
            return false;
        }
        finally
        {
            pendingAuthority = null;
        }
    }

    function observe(input: AuthoringWorkspacePanelSpaceQuery, keepPrevious = false): AuthoringWorkspacePanelHostResult
    {
        if (disposed)
        {
            return block('disposed');
        }
        if (observing)
        {
            invalidate();
            return block('reentrant');
        }
        observing = true;
        const epoch = generation;
        try
        {
            if (!validQuery(input))
            {
                return block('invalid-query');
            }
            const query: AuthoringWorkspacePanelSpaceQuery = Object.freeze({ ...input,
                platforms: Object.freeze([...input.platforms]), viewports: Object.freeze([...input.viewports]),
                minimumSize: Object.freeze({ ...input.minimumSize }), maximumSize: Object.freeze({ ...input.maximumSize }),
                preferredSize: Object.freeze({ ...input.preferredSize }), budget: Object.freeze({ ...input.budget }) });
            if (query.slotId !== authoringWorkspacePanelSlotId)
            {
                return block('unknown-slot');
            }
            // This deployed region registers ReadOnlySummary only. A caller's
            // closed HostCommandList value cannot supply its missing owner.
            if (query.role !== 0)
            {
                return block('unsupported-role');
            }
            const before = capture();
            if (!resize || !mutation || !regionAvailable(before))
            {
                return block('region-unavailable');
            }
            if (!connection || !server)
            {
                return block('authority-unavailable');
            }
            connection.assertCurrent();
            requireWorkspaceServerObservation(server);
            const snapshot = server.snapshot;
            const serverTab = snapshot?.layout.tabs.find(tab => tab.tabId === before.entry.tabId);
            const serverGroup = snapshot?.layout.groups.find(group => group.groupId === before.entry.owningGroupId);
            if (!snapshot || before.document.userScope !== `user:${server.receipt.scope.userId}`
                || !serverTab || calculateOpenArticleDocumentDigest(serverTab.identity) !== calculateOpenArticleDocumentDigest(before.entry.identity)
                || !serverGroup?.tabIds.includes(before.entry.tabId) || serverGroup.activeTabId !== before.entry.tabId
                || snapshot.layout.activeGroupId !== before.entry.owningGroupId)
            {
                return block('snapshot-document-mismatch');
            }
            const initialGeometry = readGeometry(before);
            const physical = readPhysical(before, query, initialGeometry.measured, initialGeometry.frame, initialGeometry.projection);
            if (physical.status !== 'available')
            {
                return physical;
            }
            const { availableSize, rect, editor, rootRect, viewport } = physical;
            const controller = new AbortController();
            const observation: AuthoringWorkspacePanelSpaceObservation = Object.freeze({ status: 'observed', commandsEnabled: false,
                slotId: authoringWorkspacePanelSlotId, availableSize,
                regionRect: Object.freeze({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }),
                editorInline: Math.floor(editor.width),
                minimumEditorInline: physical.minimumEditorInline, browserZoomPercent: physical.browserZoomPercent,
                platform: 0, viewport, role: 0, maximumActivePanels: 1, maximumResources,
                scope: Object.freeze({ ...server.receipt.scope, workspaceId: 'default', sourceDigest: server.receipt.sourceDigest,
                    receiptDigest: server.receipt.contentDigest, snapshotDigest: snapshot.contentDigest }),
                binding: Object.freeze({ groupId: before.entry.owningGroupId, tabId: before.entry.tabId,
                    editorSessionRef: before.entry.editorSessionRef, documentId: before.document.documentId,
                    documentEpoch: before.document.documentEpoch, sourceRevision: before.document.sourceRevision,
                    contextDigest: before.document.contextDigest, registryRevision: before.registryRevision,
                    groupRevision: before.groupRevision }),
                authGeneration, requestGeneration: lease.generation!,
                signal: AbortSignal.any([lifetimeSignal, controller.signal]) });
            // Revoking the previous observation invokes caller-held abort
            // listeners. Finish those callbacks BEFORE the last owner/DOM checks.
            if (!keepPrevious)
            {
                const previous = [...active];
                active.clear();
                previous.forEach(value => value.abort());
            }
            // Two fixed confirmation passes, never a retry-until-stable loop.
            // Every capture may invoke native callbacks, so obtain NEW geometry
            // afterwards and refuse the first changed input or physical result.
            for (let remaining = 2; remaining > 0; remaining -= 1)
            {
                connection.assertCurrent();
                requireWorkspaceServerObservation(server);
                const after = capture();
                const currentGeometry = readGeometry(after);
                if (!sameBinding(before, after) || initialGeometry.digest !== currentGeometry.digest || epoch !== generation)
                {
                    controller.abort();
                    return block('changed');
                }
                const finalPhysical = readPhysical(after, query, currentGeometry.measured, currentGeometry.frame, currentGeometry.projection);
                if (finalPhysical.status !== 'available')
                {
                    controller.abort();
                    return finalPhysical;
                }
                const sameRect = (left: DOMRect, right: DOMRect): boolean =>
                    left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height;
                check();
                // No external callback follows these original-owner and native
                // DOM checks. Geometry producers must retain their existing
                // synchronous invalidation contract; this issues no admission.
                if (!bindingCurrent(after) || !sameRect(rect, finalPhysical.rect)
                    || !sameRect(editor, finalPhysical.editor) || !sameRect(rootRect, finalPhysical.rootRect)
                    || availableSize.inline !== finalPhysical.availableSize.inline || availableSize.block !== finalPhysical.availableSize.block
                    || physical.minimumEditorInline !== finalPhysical.minimumEditorInline
                    || physical.browserZoomPercent !== finalPhysical.browserZoomPercent || viewport !== finalPhysical.viewport
                    || epoch !== generation)
                {
                    controller.abort();
                    return block('changed');
                }
            }
            active.add(controller);
            issued.set(observation, { binding: before, query, controller, generation: epoch });
            return observation;
        }
        catch
        {
            return block('binding-unavailable');
        }
        finally
        {
            observing = false;
        }
    }

    function assertCurrent(observation: AuthoringWorkspacePanelSpaceObservation): boolean
    {
        const owned = issued.get(observation);
        if (owned?.generation !== generation || owned.controller.signal.aborted || observation.signal.aborted)
        {
            return false;
        }
        const current = observe(owned.query, true);
        if (current.status !== 'observed')
        {
            owned.controller.abort();
            active.delete(owned.controller);
            return false;
        }
        const currentOwned = issued.get(current)!;
        currentOwned.controller.abort();
        active.delete(currentOwned.controller);
        const matches = sameBinding(owned.binding, currentOwned.binding)
            && !owned.controller.signal.aborted && owned.generation === generation
            && current.availableSize.inline === observation.availableSize.inline
            && current.availableSize.block === observation.availableSize.block
            && current.editorInline === observation.editorInline && current.browserZoomPercent === observation.browserZoomPercent
            && current.viewport === observation.viewport && current.minimumEditorInline === observation.minimumEditorInline
            && current.regionRect.left === observation.regionRect.left && current.regionRect.top === observation.regionRect.top
            && current.regionRect.width === observation.regionRect.width && current.regionRect.height === observation.regionRect.height;
        if (!matches)
        {
            owned.controller.abort();
            active.delete(owned.controller);
        }
        return matches;
    }

    function dispose(): void
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        server = null;
        invalidate();
        if (regionOwners.get(region) === token)
        {
            regionOwners.delete(region);
        }
        resize?.disconnect();
        mutation?.disconnect();
        view?.removeEventListener('resize', invalidate);
        view?.removeEventListener('scroll', invalidate, true);
        lifetimeSignal.removeEventListener('abort', dispose);
        stopAuth();
        stopDocument?.();
        stopLayout?.();
        connection?.dispose();
        lifetime.abort();
        lease.release();
    }

    const view = root.ownerDocument.defaultView;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidate);
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(invalidate);
    const stopAuth = watch(privateSurfaceRuntime.authGeneration, dispose, { flush: 'sync' });
    if (!regionOwners.has(region) && root !== region && root.contains(region))
    {
        regionOwners.set(region, token);
        resize?.observe(region);
        resize?.observe(root);
        mutation?.observe(root.ownerDocument, { childList: true, subtree: true, attributes: true });
        view?.addEventListener('resize', invalidate);
        view?.addEventListener('scroll', invalidate, true);
    }
    lifetimeSignal.addEventListener('abort', dispose, { once: true });
    if (lifetimeSignal.aborted)
    {
        dispose();
    }
    return Object.freeze({ refreshAuthority: refreshAuthority, observe: (query: AuthoringWorkspacePanelSpaceQuery) => observe(query), assertCurrent: assertCurrent,
        invalidate: invalidate, dispose: dispose });
}
