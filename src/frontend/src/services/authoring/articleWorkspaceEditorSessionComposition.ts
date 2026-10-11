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
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type {
    ArticleWorkspaceRetainedRecoveryCheckpoint,
    ArticleWorkspaceRetainedRecoveryPort,
    ArticleWorkspaceRetainedRecoverySnapshot,
    ArticleWorkspaceRetainedRecoverySource
} from './articleWorkspaceRetainedRecoverySnapshot';
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
    }, assertActive);
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

/** Pass the actual original Writer binding and its prepared inspect(token).checkpointRef. */
export function captureArticleWorkspaceRetainedRecoverySnapshot(
    entry: OpenArticleDocumentEntry,
    recoveryCheckpoint: ArticleWorkspaceRetainedRecoveryCheckpoint,
    checkpointRef: string
): ArticleWorkspaceRetainedRecoverySnapshot
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.captureRetainedRecoverySnapshot(entry, recoveryCheckpoint, checkpointRef);
}

/** Reuses captured original custody; retirement is rechecked by the SAME factory after await. */
export function restoreArticleWorkspaceRetainedRecoverySnapshot(
    entry: OpenArticleDocumentEntry,
    snapshot: ArticleWorkspaceRetainedRecoverySnapshot
): Promise<MarkdownEditorSessionRestoreProof>
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.restoreRetainedRecoverySnapshot(entry, snapshot);
}

/** One borrowed source reader; no automatic storage, binding creation, host or checkpoint index. */
export function createArticleWorkspaceRetainedRecoveryPort(
    source: ArticleWorkspaceRetainedRecoverySource
): ArticleWorkspaceRetainedRecoveryPort
{
    const readOwner = () =>
    {
        const composition = installed;
        if (!composition)
        {
            throw new Error('article-workspace-session-composition-not-installed');
        }
        composition.assertActive();
        const registry = articleWorkspaceTabRouter.getRegistry();
        const revision = registry.getRevision();
        const current = source.readCurrent();
        if (!current)
        {
            throw new Error('article-workspace-recovery-caller-owner-unavailable');
        }
        const entry = current.entry;
        const checkpoint = current.checkpoint;
        const entryDigest = calculateOpenArticleDocumentDigest(entry);
        const canonical = registry.getEntry(entry.tabId);
        composition.assertActive();
        if (installed !== composition || articleWorkspaceTabRouter.getRegistry() !== registry
            || registry.getRevision() !== revision || !canonical
            || calculateOpenArticleDocumentDigest(canonical) !== entryDigest)
        {
            throw new Error('article-workspace-recovery-caller-association-stale');
        }
        composition.assertActive();
        return { composition, registry, revision, entry, checkpoint, entryDigest };
    };
    const assertOwner = (owner: ReturnType<typeof readOwner>): void =>
    {
        const current = readOwner();
        if (current.composition !== owner.composition || current.registry !== owner.registry
            || current.revision !== owner.revision || current.checkpoint !== owner.checkpoint
            || current.entryDigest !== owner.entryDigest)
        {
            throw new Error('article-workspace-recovery-caller-owner-stale');
        }
        owner.composition.assertActive();
    };
    return Object.freeze({
        async prepareSnapshot(signal?: AbortSignal)
        {
            const owner = readOwner();
            const prepare = owner.checkpoint.prepare.bind(owner.checkpoint);
            const inspect = owner.checkpoint.inspect.bind(owner.checkpoint);
            assertOwner(owner);
            const token = await prepare(signal);
            assertOwner(owner);
            if (!token || signal?.aborted)
            {
                throw new Error('article-workspace-recovery-checkpoint-prepare-refused');
            }
            const info = inspect(token);
            const reference = info?.checkpointRef;
            assertOwner(owner);
            if (!reference)
            {
                throw new Error('article-workspace-recovery-checkpoint-custody-unavailable');
            }
            const snapshot = owner.composition.factory.captureRetainedRecoverySnapshot(owner.entry, owner.checkpoint, reference);
            assertOwner(owner);
            return snapshot;
        },
        async restoreSnapshot(snapshot: ArticleWorkspaceRetainedRecoverySnapshot)
        {
            // Pin this external getter before final original caller/admission checks.
            const checkpoint = snapshot.recoveryCheckpoint;
            const owner = readOwner();
            if (checkpoint !== owner.checkpoint)
            {
                throw new Error('article-workspace-recovery-checkpoint-binding-mismatch');
            }
            assertOwner(owner);
            const proof = await owner.composition.factory.restoreRetainedRecoverySnapshot(owner.entry, snapshot);
            assertOwner(owner);
            return proof;
        }
    });
}
