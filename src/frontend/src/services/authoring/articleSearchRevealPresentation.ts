import {
    validateArticleAnchorCommand,
    type ArticleAnchorCommand,
    type ArticleAnchorRestoreKind
} from './articleAnchorContext';
import { validateArticleDocumentContext, type ArticleDocumentContext, type ArticleDocumentTaskLease } from './articleDocumentContext';

import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

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
 * Internal index evaluations/candidates/raw ranges are not admitted commands;
 * only the canonical anchor validator decides whether an input is a command.
 * The shared runtime must still admit/execute the original command at use time.
 */
export function projectArticleSearchReveal(
    command: unknown,
    binding: ArticleEditorRuntimeBinding,
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
        let current: ArticleDocumentContext;
        try
        {
            current = binding.positionBinding().document;
        }
        catch
        {
            return reject('search-reveal-binding-unavailable');
        }
        if (!validateArticleDocumentContext(current) || binding.context.contextDigest !== current.contextDigest
            || command.document.contextDigest !== current.contextDigest)
        {
            return reject('search-reveal-context-stale');
        }
        if (lease.envelope.kind !== 'search' || !lease.isCurrent() || lease.signal.aborted
            || lease.envelope.context.contextDigest !== current.contextDigest)
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
