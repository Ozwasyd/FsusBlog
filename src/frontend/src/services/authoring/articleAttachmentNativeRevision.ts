import type {
    MarkdownAttachmentTerminalCustody,
    MarkdownAttachmentTerminalRevisionIssuer,
    MarkdownAttachmentTerminalRevisionReservation
} from '@/fsusui/articleAttachments';
import type { MarkdownEditorTransactionEvent } from '@/fsusui/articlePositionMaps';

import type { ArticleDocumentTaskLease } from './articleDocumentContext';

/** Actual original pending lease and native reservation; never a task completion. */
export interface ArticleAttachmentNativeRevisionAssociation
{
    readonly issuer: MarkdownAttachmentTerminalRevisionIssuer;
    readonly reservation: MarkdownAttachmentTerminalRevisionReservation;
    readonly lease: ArticleDocumentTaskLease;
    readonly custody: MarkdownAttachmentTerminalCustody;
}

/** Bind only through the original Writer/attachment/Doc composition. */
export interface ArticleAttachmentNativeRevisionProducer
{
    reserve(lease: ArticleDocumentTaskLease, custody: MarkdownAttachmentTerminalCustody): ArticleAttachmentNativeRevisionAssociation | null;
    hasAssociation(association: ArticleAttachmentNativeRevisionAssociation,
        phase: 'applying' | 'accepted' | 'committed', transaction?: MarkdownEditorTransactionEvent): boolean;
    cancelAssociation(association: ArticleAttachmentNativeRevisionAssociation): boolean;
    inspectCleanup(): Readonly<{ pending: number; failed: boolean; firstCause: unknown; latestCause: unknown; }>;
    retryCleanup(): boolean;
}
