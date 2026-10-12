import type { ArticleDocumentContext, ArticleDocumentContextAdapter } from './articleDocumentContext';
import type { ArticleEditorContinuityPort, ArticleEditorMountedSessionPort } from './articleEditorContinuity';
import type { ArticleWorkspaceMountedEditorSource } from './articleWorkspaceMountedEditorResolver';
import type { OpenArticleDocumentRegistry } from './openArticleDocumentRegistry';
import type { useAdminArticleWrite } from '../../composables/useAdminArticleWrite';

type ArticleWorkspaceOriginalDraftCheckpoint = ReturnType<typeof useAdminArticleWrite>['authoringDraftCheckpointRuntime'];

/** Project the original context into the existing workspace reference vocabulary; this is not an identity or permission issuer. */
export function projectArticleWriterWorkspaceDocument(document: ArticleDocumentContext):
NonNullable<ReturnType<ArticleWorkspaceMountedEditorSource['readDocumentBinding']>>
{
    return Object.freeze({
        identity: Object.freeze({ articleId: document.articleId, draftId: document.draftId, documentId: document.documentId }),
        documentContext: Object.freeze({ documentEpoch: document.documentEpoch,
            sourceRevision: `source-revision:${document.sourceRevision}`, draftRevision: document.draftRevision })
    });
}

/** Borrow one actual Writer mount and the original document/registry owners; retain no second mount, body or session index. */
export function createArticleWriterMountedEditorSource(
    owner: ArticleDocumentContextAdapter,
    registry: OpenArticleDocumentRegistry,
    editor: ArticleEditorContinuityPort,
    readMountedEditor: () => ArticleEditorMountedSessionPort | null,
    isActive: () => boolean,
    readOriginalDraft?: () => ArticleWorkspaceOriginalDraftCheckpoint | null
): ArticleWorkspaceMountedEditorSource
{
    const readMounted = (editorSessionRef: string): ArticleEditorMountedSessionPort | null =>
    {
        if (!isActive())
        {
            return null;
        }
        const document = owner.context;
        const association = registry.listEntries().find(entry =>
            entry.editorSessionRef === editorSessionRef && entry.identity.articleId === document.articleId
            && entry.identity.draftId === document.draftId && entry.identity.documentId === document.documentId);
        if (!owner.isCurrentContext(document) || !association)
        {
            return null;
        }
        const registryRevision = registry.getRevision();
        const mounted = readMountedEditor();
        if (mounted !== editor || !isActive() || !owner.isCurrentContext(document))
        {
            return null;
        }
        // The caller's mounted read may synchronously change the original association.
        // Refuse it before getSession can bind this native editor to the borrowed ref.
        const currentAssociation = registry.getEntry(association.tabId);
        return registry.getRevision() === registryRevision && currentAssociation?.editorSessionRef === editorSessionRef
            && currentAssociation.identity.articleId === document.articleId
            && currentAssociation.identity.draftId === document.draftId
            && currentAssociation.identity.documentId === document.documentId ? mounted : null;
    };
    return Object.freeze({
        readMountedEditor: readMounted,
        readDraftCheckpoint: (editorSessionRef: string) =>
        {
            const mounted = readMounted(editorSessionRef);
            const document = owner.context;
            if (!mounted || !readOriginalDraft)
            {
                return null;
            }
            const draft = readOriginalDraft();
            return draft && readMounted(editorSessionRef) === mounted && isActive() && owner.isCurrentContext(document)
                ? draft : null;
        },
        readDocumentBinding: (editorSessionRef: string) =>
        {
            const mounted = readMounted(editorSessionRef);
            if (!mounted)
            {
                return null;
            }
            const document = owner.context;
            const session = mounted.getSession(editorSessionRef);
            const observed = session.inspectDocumentState();
            if (observed.documentIdentity.id !== document.documentId || observed.documentIdentity.epoch !== document.documentEpoch
                || observed.revision !== document.sourceRevision || readMounted(editorSessionRef) !== mounted
                || !owner.isCurrentContext(document) || mounted.getSession(editorSessionRef) !== session)
            {
                return null;
            }
            const current = session.inspectDocumentState();
            if (current.documentIdentity.id !== observed.documentIdentity.id
                || current.documentIdentity.epoch !== observed.documentIdentity.epoch || current.revision !== observed.revision
                || !isActive() || !owner.isCurrentContext(document))
            {
                return null;
            }
            return projectArticleWriterWorkspaceDocument(document);
        }
    });
}
