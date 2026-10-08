import {
    validateArticleAnchorCommand,
    type ArticleAnchorCommand,
    type ArticleAnchorRestoreKind
} from './articleAnchorContext';

import type { ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from './articleDocumentContext';

export interface ArticleSearchRevealPresentation {
    readonly status: ArticleAnchorCommand['status'];
    readonly precision: ArticleAnchorRestoreKind | null;
    readonly exact: boolean;
    readonly approximate: boolean;
    readonly reason: string | null;
    readonly commandDigest: string | null;
}

/**
 * Project the canonical search reveal outcome for UI consumption. This does not
 * create anchors, execute commands, revalidate server results or record visits.
 * The shared runtime must still admit/execute the original command at use time.
 */
export function projectArticleSearchReveal(
    command: unknown,
    document: ArticleDocumentContextAdapter,
    lease: ArticleDocumentTaskLease
): ArticleSearchRevealPresentation
{
    const reject = (reason: string): ArticleSearchRevealPresentation => Object.freeze({
        status: 'rejected', precision: null, exact: false, approximate: false,
        reason, commandDigest: null
    });
    try
    {
        if (!validateArticleAnchorCommand(command))
        {
            return reject('search-reveal-command-invalid');
        }
        if (command.origin !== 'search')
        {
            return reject('search-reveal-origin-mismatch');
        }
        if (!document.isCurrentContext(command.document))
        {
            return reject('search-reveal-context-stale');
        }
        if (lease.envelope.kind !== 'search' || !lease.isCurrent() || lease.signal.aborted
            || !document.isCurrentContext(lease.envelope.context))
        {
            return reject('search-reveal-lease-stale');
        }
        return Object.freeze({
            status: command.status,
            precision: command.kind,
            exact: command.status === 'ready' && command.kind === 'exact',
            approximate: command.approximate,
            reason: command.reason,
            commandDigest: command.contentDigest
        });
    }
    catch
    {
        // Never expose an exception payload from an invalid boundary value.
        return reject('search-reveal-command-invalid');
    }
}
