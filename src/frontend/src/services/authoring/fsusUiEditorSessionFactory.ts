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

import type { ArticleRecoveryJournalCheckpointInfo, ArticleRecoveryJournalCheckpointReferenceBinding } from '../articleRecoveryJournal';
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

export interface ArticleWorkspaceFsusUiEditorSessionFactory extends FsusUiPublicEditorSessionFactory {
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

    return {
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
        captureRetainedSnapshot(entry)
        {
            const { binding, session } = resolveSession(entry);
            const identity = Object.freeze({ ...binding.identity });
            const context = Object.freeze({ ...binding.documentContext });
            const revision = binding.editorRevision;
            const editor = binding.editor;
            const snapshot = session.captureSnapshot(calculateOpenArticleDocumentDigest, {
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
                        throw new Error('public-editor-retained-snapshot-stale');
                    }
                }
            });
            // Re-resolve after the digest callback; a document replacement must
            // not be silently accepted as the requested registry session.
            const current = resolveSession(entry);
            if (current.session !== session
                || snapshot.documentIdentity.id !== binding.identity.documentId
                || snapshot.documentIdentity.epoch !== binding.documentContext.documentEpoch
                || snapshot.revision !== binding.editorRevision
                || current.binding.editorRevision !== snapshot.revision)
            {
                throw new Error('public-editor-retained-snapshot-stale');
            }
            return snapshot;
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
