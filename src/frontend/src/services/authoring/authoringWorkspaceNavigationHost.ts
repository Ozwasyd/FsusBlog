import { watch } from 'vue';

import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

import { createAuthoringNavigationOwnedMountedEditor } from './authoringNavigationEntrypoints';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleAnchorCaptureOptions, ArticleAnchorContextAdapter, ArticleAnchorPrimaryRetainedAdmission } from './articleAnchorContext';
import type { ArticleDocumentContextAdapter, ArticleDocumentContextAuthority, ArticleDocumentRetainedScopeReaders } from './articleDocumentContext';
import type { ArticleEditorMountedSessionPort } from './articleEditorContinuity';
import type { ArticleWorkspaceMountedEditorSource } from './articleWorkspaceMountedEditorResolver';
import type { AuthoringNavigationOwnedMountedEditor, AuthoringNavigationRevealEditor } from './authoringNavigationEntrypoints';
import type { OpenArticleDocumentEntry, OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';

/** Borrowed source-scroll facts, never focus/visibility completion or navigation admission. */
export interface AuthoringWorkspaceNavigationView
{
    readonly documentIdentity: Readonly<{ id: string; epoch: number; }>;
    readonly revision: number;
    readonly capture: ArticleAnchorCaptureOptions;
    readonly viewport: Readonly<{ height: number; reducedMotion: boolean; }>;
}

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
    viewOwner: Readonly<{ read(): AuthoringWorkspaceNavigationView | null; }> | null;
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

    function readView(): AuthoringWorkspaceNavigationView
    {
        if (!currentMount())
        {
            throw new Error('authoring-workspace-navigation-mount-unavailable');
        }
        const context = options.document.context;
        const view = options.viewOwner?.read();
        if (view?.documentIdentity.id !== context.documentId || view.documentIdentity.epoch !== context.documentEpoch
            || view.revision !== context.sourceRevision || !Number.isFinite(view.viewport.height) || view.viewport.height <= 0
            || typeof view.viewport.reducedMotion !== 'boolean' || !currentMount() || options.document.context !== context)
        {
            throw new Error('authoring-workspace-navigation-view-unavailable');
        }
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

    function current(entry: OpenArticleDocumentEntry): AuthoringNavigationOwnedMountedEditor | null
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
        if (pending || retained || disposed)
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

    async function wait(entry: OpenArticleDocumentEntry, request: AbortSignal): Promise<AuthoringNavigationOwnedMountedEditor | null>
    {
        request.throwIfAborted();
        // Absence is an owner-input gap, never an after/0/0 capture default.
        if (!options.viewOwner)
        {
            return null;
        }
        const existing = current(entry);
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
            readView();
            mounted = createAuthoringNavigationOwnedMountedEditor({ document: prepared.binding.adapter, anchors: prepared.anchors,
                association: prepared.association, editor: native, isCurrent: currentMount,
                captureOptions: () => readView().capture, viewport: () => readView().viewport });
            request.throwIfAborted();
            const result = current(entry);
            request.throwIfAborted();
            if (!result)
            {
                throw new Error('authoring-workspace-navigation-host-unavailable');
            }
            return result;
        }
        catch
        {
            dispose();
            return null;
        }
    }

    const stopAuth = watch(privateSurfaceRuntime.authGeneration, dispose, { flush: 'sync' });
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted)
    {
        dispose();
    }
    return Object.freeze({ prepare, current, wait, dispose });
}

export type AuthoringWorkspaceNavigationHost = ReturnType<typeof createAuthoringWorkspaceNavigationHost>;
