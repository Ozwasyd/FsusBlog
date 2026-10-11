import type { MarkdownEditorSessionExpose } from '@ozwasyd/element-plus';
import type { ArticleDocumentContextRef, ArticleDocumentIdentity } from './openArticleDocumentRegistry';
import type { ArticleWorkspaceMountedEditorResolver } from './fsusUiEditorSessionFactory';

/** Read the original Writer's retained mounts and document owner; do not echo router entries. */
export interface ArticleWorkspaceMountedEditorSource {
    readMountedEditor(editorSessionRef: string): MarkdownEditorSessionExpose | null;
    readDocumentBinding(editorSessionRef: string): {
        readonly identity: ArticleDocumentIdentity;
        readonly documentContext: ArticleDocumentContextRef;
    } | null;
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
        if (source.readMountedEditor(sessionRef) !== editor
            || editor.getSession(sessionRef) !== session
            || !currentOwner
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
        return { editor, identity, documentContext, editorRevision: document.revision };
    };
}
