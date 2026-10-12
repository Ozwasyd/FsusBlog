import { installArticleWorkspaceEditorSessions, retireArticleWorkspaceEditorSessions, type ArticleWorkspaceMountedEditorPreparation } from './articleWorkspaceEditorSessionComposition';
import { articleWorkspaceTabRouter } from './articleWorkspaceTabRouter';

import type { AuthoringSessionHost, AuthoringSessionHostState, AuthoringSessionRecordState } from './authoringSessionHost';
import type { AuthoringTabGroupRegistry } from './authoringTabGroupRegistry';
import type { ArticleWorkspaceMountedEditorResolver } from './fsusUiEditorSessionFactory';

export interface AuthoringWorkspaceSessionSource {
    readonly groups: AuthoringTabGroupRegistry;
    readonly host: AuthoringSessionHost;
    /** Retire this Root source and the SAME original composition admission; no mount/disposal receipt. */
    retire(): void;
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
    let retired = false;
    let retirementComplete = false;
    const retire = (): void =>
    {
        // Close Root reads before invoking any original retirement operation.
        retired = true;
        if (!retirementComplete)
        {
            retireArticleWorkspaceEditorSessions(host);
            retirementComplete = true;
        }
    };
    const assertCurrent = (): void =>
    {
        if (retired)
        {
            throw new Error('authoring-workspace-session-source-retired');
        }
        assertBinding();
        if (retired)
        {
            throw new Error('authoring-workspace-session-source-retired');
        }
    };
    const withCurrentSource = <Value>(read: () => Value): Value =>
    {
        try
        {
            assertCurrent();
            const value = read();
            assertCurrent();
            return value;
        }
        catch (error: unknown)
        {
            try
            {
                retire();
            }
            catch (retirementError: unknown)
            {
                throw new AggregateError([error, retirementError],
                    'authoring-workspace-session-source-retirement-incomplete', { cause: retirementError });
            }
            throw error;
        }
    };
    // A failed post-install check/freeze still owns the actual Host returned above.
    return withCurrentSource(() => Object.freeze({ groups, host, retire,
        readSession: (editorSessionRef: string): AuthoringSessionRecordState | null =>
            withCurrentSource(() => host.getSession(editorSessionRef)),
        readHostState: (): AuthoringSessionHostState =>
            withCurrentSource(() => host.exportState())
    }));
}
