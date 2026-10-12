import { createArticleWorkspaceNativeDocumentAuthorityConsumer } from './articleWorkspaceNativeDocumentAuthority';
import {
    calculateRetainedRecoveryRefsDigest,
    type ArticleWorkspaceRetainedRecoveryCheckpoint,
    type ArticleWorkspaceRetainedRecoverySnapshot
} from './articleWorkspaceRetainedRecoverySnapshot';
import {
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
import type {
    MarkdownEditorSession,
    MarkdownEditorSessionAttachmentResourceSource,
    MarkdownEditorSessionExpose,
    MarkdownEditorSessionLastValidRender,
    MarkdownEditorSessionRenderRestoreProof,
    MarkdownEditorSessionRestoreProof,
    MarkdownEditorSessionRendererResourceSource,
    MarkdownEditorSessionSnapshot
} from '@ozwasyd/element-plus';

/** Supplied by the existing mounted editor/document owner, never route discovery. */
export interface ArticleWorkspaceMountedEditorBinding {
    readonly editor: MarkdownEditorSessionExpose;
    readonly identity: ArticleDocumentIdentity;
    readonly documentContext: ArticleDocumentContextRef;
    readonly editorRevision: number;
    readonly draftCheckpoint?: ArticleWorkspaceOriginalDraftCheckpoint | null;
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

export interface ArticleWorkspaceFsusUiEditorSessionFactory extends FsusUiPublicEditorSessionFactory {
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
                        publishNative: () =>
                        {
                            if (state !== 'sealed' || publication === undefined)
                            {
                                return null;
                            }
                            const snapshot = publishNative(publication);
                            if (snapshot)
                            {
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

    return {
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
        retireNativeDocumentAuthorities: () => nativeDocumentAuthority.retire(),
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
                    // Upstream exposes an actual nullable full-document render
                    // ref and same-mounted projection restoration, but complete panel state and
                    // application draft and complete recovery ref admission remain absent.
                    // The separate retained API uses the actual original Writer journal binding.
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
}
