import {
    articleWorkspaceTabRouter,
    createArticleWorkspaceSessionPort
} from './articleWorkspaceTabRouter';
import { AuthoringSessionHost } from './authoringSessionHost';
import {
    createFsusUiEditorSessionFactory,
    type ArticleWorkspaceMountedEditorResolver,
    type ArticleWorkspaceFsusUiEditorSessionFactory,
    type ArticleWorkspaceEditorResourceSources,
    type ArticleWorkspaceOriginalDraftInspection,
    type ArticleWorkspaceEditorSnapshotPreparation,
    type ArticleWorkspaceSnapshotReferenceAdmission
} from './fsusUiEditorSessionFactory';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleWorkspaceNativeDocumentReservation } from './articleWorkspaceNativeDocumentAuthority';
import type {
    ArticleWorkspaceRetainedRecoveryCheckpoint,
    ArticleWorkspaceRetainedRecoveryPort,
    ArticleWorkspaceRetainedRecoverySnapshot,
    ArticleWorkspaceRetainedRecoverySource
} from './articleWorkspaceRetainedRecoverySnapshot';
import type { OpenArticleDocumentEntry } from './openArticleDocumentRegistry';
import type { MarkdownEditorSessionRestoreProof, MarkdownEditorSessionSnapshot } from '@ozwasyd/element-plus';

/** Original Root/Layout physical retained mount operation, never a ready receipt. */
export type ArticleWorkspaceMountedEditorPreparation = (entry: Readonly<OpenArticleDocumentEntry>) => Promise<void>;

/** Exact private installation admission only; not mounted/member/principal authority. */
export interface ArticleWorkspaceEditorSessionCompositionSeal {
    readonly scope: 'composition-admission';
}

let installed: {
    readonly resolveMountedEditor: ArticleWorkspaceMountedEditorResolver;
    readonly prepareMountedEditor: ArticleWorkspaceMountedEditorPreparation | undefined;
    readonly host: AuthoringSessionHost;
    readonly factory: ArticleWorkspaceFsusUiEditorSessionFactory;
    readonly assertActive: () => void;
    readonly hasInstallationCustody: () => boolean;
    readonly retire: () => void;
    readonly sealAdmission: () => ArticleWorkspaceEditorSessionCompositionSeal;
    readonly hasAdmissionCustody: (seal: ArticleWorkspaceEditorSessionCompositionSeal) => boolean;
    readonly cancelAdmission: (seal: ArticleWorkspaceEditorSessionCompositionSeal) => boolean;
} | null = null;

/**
 * Sole application composition entry. An actual mounted owner resolver is
 * mandatory; this function does not discover components or fabricate a session.
 * Current upstream gaps still reject admission through the original host.
 */
export function installArticleWorkspaceEditorSessions(
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver,
    prepareMountedEditor?: ArticleWorkspaceMountedEditorPreparation
): AuthoringSessionHost
{
    if (installed)
    {
        if (installed.resolveMountedEditor !== resolveMountedEditor
            || (prepareMountedEditor && installed.prepareMountedEditor !== prepareMountedEditor))
        {
            throw new Error('article-workspace-session-composition-already-installed');
        }
        installed.assertActive();
        return installed.host;
    }
    if (prepareMountedEditor !== undefined && typeof prepareMountedEditor !== 'function')
    {
        throw new Error('article-workspace-mounted-preparation-owner-unavailable');
    }

    let retired = false;
    let installationComplete = false;
    let sealingAdmission = false;
    let sealedAdmission: ArticleWorkspaceEditorSessionCompositionSeal | null = null;
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
        sealedAdmission = null;
        // Admission closes before native receiver callbacks; failed original
        // unsubscribe handles stay in the SAME factory for subsequent retries.
        factory.retireNativeDocumentAuthorities();
    };
    const sealAdmission = (): ArticleWorkspaceEditorSessionCompositionSeal =>
    {
        assertActive();
        if (!installationComplete || sealingAdmission)
        {
            throw new Error('article-workspace-session-composition-seal-unavailable');
        }
        sealingAdmission = true;
        try
        {
            const seal: ArticleWorkspaceEditorSessionCompositionSeal = Object.freeze({ scope: 'composition-admission' });
            // Allocation may retire the actual installation. Only private assignment follows this guard.
            assertActive();
            sealedAdmission = seal;
            return seal;
        }
        finally
        {
            sealingAdmission = false;
        }
    };
    const hasAdmissionCustody = (seal: ArticleWorkspaceEditorSessionCompositionSeal): boolean =>
        installationComplete && !retired && !sealingAdmission && sealedAdmission !== null && sealedAdmission === seal;
    const cancelAdmission = (seal: ArticleWorkspaceEditorSessionCompositionSeal): boolean =>
    {
        if (sealedAdmission === null || sealedAdmission !== seal)
        {
            return false;
        }
        sealedAdmission = null;
        return true;
    };
    const hasInstallationCustody = (): boolean => installationComplete && !retired;
    installed = { resolveMountedEditor, prepareMountedEditor, host, factory, assertActive, hasInstallationCustody, retire,
        sealAdmission, hasAdmissionCustody, cancelAdmission };
    try
    {
        const hostPort = createArticleWorkspaceSessionPort(host, {
            nextUsedTick: () =>
            {
                assertActive();
                return ++usedTick;
            }
        });
        articleWorkspaceTabRouter.setSessionPort(prepareMountedEditor
            ? {
                waitForReady: async (entry) =>
                {
                    assertActive();
                    const registry = articleWorkspaceTabRouter.getRegistry();
                    const sourceDigest = calculateOpenArticleDocumentDigest(entry);
                    const current = registry.getEntry(entry.tabId);
                    if (!current || calculateOpenArticleDocumentDigest(current) !== sourceDigest)
                    {
                        throw new Error('article-workspace-mounted-preparation-entry-stale');
                    }
                    // Borrow only the actual original entry metadata. The original
                    // mount owner supplies its handle/body/component/cancellation custody.
                    const target = Object.freeze(structuredClone(entry));
                    assertActive();
                    await prepareMountedEditor(target);
                    assertActive();
                    const prepared = registry.getEntry(entry.tabId);
                    if (articleWorkspaceTabRouter.getRegistry() !== registry || !prepared
                        || calculateOpenArticleDocumentDigest(prepared) !== sourceDigest
                        || calculateOpenArticleDocumentDigest(target) !== sourceDigest)
                    {
                        throw new Error('article-workspace-mounted-preparation-entry-stale');
                    }
                    assertActive();
                    // The SAME original bridge/factory reads the real native mount
                    // and resources. Completion of preparation grants no readiness.
                    return hostPort.waitForReady(prepared);
                }
            }
            : hostPort);
        installationComplete = true;
    }
    catch (error)
    {
        retire();
        throw error;
    }
    return host;
}

