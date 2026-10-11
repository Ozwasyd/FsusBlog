import { AuthoringSessionHost } from './authoringSessionHost';
import {
    articleWorkspaceTabRouter,
    createArticleWorkspaceSessionPort
} from './articleWorkspaceTabRouter';
import {
    createFsusUiEditorSessionFactory,
    type ArticleWorkspaceMountedEditorResolver
} from './fsusUiEditorSessionFactory';

let installed: {
    readonly resolveMountedEditor: ArticleWorkspaceMountedEditorResolver;
    readonly host: AuthoringSessionHost;
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
    installed = { resolveMountedEditor, host };
    return host;
}
