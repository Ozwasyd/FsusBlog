import { compareArticleRevisionSources } from '@/api/articleRevisionCompare';
import type { ArticleRevisionComparePlanReceipt, ArticleRevisionCompareRequest } from '@/api/articleRevisionCompare';
import type { ArticleDocumentTaskLease } from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import type { RevisionSourcePresentation } from '@/services/revisionComparePresentation';
import { createRevisionFragmentProposal } from '@/services/revisionFragmentProposal';
import type { RevisionFragmentCurrentSnapshot, RevisionFragmentProposal } from '@/services/revisionFragmentProposal';

/** Structural read-only view of the real borrowCompareTask result at PR4153 4d3ee437. */
export interface RevisionFragmentCompareCaller {
    readonly task: Pick<ArticleDocumentTaskLease, 'signal' | 'envelope' | 'isCurrent'>;
    captureCurrent(): {
        readonly document: RevisionFragmentCurrentSnapshot['document'];
        readonly anchor: { readonly range: { readonly start: number; readonly end: number; };
            readonly direction: RevisionFragmentCurrentSnapshot['selection']['direction']; };
    };
    release(): void;
}

/** A fresh authorized read observation, never an action grant or native execution receipt. */
export interface RevisionFragmentPreflight {
    readonly status: 'unexecuted';
    readonly proposal: RevisionFragmentProposal;
    readonly readObservation: Readonly<ArticleRevisionComparePlanReceipt>;
}

const same = (left: unknown, right: unknown): boolean => digest(left) === digest(right);
function fail(reason: string): never
{
    throw new Error(`revision_fragment_preflight_${reason}`);
}
function freezeTree(value: unknown): void
{
    if (value !== null && typeof value === 'object')
    {
        Object.values(value).forEach(freezeTree);
        Object.freeze(value);
    }
}

/**
 * Consume a caller-held canonical compare loan and always release it. The real API
 * re-enters ArticleWrite/package verification; no injected permission boolean or
 * cached frontend grant is accepted. A new read plan never replaces the original
 * proposal plan. This performs no dispatch and supplies no continuing permission.
 */
export async function recheckRevisionFragmentProposal(
    proposal: RevisionFragmentProposal,
    presentation: RevisionSourcePresentation,
    originalRequest: ArticleRevisionCompareRequest,
    caller: RevisionFragmentCompareCaller
): Promise<RevisionFragmentPreflight>
{
    try
    {
        const selected = structuredClone(proposal);
        const original = structuredClone(presentation);
        const request = structuredClone(originalRequest);
        const plan = original.response.planReceipt;
        // Reject substituted expected records before any capture or new read. Never backfill a legacy proposal.
        if (selected.schema !== 'fsusblog.revision-fragment-proposal.v2'
            || plan.planDigest !== selected.selection.planDigest || selected.comparePlanReceiptDigest !== digest(plan))
        {
            fail('compare_record_stale');
        }
        if (request.cancellationIdentity !== plan.cancellationIdentity
            || ![plan.permissionScopeDigest, plan.optionsDigest, plan.budgetDigest, plan.metadataSchemaDigest]
                .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)))
        {
            fail('request_invalid');
        }
        const requireCurrent = (): void =>
        {
            caller.task.signal.throwIfAborted();
            if (!caller.task.isCurrent() || caller.task.envelope.kind !== 'compare'
                || !same(caller.task.envelope.context, selected.current.document))
            {
                fail('current_stale');
            }
        };
        const readCurrent = (): RevisionFragmentCurrentSnapshot =>
        {
            requireCurrent();
            const captured = caller.captureCurrent();
            requireCurrent();
            return { document: captured.document, selection: { start: captured.anchor.range.start,
                end: captured.anchor.range.end, direction: captured.anchor.direction } };
        };
        requireCurrent();
        const replay = await createRevisionFragmentProposal(original, selected.selection, readCurrent, caller.task.signal);
        if (!same(replay, selected))
        {
            fail('proposal_stale');
        }
        requireCurrent();
        // Keep the original request/proposal identities; the task supplies a separate read cancellation identity.
        const response = await compareArticleRevisionSources(selected.selection.articleId,
            { ...request, cancellationIdentity: caller.task.envelope.requestId }, { signal: caller.task.signal });
        requireCurrent();
        const observed = structuredClone(response.planReceipt);
        if (!same(observed.basePackageReference, selected.basePackageReference)
            || !same(observed.comparePackageReference, selected.comparePackageReference)
            || observed.basePackageDigest !== plan.basePackageDigest || observed.comparePackageDigest !== plan.comparePackageDigest
            || observed.permissionScopeDigest !== plan.permissionScopeDigest || observed.optionsDigest !== plan.optionsDigest
            || observed.budgetDigest !== plan.budgetDigest || observed.metadataSchemaDigest !== plan.metadataSchemaDigest)
        {
            fail('package_or_scope_stale');
        }
        // Rehash the original owned bytes and recapture after the real asynchronous authorized read.
        const finalProposal = await createRevisionFragmentProposal(original, selected.selection, readCurrent, caller.task.signal);
        requireCurrent();
        if (!same(finalProposal, selected) || !same(selected, proposal) || !same(original, presentation)
            || !same(request, originalRequest))
        {
            fail('input_stale');
        }
        const result: RevisionFragmentPreflight = { status: 'unexecuted', proposal: finalProposal, readObservation: observed };
        freezeTree(result);
        return result;
    }
    finally
    {
        caller.release();
    }
}
