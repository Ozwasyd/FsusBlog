import { installArticleWorkspaceEditorSessions } from './articleWorkspaceEditorSessionComposition';

import type { AuthoringSessionHost, AuthoringSessionHostState, AuthoringSessionRecordState } from './authoringSessionHost';
import type { ArticleWorkspaceMountedEditorResolver } from './fsusUiEditorSessionFactory';

export interface AuthoringWorkspaceSessionSource {
    readonly host: AuthoringSessionHost;
    readSession(editorSessionRef: string): AuthoringSessionRecordState | null;
    readHostState(): AuthoringSessionHostState;
}

/**
 * Consume the existing sole install entry and the original Writer's stable mounted resolver.
 * No mount discovery, alternate registry/host, body/history store or ready state is created.
 * Original host/factory refusals remain refusals; full snapshot/resource admission is pending.
 */
export function connectAuthoringWorkspaceSessionSource(
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver): AuthoringWorkspaceSessionSource
{
    const host = installArticleWorkspaceEditorSessions(resolveMountedEditor);
    return Object.freeze({ host,
        readSession: (editorSessionRef: string): AuthoringSessionRecordState | null => host.getSession(editorSessionRef),
        readHostState: (): AuthoringSessionHostState => host.exportState()
    });
}