/** Stage actual required refs in the sole installed host; this never attaches or grants ready. */
export async function prepareArticleWorkspaceSnapshotReferenceAdmission(
    host: AuthoringSessionHost,
    entry: OpenArticleDocumentEntry,
    recoveryCheckpoint: ArticleWorkspaceRetainedRecoveryCheckpoint,
    draftStateRef: string,
    crashJournalRef: string
): Promise<ArticleWorkspaceSnapshotReferenceAdmission>
{
    const composition = installed;
    if (composition?.host !== host)
    {
        throw new Error('article-workspace-session-composition-owner-mismatch');
    }
    composition.assertActive();
    const original = await composition.factory.prepareSnapshotReferenceAdmission(
        entry, recoveryCheckpoint, draftStateRef, crashJournalRef);
    try
    {
        const hasOriginal = original.hasCustody.bind(original);
        const hasInstallation = composition.hasInstallationCustody;
        const hasCustody = (): boolean => installed === composition && hasInstallation()
            && hasOriginal() && hasInstallation() && installed === composition;
        const admission: ArticleWorkspaceSnapshotReferenceAdmission = Object.freeze({
            references: original.references, scope: original.scope,
            complete: original.complete, recoverable: original.recoverable,
            missingAuthorities: original.missingAuthorities, hasCustody,
            cancel: original.cancel.bind(original), inspectFailure: original.inspectFailure.bind(original)
        });
        // Allocation and all external reads finish before this final private installation/ref join.
        if (!hasCustody())
        {
            throw new Error('article-workspace-reference-admission-composition-retired');
        }
        return admission;
    }
    catch (cause)
    {
        try
        {
            original.cancel();
        }
        catch
        {
            // The SAME factory retains failed original cleanup for retirement retry.
        }
        throw cause;
    }
}

/** Cleanup inspection stays available after retirement; it grants no refset/resource authority. */
export function inspectArticleWorkspaceSnapshotReferenceCleanup()
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    return installed.factory.inspectSnapshotReferenceCleanup();
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

/** Borrow only the installed native document authority; no joint Root/host admission. */
export function reserveArticleWorkspaceNativeDocumentAuthority(
    entry: OpenArticleDocumentEntry,
    revokeBeforeChange: () => void
): ArticleWorkspaceNativeDocumentReservation | null
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.reserveNativeDocumentAuthority(entry, revokeBeforeChange);
}

/** Failed native subscriptions remain visible after retirement, never replaced by a new issuer. */
export function inspectArticleWorkspaceNativeDocumentCleanup()
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    return installed.factory.inspectNativeDocumentCleanup();
}

/** Seal only the same original successful installation's private admission. */
export function sealArticleWorkspaceEditorSessionComposition(
    host: AuthoringSessionHost
): ArticleWorkspaceEditorSessionCompositionSeal
{
    if (installed?.host !== host)
    {
        throw new Error('article-workspace-session-composition-owner-mismatch');
    }
    return installed.sealAdmission();
}

/** Pure original private continuity; never calls resolver, registry, mount or auth readers. */
export function hasArticleWorkspaceEditorSessionCompositionCustody(
    seal: ArticleWorkspaceEditorSessionCompositionSeal
): boolean
{
    return installed?.hasAdmissionCustody(seal) ?? false;
}

/** Cancel only the exact bounded private seal; no owner cleanup or resource acknowledgment. */
export function cancelArticleWorkspaceEditorSessionCompositionSeal(
    seal: ArticleWorkspaceEditorSessionCompositionSeal
): boolean
{
    return installed?.cancelAdmission(seal) ?? false;
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

/** Correlate an already issued original draft reference with actual native bytes; no capture/restore/ready grant. */
export function inspectArticleWorkspaceOriginalDraftCheckpoint(
    entry: OpenArticleDocumentEntry,
    reference: string
): ArticleWorkspaceOriginalDraftInspection
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.inspectOriginalDraftCheckpoint(entry, reference);
}

/** Prepare through the same actual native owner; commit/discard retain genuine original custody. */
export function prepareArticleWorkspaceRetainedEditorSnapshot(
    entry: OpenArticleDocumentEntry
): ArticleWorkspaceEditorSnapshotPreparation
{
    if (!installed)
    {
        throw new Error('article-workspace-session-composition-not-installed');
    }
    installed.assertActive();
    return installed.factory.prepareRetainedSnapshot(entry);
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
