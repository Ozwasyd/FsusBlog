import { articleRecoveryIdentityHash } from '../articleRecoveryJournal';

import { createArticleWorkspaceNativeDocumentAuthorityConsumer } from './articleWorkspaceNativeDocumentAuthority';
import {
    calculateRetainedRecoveryRefsDigest,
    type ArticleWorkspaceRetainedRecoveryCheckpoint,
    type ArticleWorkspaceRetainedRecoverySnapshot
} from './articleWorkspaceRetainedRecoverySnapshot';
import {
    authoringSessionSnapshotSchema,
    sealAuthoringSessionSnapshot,
    verifyAuthoringSessionSnapshot,
    type AuthoringSessionSnapshotRefs,
    type AuthoringSessionSnapshotContext,
    type FsusUiPublicEditorSession,
    type FsusUiPublicEditorSessionFactory
} from './authoringSessionHost';
import {
    calculateOpenArticleDocumentDigest,
    type ArticleDocumentContextRef,
    type ArticleDocumentIdentity,
    type OpenArticleDocumentEntry
} from './openArticleDocumentRegistry';

import type { useAdminArticleWrite } from '../../composables/useAdminArticleWrite';
import type { ArticleRecoveryJournalCheckpointInfo, ArticleRecoveryJournalCheckpointReferenceBinding } from '../articleRecoveryJournal';
import type { ArticleWorkspaceNativeDocumentReservation } from './articleWorkspaceNativeDocumentAuthority';
import type { AuthoringWorkspaceRootMountedSeal } from './authoringWorkspaceLayoutContext';
import type {
    MarkdownEditorSession,
    MarkdownEditorSessionAttachmentResourceSource,
    MarkdownEditorSessionExpose,
    MarkdownEditorSessionLastValidRender,
    MarkdownEditorSessionRenderRestoreProof,
    MarkdownEditorSessionRestoreProof,
    MarkdownEditorSessionRendererResourceSource,
    MarkdownEditorSessionSnapshot,
    MarkdownRendererCheckpointHandle,
    MarkdownRendererCheckpointPreparation
} from '@ozwasyd/element-plus';

/** Supplied by the existing mounted editor/document owner, never route discovery. */
export interface ArticleWorkspaceMountedEditorBinding {
    readonly editor: MarkdownEditorSessionExpose;
    readonly identity: ArticleDocumentIdentity;
    readonly documentContext: ArticleDocumentContextRef;
    readonly editorRevision: number;
    readonly draftCheckpoint?: ArticleWorkspaceOriginalDraftCheckpoint | null;
    readonly mountedAuthority?: ArticleWorkspaceMountedAuthority | null;
}

/** Borrow the existing Root issuer's token and pure join; no new seal or cancellation ownership. */
export interface ArticleWorkspaceMountedAuthority {
    readonly editorSessionRef: string;
    readonly nativeEditor: MarkdownEditorSessionExpose;
    readonly seal: AuthoringWorkspaceRootMountedSeal;
    hasCustody(): boolean;
}

export type ArticleWorkspaceMountedEditorResolver = (
    entry: OpenArticleDocumentEntry
) => ArticleWorkspaceMountedEditorBinding | null;

/** Observations from original owners; never a ready/paused receipt or aggregate. */
export interface ArticleWorkspaceEditorResourceSources {
    readonly census: ReturnType<MarkdownEditorSession['inspectResourceParticipants']>;
    readonly renderer: MarkdownEditorSessionRendererResourceSource | null;
    readonly attachment: MarkdownEditorSessionAttachmentResourceSource | null;
}

/** Borrow the actual original Writer runtime; no form/body/history/custody store here. */
export type ArticleWorkspaceOriginalDraftCheckpoint = ReturnType<typeof useAdminArticleWrite>['authoringDraftCheckpointRuntime'];

export interface ArticleWorkspaceOriginalDraftInspection {
    readonly info: NonNullable<ReturnType<ArticleWorkspaceOriginalDraftCheckpoint['inspectDraftReference']>>;
    readonly editorContentDigest: string;
}

/** Original native custody only; this capability does not certify the complete application join. */
export interface ArticleWorkspaceSealedNativeSnapshotPublication {
    readonly snapshot: MarkdownEditorSessionSnapshot;
    readonly scope: 'native-owner-custody';
    hasNativeCustody(): boolean;
    /** Same actual published native pointer/generation only; not full-ref/resource authority. */
    hasPublishedNativeCustody(): boolean;
    publishNative(): MarkdownEditorSessionSnapshot | null;
    cancelNative(): boolean;
}

/** Genuine native candidate operation; no full-host, draft/journal or resource admission. */
export interface ArticleWorkspaceEditorSnapshotPreparation {
    readonly snapshot: MarkdownEditorSessionSnapshot;
    sealNative(): ArticleWorkspaceSealedNativeSnapshotPublication;
    commit(): MarkdownEditorSessionSnapshot;
    discard(): boolean;
}

/** Original ref custody only. Root/Renderer/resource admission is still required by the host. */
export interface ArticleWorkspaceSnapshotReferenceAdmission {
    readonly references: Readonly<AuthoringSessionSnapshotRefs>;
    readonly scope: 'native-renderer-root-draft-journal-reference-custody';
    readonly rendererCheckpointRef: string;
    readonly rootMountedSeal: AuthoringWorkspaceRootMountedSeal;
    readonly complete: false;
    readonly recoverable: false;
    readonly missingAuthorities: readonly string[];
    /** Original private queries only; no resolver, inspect, isCurrent, clock or acquisition. */
    hasCustody(): boolean;
    /** False preserves unfinished original cleanup; no disposal acknowledgement. */
    cancel(): boolean;
    inspectFailure(): Readonly<{ failed: boolean; firstCause: unknown; latestCause: unknown; }>;
}

