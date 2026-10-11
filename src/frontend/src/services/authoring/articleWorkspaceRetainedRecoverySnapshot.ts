import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleRecoveryJournalCheckpointReferenceBinding } from '../articleRecoveryJournal';
import type { ArticleDocumentContextRef, ArticleDocumentIdentity, OpenArticleDocumentEntry } from './openArticleDocumentRegistry';
import type { MarkdownEditorSessionRestoreProof, MarkdownEditorSessionSnapshot } from '@ozwasyd/element-plus';

/** Exact actual port returned by original Writer 1400e677; no additional binding is created here. */
export type ArticleWorkspaceRetainedRecoveryCheckpoint = ArticleRecoveryJournalCheckpointReferenceBinding & {
    captureRetainedSnapshot(reference: string, assertAdmission?: () => void): MarkdownEditorSessionSnapshot;
};

/** Borrowed original Write/registry owner reader; null never creates an association or binding. */
export interface ArticleWorkspaceRetainedRecoverySource {
    readCurrent(): { entry: OpenArticleDocumentEntry; checkpoint: ArticleWorkspaceRetainedRecoveryCheckpoint; } | null;
}

/** Explicit partial-checkpoint operations; not the complete host/router session admission port. */
export interface ArticleWorkspaceRetainedRecoveryPort {
    prepareSnapshot(signal?: AbortSignal): Promise<ArticleWorkspaceRetainedRecoverySnapshot>;
    restoreSnapshot(snapshot: ArticleWorkspaceRetainedRecoverySnapshot): Promise<MarkdownEditorSessionRestoreProof>;
}

/** Process-local retained capability; neither a full host snapshot nor persisted authority. */
export interface ArticleWorkspaceRetainedRecoverySnapshot {
    readonly schema: 'fsusblog.article-workspace-retained-recovery.v1';
    readonly identity: Readonly<ArticleDocumentIdentity>;
    readonly documentContext: Readonly<ArticleDocumentContextRef>;
    readonly nativeSnapshot: MarkdownEditorSessionSnapshot;
    /** The SAME actual binding forwarded by the original Writer; release remains its owner's job. */
    readonly recoveryCheckpoint: ArticleWorkspaceRetainedRecoveryCheckpoint;
    readonly crashJournalRef: string;
    readonly refsDigest: string;
}

/** Canonical digest of actual issued retained refs; never substitutes missing full-host refs. */
export function calculateRetainedRecoveryRefsDigest(
    snapshot: Omit<ArticleWorkspaceRetainedRecoverySnapshot, 'refsDigest'>
): string
{
    const native = snapshot.nativeSnapshot;
    return calculateOpenArticleDocumentDigest({
        schema: snapshot.schema,
        identity: snapshot.identity,
        documentContext: snapshot.documentContext,
        editorSessionRef: native.editorSessionRef,
        snapshotRef: native.snapshotRef,
        documentIdentity: native.documentIdentity,
        revision: native.revision,
        editorContentDigest: native.editorContentDigest,
        selectionRef: native.selectionRef,
        historyRef: native.historyRef,
        viewStateRef: native.viewStateRef,
        crashJournalRef: snapshot.crashJournalRef
    });
}
