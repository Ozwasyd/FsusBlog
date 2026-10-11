import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleRecoveryJournalCheckpointReferenceBinding } from '../articleRecoveryJournal';
import type { ArticleDocumentContextRef, ArticleDocumentIdentity } from './openArticleDocumentRegistry';
import type { MarkdownEditorSessionSnapshot } from '@ozwasyd/element-plus';

/** Exact actual port returned by original Writer 1400e677; no additional binding is created here. */
export type ArticleWorkspaceRetainedRecoveryCheckpoint = ArticleRecoveryJournalCheckpointReferenceBinding & {
    captureRetainedSnapshot(reference: string): MarkdownEditorSessionSnapshot;
};

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