interface SnapshotReferenceAttempt {
    active: boolean;
    preparing: boolean;
    canceling: boolean;
    failed: boolean;
    firstCause: unknown;
    latestCause: unknown;
    nativePreparation: ArticleWorkspaceEditorSnapshotPreparation | null;
    nativeReservation: ArticleWorkspaceNativeDocumentReservation | null;
    rendererHandle: MarkdownRendererCheckpointHandle | null;
    rendererPreparation: MarkdownRendererCheckpointPreparation | null;
}

export interface ArticleWorkspaceFsusUiEditorSessionFactory extends FsusUiPublicEditorSessionFactory {
    prepareSnapshotReferenceAdmission(entry: OpenArticleDocumentEntry, recoveryCheckpoint: ArticleWorkspaceRetainedRecoveryCheckpoint,
        draftStateRef: string, crashJournalRef: string): Promise<ArticleWorkspaceSnapshotReferenceAdmission>;
    inspectSnapshotReferenceCleanup(): Readonly<{ pending: boolean; failed: boolean; firstCause: unknown; latestCause: unknown; }>;
    reserveNativeDocumentAuthority(entry: OpenArticleDocumentEntry, revokeBeforeChange: () => void): ArticleWorkspaceNativeDocumentReservation | null;
    retireNativeDocumentAuthorities(): void;
    inspectNativeDocumentCleanup(): ReturnType<ReturnType<typeof createArticleWorkspaceNativeDocumentAuthorityConsumer>['inspectCleanupCustody']>;
    prepareRetainedSnapshot(entry: OpenArticleDocumentEntry): ArticleWorkspaceEditorSnapshotPreparation;
    inspectOriginalDraftCheckpoint(entry: OpenArticleDocumentEntry, reference: string): ArticleWorkspaceOriginalDraftInspection;
    inspectResourceSources(entry: OpenArticleDocumentEntry): ArticleWorkspaceEditorResourceSources;
    captureRetainedSnapshot(entry: OpenArticleDocumentEntry): MarkdownEditorSessionSnapshot;
    restoreRetainedSnapshot(entry: OpenArticleDocumentEntry, snapshot: MarkdownEditorSessionSnapshot): MarkdownEditorSessionRestoreProof;
    captureRetainedRecoverySnapshot(entry: OpenArticleDocumentEntry, recoveryCheckpoint: ArticleWorkspaceRetainedRecoveryCheckpoint, checkpointRef: string): ArticleWorkspaceRetainedRecoverySnapshot;
    restoreRetainedRecoverySnapshot(entry: OpenArticleDocumentEntry, snapshot: ArticleWorkspaceRetainedRecoverySnapshot): Promise<MarkdownEditorSessionRestoreProof>;
    captureLastValidRender(entry: OpenArticleDocumentEntry): MarkdownEditorSessionLastValidRender | null;
    restoreLastValidRender(entry: OpenArticleDocumentEntry, render: MarkdownEditorSessionLastValidRender): Promise<MarkdownEditorSessionRenderRestoreProof>;
}

function assertBinding(
    binding: ArticleWorkspaceMountedEditorBinding,
    identity: ArticleDocumentIdentity,
    context: ArticleDocumentContextRef
): void
{
    if (binding.identity.articleId !== identity.articleId
        || binding.identity.draftId !== identity.draftId
        || binding.identity.documentId !== identity.documentId)
    {
        throw new Error('public-editor-document-identity-mismatch');
    }
    if (binding.documentContext.documentEpoch !== context.documentEpoch)
    {
        throw new Error('public-editor-document-epoch-mismatch');
    }
    if (binding.documentContext.sourceRevision !== context.sourceRevision
        || binding.documentContext.draftRevision !== context.draftRevision)
    {
        throw new Error('public-editor-source-revision-mismatch');
    }
}

/**
 * Uses the real public FsusUI session, with no body/history store or session index.
 * The retained upstream API currently cannot issue the complete #2294 snapshot.
 */
