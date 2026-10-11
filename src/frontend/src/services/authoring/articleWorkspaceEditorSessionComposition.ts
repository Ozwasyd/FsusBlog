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
import type { MarkdownEditorSessionRestoreProof, MarkdownEditorSessionSnapshot } from '@ozwasyd/element-plus';

let installed: {
    readonly resolveMountedEditor: ArticleWorkspaceMountedEditorResolver;
    readonly host: AuthoringSessionHost;
    readonly factory: ArticleWorkspaceFsusUiEditorSessionFactory;
    readonly assertActive: () => void;
    readonly retire: () => void;
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
        installed.assertActive();
        return installed.host;
    }

    let retired = false;
    let usedTick = 0;
    const assertActive = (): void =>
    {
        if (retired)
        {
            throw new Error('article-workspace-session-composition-retired');
        }
    };
    const factory = createFsusUiEditorSessionFactory((entry) =>
    {
        assertActive();
        const binding = resolveMountedEditor(entry);
        assertActive();
        return binding;
    });
    const host = new AuthoringSessionHost(factory);
    const retire = (): void =>
    {
        retired = true;
    };
    installed = { resolveMountedEditor, host, factory, assertActive, retire };
    try
    {
        articleWorkspaceTabRouter.setSessionPort(createArticleWorkspaceSessionPort(host, {
            nextUsedTick: () =>
            {
                assertActive();
                return ++usedTick;
            }
        }));
    }
    catch (error)
    {
        retire();
        throw error;
    }
    return host;
}

/** Revoke admission and retain actual owner custody; this does not dispose resources. */
export function retireArticleWorkspaceEditorSessions(host: AuthoringSessionHost): void
{
    if (installed?.host !== host)
    {
        throw new Error('article-workspace-session-composition-owner-mismatch');
    }
    installed.retire();
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
    installed.assertActive();
    return installed.factory.inspectResourceSources(entry);
}

/** Capture the upstream retained token through the same installed factory. */
export function captureArticleWorkspaceRetainedEditorSnapshot(
    entry: OpenArticleDocumentEntry
): MarkdownEditorSessionSnapshot
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.captureRetainedSnapshot(entry);
}

/** Restore only the same upstream retained owner; not a complete host snapshot. */
export function restoreArticleWorkspaceRetainedEditorSnapshot(
    entry: OpenArticleDocumentEntry,
    snapshot: MarkdownEditorSessionSnapshot
): MarkdownEditorSessionRestoreProof
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.restoreRetainedSnapshot(entry, snapshot);
}
