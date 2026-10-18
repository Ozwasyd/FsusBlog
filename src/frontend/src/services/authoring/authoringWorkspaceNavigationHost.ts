import { watch } from 'vue';

import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

import { createAuthoringNavigationOwnedMountedEditor } from './authoringNavigationEntrypoints';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleAnchorCommand, ArticleAnchorContextAdapter, ArticleAnchorPrimaryRetainedAdmission } from './articleAnchorContext';
import type { ArticleDocumentContextAdapter, ArticleDocumentContextAuthority, ArticleDocumentRetainedScopeReaders } from './articleDocumentContext';
import type { ArticleEditorMountedSessionPort } from './articleEditorContinuity';
import type { ArticleWorkspaceMountedEditorSource } from './articleWorkspaceMountedEditorResolver';
import type { AuthoringNavigationOwnedMountedEditor, AuthoringNavigationRevealEditor } from './authoringNavigationEntrypoints';
import type { AuthoringWorkspaceNavigationView, AuthoringWorkspaceNavigationViewPort } from './authoringWorkspaceNavigationView';
import type { OpenArticleDocumentEntry, OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';
import type { MarkdownEditorSourceNavigationGesture } from '@ozwasyd/element-plus';

/** Require the real additional public capability without changing the existing primary getter. */
export function isAuthoringWorkspaceNavigationEditor(editor: ArticleEditorMountedSessionPort): editor is AuthoringNavigationRevealEditor
{
    return 'undo' in editor && typeof editor.undo === 'function' && 'redo' in editor && typeof editor.redo === 'function'
        && 'revealSourceRangeAndWait' in editor && typeof editor.revealSourceRangeAndWait === 'function';
}

/** One original mounted lifetime. No router, History, recent-store or navigation executor is installed. */
export function createAuthoringWorkspaceNavigationHost(options: Readonly<{
    authority: ArticleDocumentContextAuthority;
    document: ArticleDocumentContextAdapter;
    anchors: ArticleAnchorContextAdapter;
    registry: OpenArticleDocumentRegistry;
    mountedSource: ArticleWorkspaceMountedEditorSource;
    scope: ArticleDocumentRetainedScopeReaders;
    signal: AbortSignal;
    isCurrent: () => boolean;
    readNative: () => ArticleEditorMountedSessionPort | null;
    viewOwner: AuthoringWorkspaceNavigationViewPort | null;
    refreshNativeIdentity: () => Promise<void>;
}>)
{
    const lease = privateRequestRuntime.open('admin', options.signal);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([options.signal, lease.signal!, lifetime.signal]);
    const authGeneration = privateSurfaceRuntime.authGeneration.value;
    let retained: ArticleAnchorPrimaryRetainedAdmission | null = null;
    let mounted: AuthoringNavigationOwnedMountedEditor | null = null;
    let native: ArticleEditorMountedSessionPort | null = null;
    let sessionRef: string | null = null;
    let pending = false;
    let disposed = false;

    function check(): void
    {
        signal.throwIfAborted();
        lease.assertCurrent();
        if (disposed || privateSurfaceRuntime.isClearing.value || privateSurfaceRuntime.authGeneration.value !== authGeneration
            || !options.isCurrent())
        {
            throw new Error('authoring-workspace-navigation-host-retired');
        }
        signal.throwIfAborted();
    }

    function dispose(): void
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        const previous = retained;
        retained = null;
        mounted = null;
        native = null;
        sessionRef = null;
        lifetime.abort();
        previous?.release();
        stopAuth();
        signal.removeEventListener('abort', dispose);
        lease.release();
    }

    function currentMount(): boolean
    {
        try
        {
            check();
            if (!retained?.isCurrent() || retained.binding.adapter !== options.document || retained.anchors !== options.anchors
                || !native || !sessionRef || options.readNative() !== native
                || options.mountedSource.readMountedEditor(sessionRef) !== native)
            {
                return false;
            }
            const context = options.document.context;
            const observed = options.mountedSource.readDocumentBinding(sessionRef);
            check();
            const matches = options.readNative() === native && retained.isCurrent()
                && observed?.identity.articleId === context.articleId && observed.identity.draftId === context.draftId
                && observed.identity.documentId === context.documentId && observed.documentContext.documentEpoch === context.documentEpoch
                && options.document.isCurrentContext(context);
            check();
            return matches && options.document.context === context;
        }
        catch
        {
            return false;
        }
    }

    function guard(entry: OpenArticleDocumentEntry, request: AbortSignal): void
    {
        request.throwIfAborted();
        check();
        if (!currentMount() || !matchesEntry(entry))
        {
            throw new Error('authoring-workspace-navigation-mount-unavailable');
        }
        request.throwIfAborted();
    }

    function assertView(view: AuthoringWorkspaceNavigationView, entry: OpenArticleDocumentEntry, request: AbortSignal): void
    {
        guard(entry, request);
        const context = options.document.context;
        // Check wrapper/native custody before reading a candidate's properties.
        if (!options.viewOwner?.isCurrentSourceNavigationView(view)
            || view.source.editorSessionRef !== sessionRef || view.source.documentIdentity.id !== context.documentId
            || view.source.documentIdentity.epoch !== context.documentEpoch || view.source.revision !== context.sourceRevision)
        {
            throw new Error('authoring-workspace-navigation-view-unavailable');
        }
        guard(entry, request);
        if (options.document.context !== context)
        {
            throw new Error('authoring-workspace-navigation-context-changed');
        }
    }

    function readView(entry: OpenArticleDocumentEntry, request: AbortSignal): AuthoringWorkspaceNavigationView
    {
        guard(entry, request);
        const editor = native!;
        const session = editor.getSession(entry.editorSessionRef);
        const expected = session.inspectDocumentState();
        const view = options.viewOwner?.readSourceNavigationView({ session, expected,
            signal: AbortSignal.any([signal, request]), assertAdmission: () => guard(entry, request) });
        if (!view || native !== editor || editor.getSession(entry.editorSessionRef) !== session)
        {
            throw new Error('authoring-workspace-navigation-view-unavailable');
        }
        assertView(view, entry, request);
        return view;
    }

    function matchesEntry(entry: OpenArticleDocumentEntry): boolean
    {
        const revision = options.registry.getRevision();
        const current = options.registry.getEntry(entry.tabId);
        return !!current && current.status.permission === 'allowed' && current.status.lifecycle === 'current'
            && current.isActive && current.editorSessionRef === sessionRef
            && calculateOpenArticleDocumentDigest(current) === calculateOpenArticleDocumentDigest(entry)
            && options.registry.getRevision() === revision;
    }

    function currentOwned(entry: OpenArticleDocumentEntry): AuthoringNavigationOwnedMountedEditor | null
    {
        try
        {
            if (!options.viewOwner || !mounted || !matchesEntry(entry) || !currentMount())
            {
                return null;
            }
            mounted.binding();
            return currentMount() && matchesEntry(entry) ? mounted : null;
        }
        catch
        {
            return null;
        }
    }

    async function prepare(entry: OpenArticleDocumentEntry, request: AbortSignal): Promise<ArticleAnchorPrimaryRetainedAdmission | null>
    {
        request.throwIfAborted();
        // The first borrower owns the in-flight native refresh and its fences.
        // A repeat cannot inspect or revoke that transitional retained mount.
        if (pending)
        {
            return null;
        }
        if (retained)
        {
            if (!currentMount())
            {
                dispose();
                return null;
            }
            if (matchesEntry(entry))
            {
                request.throwIfAborted();
                return retained;
            }
        }
        if (retained || disposed)
        {
            return null;
        }
        pending = true;
        const cancel = (): void => dispose();
        request.addEventListener('abort', cancel, { once: true });
        try
        {
            check();
            const editor = options.readNative();
            if (!editor)
            {
                return null;
            }
            const revision = options.registry.getRevision();
            const observed = options.registry.getEntry(entry.tabId);
            if (!observed || calculateOpenArticleDocumentDigest(observed) !== calculateOpenArticleDocumentDigest(entry)
                || observed.status.permission !== 'allowed' || observed.status.lifecycle !== 'current' || !observed.isActive
                || options.registry.getRevision() !== revision)
            {
                return null;
            }
            retained = options.anchors.admitCurrentPrimaryRetainedDocument(options.authority, options.registry,
                entry, revision, options.scope, signal);
            native = editor;
            sessionRef = entry.editorSessionRef;
            // Canonical handover changes the original adapter publication. Refresh
            // the actual Vue identity, then reread the same mounted native object.
            await options.refreshNativeIdentity();
            request.throwIfAborted();
            check();
            if (!currentMount() || options.registry.getRevision() !== revision || !matchesEntry(entry))
            {
                throw new Error('authoring-workspace-navigation-host-changed');
            }
            request.throwIfAborted();
            return retained;
        }
        catch
        {
            dispose();
            return null;
        }
        finally
        {
            pending = false;
            request.removeEventListener('abort', cancel);
        }
    }

    async function borrow(entry: OpenArticleDocumentEntry, request: AbortSignal): Promise<AuthoringNavigationOwnedMountedEditor | null>
    {
        request.throwIfAborted();
        // Absence is an owner-input gap, never an after/0/0 capture default.
        if (!options.viewOwner)
        {
            return null;
        }
        const existing = currentOwned(entry);
        if (existing)
        {
            request.throwIfAborted();
            return existing;
        }
        const prepared = await prepare(entry, request);
        try
        {
            request.throwIfAborted();
            if (!prepared || !native || !isAuthoringWorkspaceNavigationEditor(native) || !currentMount())
            {
                return null;
            }
            readView(entry, request);
            mounted = createAuthoringNavigationOwnedMountedEditor({ document: prepared.binding.adapter, anchors: prepared.anchors,
                association: prepared.association, editor: native, isCurrent: currentMount,
                captureOptions: () => readView(entry, signal).capture, viewport: () => readView(entry, signal).source.viewport });
            request.throwIfAborted();
            const result = currentOwned(entry);
            request.throwIfAborted();
            if (!result)
            {
                throw new Error('authoring-workspace-navigation-host-unavailable');
            }
            return result;
        }
        catch
        {
            // A temporarily unavailable observation is not a retired retained owner.
            return null;
        }
    }

    /** Synchronous original Anchor capture with one exact spatial observation around every owner call. */
    async function capture(entry: OpenArticleDocumentEntry, request: AbortSignal)
    {
        const owned = await borrow(entry, request);
        if (!owned)
        {
            return null;
        }
        const view = readView(entry, request);
        const binding = owned.binding();
        assertView(view, entry, request);
        const selection = owned.selection();
        assertView(view, entry, request);
        const observed = view.source.selection;
        if (selection.start !== observed.start || selection.end !== observed.end || selection.direction !== observed.direction)
        {
            throw new Error('authoring-workspace-navigation-selection-changed');
        }
        const captured = owned.anchors.capture(binding, selection, view.capture);
        assertView(view, entry, request);
        if (owned.binding().document !== binding.document || options.document.context !== binding.document)
        {
            throw new Error('authoring-workspace-navigation-context-changed');
        }
        assertView(view, entry, request);
        return captured;
    }

    /** Original public completion plus a new spatial observation; no old-view geometry exemption. */
    async function reveal(entry: OpenArticleDocumentEntry, command: ArticleAnchorCommand | null, request: AbortSignal,
        assertAdmission: () => void)
    {
        const owned = await borrow(entry, request);
        if (!owned)
        {
            return null;
        }
        const admission = (): void =>
        {
            guard(entry, request);
            assertAdmission();
            guard(entry, request);
        };
        admission();
        const before = readView(entry, request);
        const expected = command?.range
            ? { start: command.range.start, end: command.range.end, direction: command.direction } : before.source.selection;
        assertView(before, entry, request);
        // Selection/scroll may retire `before` inside the real reveal. Its token
        // is never used to assert spatial currentness after this boundary.
        const completion = await owned.reveal(command, AbortSignal.any([signal, request]), admission);
        admission();
        const after = readView(entry, request);
        if (after.source.selection.start !== expected.start || after.source.selection.end !== expected.end
            || after.source.selection.direction !== expected.direction)
        {
            throw new Error('authoring-workspace-navigation-post-reveal-selection-changed');
        }
        admission();
        assertView(after, entry, request);
        return Object.freeze({ completion, view: after });
    }

    function manual(event: MarkdownEditorSourceNavigationGesture): void
    {
        try
        {
            check();
            const editor = options.readNative();
            const context = options.document.context;
            if (!editor || event.documentIdentity.id !== context.documentId || event.documentIdentity.epoch !== context.documentEpoch
                || event.revision !== context.sourceRevision)
            {
                return;
            }
            check();
            if (options.readNative() !== editor || options.document.context !== context)
            {
                return;
            }
            const kind = { wheel: 'wheel', touch: 'touch', pointer: 'drag', keyboard: 'selection' } as const;
            options.anchors.manual(kind[event.gesture], 'source', Date.now());
        }
        catch
        {
            // A retired original wrapper cannot update another document's intent.
        }
    }

    function resume(reason: 'input' | 'navigation' | 'idle'): boolean
    {
        return currentMount() && options.anchors.resume(reason, Date.now());
    }

    // The frozen navigation factory exposes an unscoped captureOptions callback
    // and registers its exact returned object in private custody. Do not publish
    // that raw object (or an unregistered proxy) as a fully fenced navigation port.
    function current(entry: OpenArticleDocumentEntry): null
    {
        void entry;
        return null;
    }
    function wait(entry: OpenArticleDocumentEntry, request: AbortSignal): Promise<null>
    {
        void entry;
        request.throwIfAborted();
        return Promise.resolve(null);
    }

    const stopAuth = watch(privateSurfaceRuntime.authGeneration, dispose, { flush: 'sync' });
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted)
    {
        dispose();
    }
    return Object.freeze({ prepare, capture, reveal, manual, resume, current, wait, dispose });
}

export type AuthoringWorkspaceNavigationHost = ReturnType<typeof createAuthoringWorkspaceNavigationHost>;
