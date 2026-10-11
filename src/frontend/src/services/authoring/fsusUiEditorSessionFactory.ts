import {
    type AuthoringSessionSnapshotContext,
    type FsusUiPublicEditorSession,
    type FsusUiPublicEditorSessionFactory
} from './authoringSessionHost';
import {
    calculateOpenArticleDocumentDigest,
    type ArticleDocumentContextRef,
    type ArticleDocumentIdentity,
    type OpenArticleDocumentEntry
} from './openArticleDocumentRegistry';

import type {
    MarkdownEditorSession,
    MarkdownEditorSessionExpose,
    MarkdownEditorSessionLastValidRender,
    MarkdownEditorSessionRenderRestoreProof,
    MarkdownEditorSessionSnapshot
} from '@ozwasyd/element-plus';

/** Supplied by the existing mounted editor/document owner, never route discovery. */
export interface ArticleWorkspaceMountedEditorBinding {
    readonly editor: MarkdownEditorSessionExpose;
    readonly identity: ArticleDocumentIdentity;
    readonly documentContext: ArticleDocumentContextRef;
    readonly editorRevision: number;
}

export type ArticleWorkspaceMountedEditorResolver = (
    entry: OpenArticleDocumentEntry
) => ArticleWorkspaceMountedEditorBinding | null;

export interface ArticleWorkspaceFsusUiEditorSessionFactory extends FsusUiPublicEditorSessionFactory {
    captureRetainedSnapshot(entry: OpenArticleDocumentEntry): MarkdownEditorSessionSnapshot;
    captureLastValidRender(entry: OpenArticleDocumentEntry): MarkdownEditorSessionLastValidRender | null;
    restoreLastValidRender(entry: OpenArticleDocumentEntry, render: MarkdownEditorSessionLastValidRender): Promise<MarkdownEditorSessionRenderRestoreProof>;
}

function assertBinding(
    binding: ArticleWorkspaceMountedEditorBinding,
    identity: ArticleDocumentIdentity,
    context: ArticleDocumentContextRef
): void
{
    if (binding.identity.articleId !== identity.articleId
        || binding.identity.draftId !== identity.draftId
        || binding.identity.documentId !== identity.documentId)
    {
        throw new Error('public-editor-document-identity-mismatch');
    }
    if (binding.documentContext.documentEpoch !== context.documentEpoch)
    {
        throw new Error('public-editor-document-epoch-mismatch');
    }
    if (binding.documentContext.sourceRevision !== context.sourceRevision
        || binding.documentContext.draftRevision !== context.draftRevision)
    {
        throw new Error('public-editor-source-revision-mismatch');
    }
}

/**
 * Uses the real public FsusUI session, with no body/history store or session index.
 * The retained upstream API currently cannot issue the complete #2294 snapshot.
 */
