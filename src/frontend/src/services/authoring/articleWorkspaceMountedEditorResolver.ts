import type { ArticleWorkspaceMountedEditorResolver } from './fsusUiEditorSessionFactory';
import type { ArticleDocumentContextRef, ArticleDocumentIdentity } from './openArticleDocumentRegistry';
import type { useAdminArticleWrite } from '../../composables/useAdminArticleWrite';
import type { MarkdownEditorSessionExpose } from '@ozwasyd/element-plus';

type ArticleWorkspaceOriginalDraftCheckpoint = ReturnType<typeof useAdminArticleWrite>['authoringDraftCheckpointRuntime'];

/** Read the original Writer's retained mounts and document owner; do not echo router entries. */
export interface ArticleWorkspaceMountedEditorSource {
    readMountedEditor(editorSessionRef: string): MarkdownEditorSessionExpose | null;
    readDocumentBinding(editorSessionRef: string): {
        readonly identity: ArticleDocumentIdentity;
        readonly documentContext: ArticleDocumentContextRef;
    } | null;
    /** Same actual original Writer owner; absent on sources that cannot borrow it. */
    readDraftCheckpoint?(editorSessionRef: string): ArticleWorkspaceOriginalDraftCheckpoint | null;
}

/** No registry, mount creation, body/history copy or route fallback is owned here. */
export function createArticleWorkspaceMountedEditorResolver(
    source: ArticleWorkspaceMountedEditorSource
): ArticleWorkspaceMountedEditorResolver
{
    return (entry) =>
    {
        const sessionRef = entry.editorSessionRef;
        const editor = source.readMountedEditor(sessionRef);
        const owner = source.readDocumentBinding(sessionRef);
        if (!editor || !owner)
        {
            return null;
        }
        const identity = Object.freeze({ ...owner.identity });
        const documentContext = Object.freeze({ ...owner.documentContext });
        const session = editor.getSession(sessionRef);
        const document = session.inspectDocumentState();
        if (document.documentIdentity.id !== identity.documentId
            || document.documentIdentity.epoch !== documentContext.documentEpoch)
        {
            throw new Error('article-workspace-mounted-editor-document-owner-mismatch');
        }
        const currentOwner = source.readDocumentBinding(sessionRef);
        if (!currentOwner)
        {
            throw new Error('article-workspace-mounted-editor-binding-changed');
        }
        if (source.readMountedEditor(sessionRef) !== editor
            || editor.getSession(sessionRef) !== session
            || currentOwner.identity.articleId !== identity.articleId
            || currentOwner.identity.draftId !== identity.draftId
            || currentOwner.identity.documentId !== identity.documentId
            || currentOwner.documentContext.documentEpoch !== documentContext.documentEpoch
            || currentOwner.documentContext.sourceRevision !== documentContext.sourceRevision
            || currentOwner.documentContext.draftRevision !== documentContext.draftRevision)
        {
            throw new Error('article-workspace-mounted-editor-binding-changed');
        }
        const currentDocument = session.inspectDocumentState();
        if (currentDocument.documentIdentity.id !== document.documentIdentity.id
            || currentDocument.documentIdentity.epoch !== document.documentIdentity.epoch
            || currentDocument.revision !== document.revision)
        {
            throw new Error('article-workspace-mounted-editor-document-changed');
        }
        const draftCheckpoint = source.readDraftCheckpoint?.(sessionRef) ?? null;
        const finalOwner = source.readDocumentBinding(sessionRef);
        const finalDocument = session.inspectDocumentState();
        if (source.readMountedEditor(sessionRef) !== editor || editor.getSession(sessionRef) !== session
            || finalOwner?.identity.articleId !== identity.articleId || finalOwner.identity.draftId !== identity.draftId
            || finalOwner.identity.documentId !== identity.documentId || finalOwner.documentContext.documentEpoch !== documentContext.documentEpoch
            || finalOwner.documentContext.sourceRevision !== documentContext.sourceRevision || finalOwner.documentContext.draftRevision !== documentContext.draftRevision
            || finalDocument.documentIdentity.id !== document.documentIdentity.id || finalDocument.documentIdentity.epoch !== document.documentIdentity.epoch
            || finalDocument.revision !== document.revision)
        {
            throw new Error('article-workspace-mounted-editor-draft-source-changed');
        }
        return { editor, identity, documentContext, editorRevision: document.revision, draftCheckpoint };
    };
}