export function createFsusUiEditorSessionFactory(
    resolveMountedEditor: ArticleWorkspaceMountedEditorResolver,
    assertAdmission: () => void
): ArticleWorkspaceFsusUiEditorSessionFactory
{
    const nativeDocumentAuthority = createArticleWorkspaceNativeDocumentAuthorityConsumer();
    // One pending operation beside the original native candidate, never an article/session index.
    let referenceAttempt: SnapshotReferenceAttempt | null = null;
    let referenceAdmissionRetired = false;
    const recordReferenceFailure = (attempt: SnapshotReferenceAttempt, cause: unknown): void =>
    {
        if (!attempt.failed)
        {
            attempt.firstCause = cause;
        }
        attempt.failed = true;
        attempt.latestCause = cause;
    };
    const cancelReferenceAttempt = (attempt: SnapshotReferenceAttempt): boolean =>
    {
        attempt.active = false;
        if (attempt.preparing || attempt.canceling)
        {
            return false;
        }
        attempt.canceling = true;
        let failed = false;
        let firstCause: unknown;
        try
        {
            try
            {
                const handle = attempt.rendererHandle;
                const preparation = attempt.rendererPreparation;
                if (handle && preparation
                    && handle.cancelPreparedRendererOwnedCheckpoint(preparation) !== true)
                {
                    throw new Error('public-editor-reference-renderer-cancellation-not-confirmed');
                }
                attempt.rendererPreparation = null;
                attempt.rendererHandle = null;
            }
            catch (cause)
            {
                failed = true;
                firstCause = cause;
                recordReferenceFailure(attempt, cause);
            }
            try
            {
                attempt.nativePreparation?.discard();
                attempt.nativePreparation = null;
            }
            catch (cause)
            {
                if (!failed)
                {
                    firstCause = cause;
                }
                failed = true;
                recordReferenceFailure(attempt, cause);
            }
            try
            {
                const reservation = attempt.nativeReservation;
                if (reservation)
                {
                    reservation.cancel();
                    if (!reservation.hasCleanupCustody())
                    {
                        attempt.nativeReservation = null;
                    }
                }
            }
            catch (cause)
            {
                if (!failed)
                {
                    firstCause = cause;
                }
                failed = true;
                recordReferenceFailure(attempt, cause);
            }
            if (!attempt.rendererPreparation && !attempt.nativePreparation && !attempt.nativeReservation && referenceAttempt === attempt)
            {
                referenceAttempt = null;
            }
            if (failed)
            {
                throw firstCause;
            }
            return !attempt.rendererPreparation && !attempt.nativePreparation && !attempt.nativeReservation;
        }
        finally
        {
            attempt.canceling = false;
        }
    };
    function resolveSession(entry: OpenArticleDocumentEntry): {
        binding: ArticleWorkspaceMountedEditorBinding;
        session: MarkdownEditorSession;
    }
    {
        assertAdmission();
        const binding = resolveMountedEditor(entry);
        if (!binding)
        {
            throw new Error('public-editor-mounted-owner-unavailable');
        }
        assertBinding(binding, entry.identity, entry.documentContext);
        const session = binding.editor.getSession(entry.editorSessionRef);
        if (session.editorSessionRef !== entry.editorSessionRef)
        {
            throw new Error('public-editor-session-ref-mismatch');
        }
        const document = session.inspectDocumentState();
        if (document.documentIdentity.id !== binding.identity.documentId
            || document.documentIdentity.epoch !== binding.documentContext.documentEpoch
            || document.revision !== binding.editorRevision)
        {
            throw new Error('public-editor-mounted-document-owner-mismatch');
        }
        assertAdmission();
        return { binding, session };
    }

    function assertCurrent(
        entry: OpenArticleDocumentEntry,
        session: MarkdownEditorSession,
        context: AuthoringSessionSnapshotContext
    ): void
    {
        if (context.editorSessionRef !== session.editorSessionRef)
        {
            throw new Error('public-editor-session-ref-mismatch');
        }
        const current = resolveSession(entry);
        if (current.session !== session)
        {
            throw new Error('public-editor-session-owner-replaced');
        }
        assertBinding(current.binding, context.identity, context.documentContext);
        if (context.permission !== entry.status.permission
            || context.permissionRef !== entry.status.statusRef)
        {
            throw new Error('public-editor-permission-context-mismatch');
        }
    }

    function assertRecoveryReference(
        entry: OpenArticleDocumentEntry,
        binding: ArticleWorkspaceMountedEditorBinding,
        inspectReference: ArticleRecoveryJournalCheckpointReferenceBinding['inspectReference'],
        checkpointRef: string
    ): ArticleRecoveryJournalCheckpointInfo
    {
        const info = inspectReference(checkpointRef);
        if (info?.checkpointRef !== checkpointRef
            || info.editorSessionRef !== entry.editorSessionRef
            || info.articleId !== binding.identity.articleId
            || info.draftId !== binding.identity.draftId
            || info.documentId !== binding.identity.documentId
            || info.documentEpoch !== binding.documentContext.documentEpoch
            || info.editorRevision !== binding.editorRevision
            || info.sourceRevision !== binding.documentContext.sourceRevision
            || info.draftRevision !== binding.documentContext.draftRevision
            || info.associationRevision !== entry.lifecycleRevision)
        {
            throw new Error('public-editor-recovery-reference-owner-mismatch');
        }
        assertAdmission();
        return info;
    }

    const prepareRetainedSnapshot = (entry: OpenArticleDocumentEntry): ArticleWorkspaceEditorSnapshotPreparation =>
    {
        const { binding, session } = resolveSession(entry);
        const identity = Object.freeze({ ...binding.identity });
        const context = Object.freeze({ ...binding.documentContext });
        const revision = binding.editorRevision;
        const editor = binding.editor;
        const prepareNative = session.prepareSnapshot.bind(session);
        const commitNative = session.commitPreparedSnapshot.bind(session);
        const sealNative = session.sealPreparedSnapshot.bind(session);
        const hasNative = session.hasSealedSnapshotCustody.bind(session);
        const hasPublishedNative = session.hasRetainedSnapshotCustody.bind(session);
        const publishNative = session.publishSealedSnapshot.bind(session);
        const discardNative = session.discardPreparedSnapshot.bind(session);
        const assertOwner = (): void =>
        {
            const current = resolveSession(entry);
            assertBinding(current.binding, identity, context);
            if (current.session !== session || current.binding.editor !== editor || current.binding.editorRevision !== revision)
            {
                throw new Error('public-editor-retained-snapshot-stale');
            }
            assertAdmission();
        };
        const preparation = prepareNative(calculateOpenArticleDocumentDigest, {
            documentIdentity: { id: identity.documentId, epoch: context.documentEpoch }, revision, assertAdmission: assertOwner
        });
        try
        {
            // This read can still fail safely: the original native token has not changed.
            assertOwner();
        }
        catch (error)
        {
            discardNative(preparation);
            throw error;
        }
        let state: 'prepared' | 'committing' | 'sealed' | 'done' = 'prepared';
        let published = false;
        return Object.freeze({
            snapshot: preparation.snapshot,
            sealNative: () =>
            {
                if (state !== 'prepared')
                {
                    throw new Error('public-editor-snapshot-preparation-consumed');
                }
                state = 'committing';
                let publication: ReturnType<typeof sealNative> | undefined;
                try
                {
                    // Allocate the complete operation before the final native/owner callbacks.
                    const reserved: ArticleWorkspaceSealedNativeSnapshotPublication = Object.freeze({
                        snapshot: preparation.snapshot,
                        scope: 'native-owner-custody',
                        hasNativeCustody: () => state === 'sealed' && publication !== undefined && hasNative(publication),
                        hasPublishedNativeCustody: () => published && hasPublishedNative(preparation.snapshot),
                        publishNative: () =>
                        {
                            if (state !== 'sealed' || publication === undefined)
                            {
                                return null;
                            }
                            const snapshot = publishNative(publication);
                            if (snapshot)
                            {
                                published = snapshot === preparation.snapshot;
                                state = 'done';
                            }
                            return snapshot;
                        },
                        cancelNative: () =>
                        {
                            if (state === 'done')
                            {
                                return false;
                            }
                            const canceled = discardNative(preparation);
                            state = 'done';
                            return canceled;
                        }
                    });
                    publication = sealNative(preparation, assertOwner);
                    state = 'sealed';
                    return reserved;
                }
                finally
                {
                    if (state === 'committing')
                    {
                        discardNative(preparation);
                        state = 'done';
                    }
                }
            },
            commit: () =>
            {
                if (state !== 'prepared')
                {
                    throw new Error('public-editor-snapshot-preparation-consumed');
                }
                state = 'committing';
                try
                {
                    const snapshot = commitNative(preparation, assertOwner);
                    // No additional external owner reader or fallible operation after publication.
                    state = 'done';
                    return snapshot;
                }
                finally
                {
                    if (state === 'committing')
                    {
                        discardNative(preparation);
                        state = 'done';
                    }
                }
            },
            discard: () =>
            {
                if (state === 'done')
                {
                    return false;
                }
                const discarded = discardNative(preparation);
                state = 'done';
                return discarded;
            }
        });
    };

    const factory: ArticleWorkspaceFsusUiEditorSessionFactory = {
        async prepareSnapshotReferenceAdmission(entry, recoveryCheckpoint, draftStateRef, crashJournalRef)
        {
            assertAdmission();
            if (referenceAdmissionRetired || referenceAttempt)
            {
                throw new Error('public-editor-reference-admission-pending-or-retired');
            }
            const attempt: SnapshotReferenceAttempt = { active: true, preparing: true, canceling: false,
                failed: false, firstCause: undefined, latestCause: undefined,
                nativePreparation: null, nativeReservation: null, rendererHandle: null, rendererPreparation: null };
            referenceAttempt = attempt;
            try
            {
                const { binding, session } = resolveSession(entry);
                const draft = binding.draftCheckpoint;
                const rootAuthority = binding.mountedAuthority;
                if (rootAuthority?.nativeEditor !== binding.editor
                    || rootAuthority.editorSessionRef !== entry.editorSessionRef)
                {
                    throw new Error('public-editor-reference-root-mounted-authority-unavailable');
                }
                const hasRoot = rootAuthority.hasCustody.bind(rootAuthority);
                if (!draft || entry.status.permission !== 'allowed' || entry.status.lifecycle !== 'current')
                {
                    throw new Error('public-editor-reference-draft-owner-unavailable');
                }
                const identity = Object.freeze({ ...binding.identity });
                const context = Object.freeze({ ...binding.documentContext });
                const revision = binding.editorRevision;
                const editor = binding.editor;
                const entryDigest = calculateOpenArticleDocumentDigest(entry);
                const inspectJournal = recoveryCheckpoint.inspectReference.bind(recoveryCheckpoint);
                const validateJournal = recoveryCheckpoint.validateReference.bind(recoveryCheckpoint);
                const hasJournal = recoveryCheckpoint.hasReferenceCustody.bind(recoveryCheckpoint);
                const inspectDraft = draft.inspectDraftReference.bind(draft);
                const hasDraft = draft.hasDraftReferenceCustody.bind(draft);
                const assertOwner = (): void =>
                {
                    assertAdmission();
                    const current = resolveSession(entry);
                    assertBinding(current.binding, identity, context);
                    if (referenceAttempt !== attempt || !attempt.active || referenceAdmissionRetired
                        || current.session !== session || current.binding.editor !== editor
                        || current.binding.editorRevision !== revision || current.binding.draftCheckpoint !== draft
                        || current.binding.mountedAuthority !== rootAuthority
                        || calculateOpenArticleDocumentDigest(entry) !== entryDigest)
                    {
                        throw new Error('public-editor-reference-admission-owner-stale');
                    }
                    assertAdmission();
                };
                // Register actual Native pre-retirement before callbacks/awaits. This receiver
                // only withdraws private publication; it never inspects or cancels an issuer.
                attempt.nativeReservation = factory.reserveNativeDocumentAuthority(entry, () =>
                {
                    attempt.active = false;
                });
                if (!attempt.nativeReservation)
                {
                    throw new Error('public-editor-reference-native-authority-unavailable');
                }
                const rendererHandle = session.getRendererCheckpointHandle();
                if (!rendererHandle)
                {
                    throw new Error('public-editor-reference-full-renderer-checkpoint-handle-unavailable');
                }
                attempt.rendererHandle = rendererHandle;
                const prepareRenderer = rendererHandle.prepareRendererOwnedCheckpoint.bind(rendererHandle);
                const sealRenderer = rendererHandle.sealPreparedRendererOwnedCheckpoint.bind(rendererHandle);
                const hasRenderer = rendererHandle.hasSealedRendererOwnedCheckpointCustody.bind(rendererHandle);
                const draftObservation = factory.inspectOriginalDraftCheckpoint(entry, draftStateRef);
                const draftInfo = draftObservation.info;
                const journalInfo = assertRecoveryReference(entry, binding, inspectJournal, crashJournalRef);
                const identityHash = await articleRecoveryIdentityHash(draftInfo.principalIdentityId);
                assertOwner();
                if (journalInfo.identityHash !== identityHash || journalInfo.siteScope !== draftInfo.siteScope
                    || journalInfo.draftKey !== draftInfo.draftKey)
                {
                    throw new Error('public-editor-reference-journal-principal-mismatch');
                }
                const content = session.inspectContentDigest((source) =>
                {
                    if (!validateJournal(crashJournalRef, source))
                    {
                        throw new Error('public-editor-reference-journal-content-mismatch');
                    }
                    return calculateOpenArticleDocumentDigest(source);
                }, { documentIdentity: { id: identity.documentId, epoch: context.documentEpoch }, revision,
                    assertAdmission: assertOwner });
                if (content.editorContentDigest !== draftObservation.editorContentDigest)
                {
                    throw new Error('public-editor-reference-draft-content-mismatch');
                }
                attempt.nativePreparation = factory.prepareRetainedSnapshot(entry);
                const preparation = attempt.nativePreparation;
                const native = preparation.snapshot;
                const panels = native.panelRefs;
                const render = native.lastValidRender;
                if (!panels?.attachmentStateRef || !render)
                {
                    throw new Error('public-editor-reference-required-native-refs-unavailable');
                }
                const references = sealAuthoringSessionSnapshot({
                    schema: authoringSessionSnapshotSchema, snapshotRef: native.snapshotRef,
                    identity, editorSessionRef: native.editorSessionRef, documentContext: context,
                    permission: entry.status.permission, permissionRef: entry.status.statusRef,
                    selectionRef: native.selectionRef, selectionDirection: native.selection.direction,
                    historyRef: native.historyRef, activeNodeRef: panels.activeNodeRef,
                    scrollAnchorRef: panels.scrollAnchorRef, outlineRef: panels.outlineRef,
                    searchRef: panels.searchRef, attachmentStateRef: panels.attachmentStateRef,
                    lastValidRenderRef: render.ref, draftStateRef: draftInfo.draftStateRef,
                    crashJournalRef: journalInfo.checkpointRef, editorContentDigest: native.editorContentDigest
                });
                Object.freeze(references.identity);
                Object.freeze(references.documentContext);
                Object.freeze(references);
                if (!verifyAuthoringSessionSnapshot(references) || native.editorContentDigest !== content.editorContentDigest)
                {
                    throw new Error('public-editor-reference-set-invalid');
                }
                const publication = preparation.sealNative();
                // Native seal admission completes its renderer/view reads BEFORE acquiring the
                // exact Renderer checkpoint seal. Hold this same handle/preparation across all phases.
                attempt.rendererPreparation = prepareRenderer();
                const rendererPreparation = attempt.rendererPreparation;
                if (!rendererPreparation)
                {
                    throw new Error('public-editor-reference-renderer-checkpoint-prepare-refused');
                }
                const checkpoint = rendererPreparation.checkpoint;
                if (checkpoint.documentIdentity.id !== native.documentIdentity.id
                    || checkpoint.documentIdentity.epoch !== native.documentIdentity.epoch
                    || checkpoint.revision !== native.revision || checkpoint.lastValidRenderRef !== render.ref)
                {
                    throw new Error('public-editor-reference-renderer-checkpoint-owner-mismatch');
                }
                const rendererPublication = sealRenderer(rendererPreparation);
                if (!rendererPublication)
                {
                    throw new Error('public-editor-reference-renderer-checkpoint-seal-refused');
                }
                const hasNative = publication.hasNativeCustody.bind(publication);
                const nativeReservation = attempt.nativeReservation;
                const hasNativeDocument = nativeReservation.hasCustody.bind(nativeReservation);
                const privateCurrent = (): boolean => referenceAttempt === attempt && attempt.active
                    && !attempt.preparing && !attempt.canceling && !attempt.failed && !referenceAdmissionRetired;
                const hasCustody = (): boolean => privateCurrent() && hasRoot() && hasNative() && hasRenderer(rendererPublication) && hasNativeDocument()
                    && hasDraft(draftStateRef, draftInfo) && hasJournal(crashJournalRef, journalInfo)
                    && hasNative() && hasRenderer(rendererPublication) && hasNativeDocument() && hasRoot() && privateCurrent();
                const admission: ArticleWorkspaceSnapshotReferenceAdmission = Object.freeze({
                    references, rendererCheckpointRef: checkpoint.ref, rootMountedSeal: rootAuthority.seal,
                    scope: 'native-renderer-root-draft-journal-reference-custody', complete: false, recoverable: false,
                    missingAuthorities: Object.freeze([
                        'session:complete-resource-and-disposed-restoration-authority'
                    ]),
                    hasCustody, cancel: () => cancelReferenceAttempt(attempt),
                    inspectFailure: () => Object.freeze({ failed: attempt.failed,
                        firstCause: attempt.firstCause, latestCause: attempt.latestCause })
                });
                // These original inspectors may invalidate. Finish them before the final
                // private join, and never call them from hasCustody or the retirement receiver.
                if (session.getRendererCheckpointHandle() !== rendererHandle || inspectDraft(draftStateRef) !== draftInfo
                    || assertRecoveryReference(entry, binding, inspectJournal, crashJournalRef) !== journalInfo)
                {
                    throw new Error('public-editor-reference-original-custody-revoked');
                }
                assertOwner();
                attempt.preparing = false;
                if (!hasCustody())
                {
                    throw new Error('public-editor-reference-final-custody-revoked');
                }
                return admission;
            }
            catch (cause)
            {
                recordReferenceFailure(attempt, cause);
                attempt.preparing = false;
                try
                {
                    cancelReferenceAttempt(attempt);
                }
                catch
                {
                    // Keep both the original acquisition cause and actual cleanup debt.
                }
                throw cause;
            }
        },
        inspectSnapshotReferenceCleanup: () => Object.freeze({ pending: referenceAttempt !== null,
            failed: referenceAttempt?.failed ?? false, firstCause: referenceAttempt?.firstCause,
            latestCause: referenceAttempt?.latestCause }),
        reserveNativeDocumentAuthority(entry, revokeBeforeChange)
        {
            const { binding, session } = resolveSession(entry);
            const editor = binding.editor;
            const identity = Object.freeze({ ...binding.identity });
            const context = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const assertOwner = (): void =>
            {
                const current = resolveSession(entry);
                assertBinding(current.binding, identity, context);
                if (current.session !== session || current.binding.editor !== editor
                    || current.binding.editorRevision !== revision)
                {
                    throw new Error('public-editor-native-document-owner-stale');
                }
                assertAdmission();
            };
            return nativeDocumentAuthority.reserve(editor, session,
                { documentKey: identity.documentId, documentEpoch: context.documentEpoch, revision },
                revokeBeforeChange, assertOwner);
        },
        retireNativeDocumentAuthorities: () =>
        {
            referenceAdmissionRetired = true;
            let failed = false;
            let firstCause: unknown;
            try
            {
                if (referenceAttempt && !cancelReferenceAttempt(referenceAttempt))
                {
                    throw new Error('public-editor-reference-cleanup-pending');
                }
            }
            catch (cause)
            {
                failed = true;
                firstCause = cause;
            }
            try
            {
                nativeDocumentAuthority.retire();
            }
            catch (cause)
            {
                if (!failed)
                {
                    firstCause = cause;
                }
                failed = true;
            }
            if (failed)
            {
                throw firstCause;
            }
        },
        inspectNativeDocumentCleanup: () => nativeDocumentAuthority.inspectCleanupCustody(),
        inspectOriginalDraftCheckpoint(entry, reference)
        {
            const { binding, session } = resolveSession(entry);
            const draft = binding.draftCheckpoint;
            if (!draft)
            {
                throw new Error('public-editor-original-mounted-draft-owner-unavailable');
            }
            const inspect = draft.inspectDraftReference.bind(draft);
            const validate = draft.validateDraftReference.bind(draft);
            const hasCustody = draft.hasDraftReferenceCustody.bind(draft);
            const identity = Object.freeze({ ...binding.identity });
            const context = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const editor = binding.editor;
            const info = inspect(reference);
            if (!info || entry.status.permission !== 'allowed' || entry.status.lifecycle !== 'current'
                || info.editorSessionRef !== entry.editorSessionRef || info.documentContext.articleId !== identity.articleId
                || info.documentContext.draftId !== identity.draftId || info.documentContext.documentId !== identity.documentId
                || info.documentContext.documentEpoch !== context.documentEpoch || info.nativeRevision !== revision
                || info.documentContext.sourceRevision !== revision || info.associationRevision !== entry.lifecycleRevision
                || info.documentContext.draftRevision !== context.draftRevision
                || context.sourceRevision !== `source-revision:${revision}`)
            {
                throw new Error('public-editor-original-draft-owner-mismatch');
            }
            const assertOwner = (): void =>
            {
                if (inspect(reference) !== info)
                {
                    throw new Error('public-editor-original-draft-custody-revoked');
                }
                // Final actual mounted authority follows original draft readers.
                const current = resolveSession(entry);
                assertBinding(current.binding, identity, context);
                if (current.session !== session || current.binding.editor !== editor || current.binding.editorRevision !== revision
                    || current.binding.draftCheckpoint !== draft
                    || !hasCustody(reference, info))
                {
                    throw new Error('public-editor-original-draft-owner-stale');
                }
                assertAdmission();
            };
            const content = session.inspectContentDigest((source) =>
            {
                if (!validate(reference, source))
                {
                    throw new Error('public-editor-original-draft-content-mismatch');
                }
                return calculateOpenArticleDocumentDigest(source);
            }, { documentIdentity: Object.freeze({ id: identity.documentId, epoch: context.documentEpoch }), revision, assertAdmission: assertOwner });
            assertOwner();
            return Object.freeze({ info, editorContentDigest: content.editorContentDigest });
        },
        captureRetainedRecoverySnapshot(entry, recoveryCheckpoint, checkpointRef)
        {
            const inspectReference = recoveryCheckpoint.inspectReference.bind(recoveryCheckpoint);
            const hasReferenceCustody = recoveryCheckpoint.hasReferenceCustody.bind(recoveryCheckpoint);
            const captureNative = recoveryCheckpoint.captureRetainedSnapshot.bind(recoveryCheckpoint);
            const { binding, session } = resolveSession(entry);
            const identity = Object.freeze({ ...binding.identity });
            const documentContext = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const editor = binding.editor;
            const assertOwner = (): void =>
            {
                // Reference/source readers can revoke the mounted resolver. Finish THEM first.
                const info = assertRecoveryReference(entry, binding, inspectReference, checkpointRef);
                const current = resolveSession(entry);
                assertBinding(current.binding, identity, documentContext);
                if (current.session !== session || current.binding.editor !== editor
                    || current.binding.editorRevision !== revision)
                {
                    throw new Error('public-editor-recovery-snapshot-owner-stale');
                }
                // Resolve can in turn revoke issuer custody. This ORIGINAL private check has no callbacks.
                if (!hasReferenceCustody(checkpointRef, info))
                {
                    throw new Error('public-editor-recovery-reference-custody-revoked');
                }
                assertAdmission();
            };
            assertOwner();
            // Original Writer supplies expected native context and validates the actual body
            // inside its genuine native digest callback. Do not create a second binding/producer.
            const nativeSnapshot = captureNative(checkpointRef, assertOwner);
            assertOwner();
            if (nativeSnapshot.editorSessionRef !== entry.editorSessionRef
                || nativeSnapshot.documentIdentity.id !== identity.documentId
                || nativeSnapshot.documentIdentity.epoch !== documentContext.documentEpoch
                || nativeSnapshot.revision !== revision)
            {
                throw new Error('public-editor-recovery-snapshot-context-mismatch');
            }
            if (!session.validateRetainedSnapshot(nativeSnapshot, {
                documentIdentity: { id: identity.documentId, epoch: documentContext.documentEpoch }, revision
            }))
            {
                throw new Error('public-editor-recovery-native-custody-mismatch');
            }
            assertOwner();
            const refs = {
                schema: 'fsusblog.article-workspace-retained-recovery.v1' as const,
                identity,
                documentContext,
                nativeSnapshot,
                recoveryCheckpoint,
                crashJournalRef: checkpointRef
            };
            return Object.freeze({ ...refs, refsDigest: calculateRetainedRecoveryRefsDigest(refs) });
        },
        async restoreRetainedRecoverySnapshot(entry, snapshot)
        {
            // Read caller-held getters ONCE before any original owner operation.
            const recoveryCheckpoint = snapshot.recoveryCheckpoint;
            const nativeSnapshot = snapshot.nativeSnapshot;
            const inputIdentity = snapshot.identity;
            const inputContext = snapshot.documentContext;
            const pinned = Object.freeze({
                schema: snapshot.schema,
                identity: Object.freeze({ articleId: inputIdentity.articleId,
                    draftId: inputIdentity.draftId, documentId: inputIdentity.documentId }),
                documentContext: Object.freeze({ documentEpoch: inputContext.documentEpoch,
                    sourceRevision: inputContext.sourceRevision, draftRevision: inputContext.draftRevision }),
                nativeSnapshot,
                recoveryCheckpoint,
                crashJournalRef: snapshot.crashJournalRef,
                refsDigest: snapshot.refsDigest
            });
            const inspectReference = recoveryCheckpoint.inspectReference.bind(recoveryCheckpoint);
            const hasReferenceCustody = recoveryCheckpoint.hasReferenceCustody.bind(recoveryCheckpoint);
            const restoreReference = recoveryCheckpoint.restoreReference.bind(recoveryCheckpoint);
            const validateReference = recoveryCheckpoint.validateReference.bind(recoveryCheckpoint);
            assertAdmission();
            const { binding, session } = resolveSession(entry);
            const identity = Object.freeze({ ...binding.identity });
            const context = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const editor = binding.editor;
            const validateNative = session.validateRetainedSnapshot.bind(session);
            const restoreNative = session.restoreSnapshot.bind(session);
            const expected = Object.freeze({
                documentIdentity: Object.freeze({ id: identity.documentId, epoch: context.documentEpoch }), revision,
                assertAdmission: (): void => assertOwner()
            });
            const assertOwner = (): void =>
            {
                const info = assertRecoveryReference(entry, binding, inspectReference, pinned.crashJournalRef);
                const current = resolveSession(entry);
                assertBinding(current.binding, identity, context);
                assertBinding(current.binding, pinned.identity, pinned.documentContext);
                if (current.session !== session || current.binding.editor !== editor
                    || current.binding.editorRevision !== revision
                    || pinned.schema !== 'fsusblog.article-workspace-retained-recovery.v1'
                    || nativeSnapshot.editorSessionRef !== entry.editorSessionRef
                    || nativeSnapshot.documentIdentity.id !== identity.documentId
                    || nativeSnapshot.documentIdentity.epoch !== context.documentEpoch
                    || nativeSnapshot.revision !== revision
                    || calculateRetainedRecoveryRefsDigest(pinned) !== pinned.refsDigest)
                {
                    throw new Error('public-editor-recovery-restore-owner-stale');
                }
                if (!hasReferenceCustody(pinned.crashJournalRef, info))
                {
                    throw new Error('public-editor-recovery-reference-custody-revoked');
                }
                assertAdmission();
            };
            assertOwner();
            if (!validateNative(nativeSnapshot, expected))
            {
                throw new Error('public-editor-recovery-native-custody-mismatch');
            }
            assertOwner();
            // Original async storage integrity check never applies content or replaces native custody.
            const record = await restoreReference(pinned.crashJournalRef);
            assertOwner();
            const restoredContent = record?.content;
            if (restoredContent === undefined || !validateReference(pinned.crashJournalRef, restoredContent)
                || calculateOpenArticleDocumentDigest(restoredContent) !== nativeSnapshot.editorContentDigest)
            {
                throw new Error('public-editor-recovery-restore-content-mismatch');
            }
            assertOwner();
            if (!validateNative(nativeSnapshot, expected))
            {
                throw new Error('public-editor-recovery-native-custody-mismatch');
            }
            // No caller getter or recovery callback remains between this real guard and mutation.
            assertAdmission();
            const proof = restoreNative(nativeSnapshot, expected);
            assertOwner();
            return proof;
        },
        inspectResourceSources(entry)
        {
            const { binding, session } = resolveSession(entry);
            const census = session.inspectResourceParticipants();
            const renderer = session.inspectRendererResourceSource();
            const attachment = session.inspectAttachmentResourceSource();
            const current = resolveSession(entry);
            assertBinding(current.binding, binding.identity, binding.documentContext);
            if (current.session !== session
                || current.binding.editorRevision !== binding.editorRevision)
            {
                throw new Error('public-editor-resource-source-owner-stale');
            }
            return Object.freeze({ census, renderer, attachment });
        },
        captureLastValidRender(entry)
        {
            const { binding, session } = resolveSession(entry);
            const capture = session.captureLastValidRender();
            const current = resolveSession(entry);
            if (current.session !== session
                || current.binding.editorRevision !== binding.editorRevision)
            {
                throw new Error('public-editor-last-valid-render-owner-stale');
            }
            if (capture && (capture.documentIdentity.id !== binding.identity.documentId
                || capture.documentIdentity.epoch !== binding.documentContext.documentEpoch
                || capture.revision !== binding.editorRevision))
            {
                throw new Error('public-editor-last-valid-render-context-mismatch');
            }
            return capture;
        },
        async restoreLastValidRender(entry, render)
        {
            const { binding, session } = resolveSession(entry);
            const proof = await session.restoreLastValidRender(render, {
                documentIdentity: {
                    id: binding.identity.documentId,
                    epoch: binding.documentContext.documentEpoch
                },
                revision: binding.editorRevision
            });
            const current = resolveSession(entry);
            if (current.session !== session
                || current.binding.editorRevision !== binding.editorRevision)
            {
                throw new Error('public-editor-last-valid-render-restore-owner-stale');
            }
            return proof;
        },
        prepareRetainedSnapshot,
        captureRetainedSnapshot(entry)
        {
            return prepareRetainedSnapshot(entry).commit();
        },
        restoreRetainedSnapshot(entry, snapshot)
        {
            const { binding, session } = resolveSession(entry);
            const identity = Object.freeze({ ...binding.identity });
            const context = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const editor = binding.editor;
            const proof = session.restoreSnapshot(snapshot, {
                documentIdentity: {
                    id: identity.documentId,
                    epoch: context.documentEpoch
                },
                revision,
                assertAdmission: () =>
                {
                    const current = resolveSession(entry);
                    assertBinding(current.binding, identity, context);
                    if (current.session !== session || current.binding.editor !== editor
                        || current.binding.editorRevision !== revision)
                    {
                        throw new Error('public-editor-retained-restore-owner-stale');
                    }
                }
            });
            const current = resolveSession(entry);
            assertBinding(current.binding, identity, context);
            if (current.session !== session
                || current.binding.editor !== editor
                || current.binding.editorRevision !== revision)
            {
                throw new Error('public-editor-retained-restore-owner-stale');
            }
            return proof;
        },
        createSession(entry): FsusUiPublicEditorSession
        {
            const { session } = resolveSession(entry);
            function readCurrentBinding(): ArticleWorkspaceMountedEditorBinding
            {
                const current = resolveSession(entry);
                if (current.session !== session)
                {
                    throw new Error('public-editor-session-owner-replaced');
                }
                return current.binding;
            }

            function observeResources(
                action: () => ReturnType<MarkdownEditorSession['inspectResources']>
            ): ReturnType<MarkdownEditorSession['inspectResources']>
            {
                const binding = readCurrentBinding();
                const identity = Object.freeze({ ...binding.identity });
                const context = Object.freeze({ ...binding.documentContext });
                const editor = binding.editor;
                const revision = binding.editorRevision;
                const resources = action();
                const current = readCurrentBinding();
                assertBinding(current, identity, context);
                if (current.editor !== editor || current.editorRevision !== revision)
                {
                    throw new Error('public-editor-resource-operation-owner-stale');
                }
                return resources;
            }

            return {
                editorSessionRef: session.editorSessionRef,
                captureSnapshot(context)
                {
                    assertCurrent(entry, session, context);
                    // Scoped reference admission now binds actual native/panel/draft/journal refs.
                    // The same original public Renderer checkpoint is joined by that scoped path.
                    // The real Root token is joined there as borrowed original custody.
                    // Complete resource/restoration admission remains required here.
                    // Refuse before capture so an existing snapshot is preserved.
                    throw new Error('public-editor-full-snapshot-owner-unavailable:panel-state,renderer-restoration,draft,full-recovery-refset');
                },
                inspectResources: () => observeResources(() => session.inspectResources()),
                pauseResources: () => observeResources(() => session.pauseResources()),
                resumeResources: () => observeResources(() => session.resumeResources()),
                restoreSnapshot(snapshot, context)
                {
                    assertCurrent(entry, session, context);
                    return {
                        status: 'blocked',
                        snapshotRef: snapshot.snapshotRef,
                        snapshotDigest: snapshot.snapshotDigest,
                        identityValidated: false,
                        refsValidated: false,
                        reason: 'public-editor-full-snapshot-owner-unavailable:panel-state,renderer-restoration,draft,full-recovery-refset'
                    };
                },
                disposeAfterSnapshot(snapshotRef)
                {
                    // A released/replaced Writer binding cannot dispose the old
                    // native editor. Upstream retains snapshot/disposal authority.
                    readCurrentBinding();
                    session.disposeAfterSnapshot(snapshotRef);
                }
            };
        }
    };
    return factory;
}
