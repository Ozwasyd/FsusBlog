import {
    articleWorkspaceTabRouter,
    createArticleWorkspaceSessionPort
} from './articleWorkspaceTabRouter';
import { AuthoringSessionHost } from './authoringSessionHost';
import {
    createFsusUiEditorSessionFactory,
    type ArticleWorkspaceMountedEditorResolver,
    type ArticleWorkspaceFsusUiEditorSessionFactory,
    type ArticleWorkspaceEditorResourceSources
} from './fsusUiEditorSessionFactory';

import type { OpenArticleDocumentEntry } from './openArticleDocumentRegistry';

let installed: {
    readonly resolveMountedEditor: ArticleWorkspaceMountedEditorResolver;
    readonly host: AuthoringSessionHost;
    readonly factory: ArticleWorkspaceFsusUiEditorSessionFactory;
} | null = null;

/**
 * Sole application composition entry. An actual mounted owner resolver is
 * mandatory; this function does not discover components or fabricate a session.
 * Current upstream gaps still reject admission through the original host.
 */
export function installArticleWorkspaceEditorSessions(
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver
): AuthoringSessionHost
{
    if (installed)
    {
        if (installed.resolveMountedEditor !== resolveMountedEditor)
        {
            throw new Error('article-workspace-session-composition-already-installed');
        }
        return installed.host;
    }

    const factory = createFsusUiEditorSessionFactory(resolveMountedEditor);
    const host = new AuthoringSessionHost(factory);
    articleWorkspaceTabRouter.setSessionPort(createArticleWorkspaceSessionPort(host));
    installed = { resolveMountedEditor, host, factory };
    return host;
}

/** Read from the same installed factory/owners; do not install a fallback host. */
export function inspectArticleWorkspaceEditorResourceSources(
    entry: OpenArticleDocumentEntry
): ArticleWorkspaceEditorResourceSources
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    return installed.factory.inspectResourceSources(entry);
}