export function createFsusUiEditorSessionFactory(
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver
): ArticleWorkspaceFsusUiEditorSessionFactory
{
    function resolveSession(entry: OpenArticleDocumentEntry): {
        binding: ArticleWorkspaceMountedEditorBinding;
        session: MarkdownEditorSession;
    }
    {
        const binding = resolveMountedEditor(entry);
        if (!binding)
        {
            throw new Error('public-editor-mounted-owner-unavailable');
        }
        assertBinding(binding, entry.identity, entry.documentContext);
        const session = binding.editor.getSession(entry.editorSessionRef);
        if (session.editorSessionRef !== entry.editorSessionRef)
        {
            throw new Error('public-editor-session-ref-mismatch');
        }
        const document = session.inspectDocumentState();
        if (document.documentIdentity.id !== binding.identity.documentId
            || document.documentIdentity.epoch !== binding.documentContext.documentEpoch
            || document.revision !== binding.editorRevision)
        {
            throw new Error('public-editor-mounted-document-owner-mismatch');
        }
        return { binding, session };
    }

    function assertCurrent(
        entry: OpenArticleDocumentEntry,
        session: MarkdownEditorSession,
        context: AuthoringSessionSnapshotContext
    ): void
    {
        if (context.editorSessionRef !== session.editorSessionRef)
        {
            throw new Error('public-editor-session-ref-mismatch');
        }
        const current = resolveSession(entry);
        if (current.session !== session)
        {
            throw new Error('public-editor-session-owner-replaced');
        }
        assertBinding(current.binding, context.identity, context.documentContext);
        if (context.permission !== entry.status.permission
            || context.permissionRef !== entry.status.statusRef)
        {
            throw new Error('public-editor-permission-context-mismatch');
        }
    }

    return {
        captureLastValidRender(entry)
        {
            const { binding, session } = resolveSession(entry);
            const capture = session.captureLastValidRender();
            const current = resolveSession(entry);
            if (current.session !== session
                || current.binding.editorRevision !== binding.editorRevision)
            {
                throw new Error('public-editor-last-valid-render-owner-stale');
            }
            if (capture && (capture.documentIdentity.id !== binding.identity.documentId
                || capture.documentIdentity.epoch !== binding.documentContext.documentEpoch
                || capture.revision !== binding.editorRevision))
            {
                throw new Error('public-editor-last-valid-render-context-mismatch');
            }
            return capture;
        },
        async restoreLastValidRender(entry, render)
        {
            const { binding, session } = resolveSession(entry);
            const proof = await session.restoreLastValidRender(render, {
                documentIdentity: {
                    id: binding.identity.documentId,
                    epoch: binding.documentContext.documentEpoch
                },
                revision: binding.editorRevision
            });
            const current = resolveSession(entry);
            if (current.session !== session
                || current.binding.editorRevision !== binding.editorRevision)
            {
                throw new Error('public-editor-last-valid-render-restore-owner-stale');
            }
            return proof;
        },
        captureRetainedSnapshot(entry)
        {
            const { binding, session } = resolveSession(entry);
            const snapshot = session.captureSnapshot(calculateOpenArticleDocumentDigest, {
                documentIdentity: {
                    id: binding.identity.documentId,
                    epoch: binding.documentContext.documentEpoch
                },
                revision: binding.editorRevision
            });
            // Re-resolve after the digest callback; a document replacement must
            // not be silently accepted as the requested registry session.
            const current = resolveSession(entry);
            if (current.session !== session
                || snapshot.documentIdentity.id !== binding.identity.documentId
                || snapshot.documentIdentity.epoch !== binding.documentContext.documentEpoch
                || snapshot.revision !== binding.editorRevision
                || current.binding.editorRevision !== snapshot.revision)
            {
                throw new Error('public-editor-retained-snapshot-stale');
            }
            return snapshot;
        },
        createSession(entry): FsusUiPublicEditorSession
        {
            const { session } = resolveSession(entry);
            return {
                editorSessionRef: session.editorSessionRef,
                captureSnapshot(context)
                {
                    assertCurrent(entry, session, context);
                    // Upstream exposes an actual nullable full-document render
                    // ref and same-mounted projection restoration, but complete panel state and
                    // application draft/journal checkpoint owners remain absent.
                    // Refuse before capture so an existing snapshot is preserved.
                    throw new Error('public-editor-full-snapshot-owner-unavailable:panel-state,renderer-restoration,draft,crash-journal');
                },
                inspectResources: () => session.inspectResources(),
                pauseResources: () => session.pauseResources(),
                resumeResources: () => session.resumeResources(),
                restoreSnapshot(snapshot, context)
                {
                    assertCurrent(entry, session, context);
                    return {
                        status: 'blocked',
                        snapshotRef: snapshot.snapshotRef,
                        snapshotDigest: snapshot.snapshotDigest,
                        identityValidated: false,
                        refsValidated: false,
                        reason: 'public-editor-full-snapshot-owner-unavailable:panel-state,renderer-restoration,draft,crash-journal'
                    };
                },
                disposeAfterSnapshot: snapshotRef => session.disposeAfterSnapshot(snapshotRef)
            };
        }
    };
}
