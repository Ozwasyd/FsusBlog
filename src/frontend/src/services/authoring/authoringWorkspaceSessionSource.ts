import { installArticleWorkspaceEditorSessions, type ArticleWorkspaceMountedEditorPreparation } from './articleWorkspaceEditorSessionComposition';
import { articleWorkspaceTabRouter } from './articleWorkspaceTabRouter';

import type { AuthoringSessionHost, AuthoringSessionHostState, AuthoringSessionRecordState } from './authoringSessionHost';
import type { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { ArticleWorkspaceMountedEditorResolver } from './fsusUiEditorSessionFactory';

export interface AuthoringWorkspaceSessionSource {
    readonly groups: AuthoringTabGroupRegistry;
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
    groups: AuthoringTabGroupRegistry,
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver,
    prepareMountedEditor?: ArticleWorkspaceMountedEditorPreparation): AuthoringWorkspaceSessionSource
{
    const assertBinding = (): void =>
    {
        if (!groups.verifyBinding(articleWorkspaceTabRouter.getRegistry()))
        {
            throw new Error('authoring-workspace-group-session-registry-mismatch');
        }
    };
    // The sole installer binds its host to this exact router's article registry.
    // Refuse a foreign group before installation can mutate the router port.
    assertBinding();
    const host = installArticleWorkspaceEditorSessions(resolveMountedEditor, prepareMountedEditor);
    assertBinding();
    return Object.freeze({ groups, host,
        readSession: (editorSessionRef: string): AuthoringSessionRecordState | null =>
        {
            assertBinding();
            return host.getSession(editorSessionRef);
        },
        readHostState: (): AuthoringSessionHostState =>
        {
            assertBinding();
            return host.exportState();
        }
    });
}
