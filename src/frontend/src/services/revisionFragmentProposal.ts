import type { ArticleRevisionComparePackageReference, RevisionByteRange } from '@/api/articleRevisionCompare';
import { validateArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import { readRevisionSourceRange, revisionSourceDigest } from '@/services/revisionComparePresentation';
import type { RevisionSourcePresentation } from '@/services/revisionComparePresentation';

/** Captured from the current editor's native selection, never DOM/textarea offsets. */
export interface RevisionFragmentCurrentSnapshot {
    readonly document: ArticleDocumentContext;
    readonly selection: { readonly start: number; readonly end: number; readonly direction: 'forward' | 'backward' | 'none'; };
}

export interface RevisionFragmentSelection {
    readonly articleId: number;
    readonly actionId: string;
    readonly planDigest: string;
    readonly basePackageDigest: string;
    readonly comparePackageDigest: string;
    readonly side: 'base' | 'compare';
    readonly sourceIdentity: string;
    readonly sourceDigest: string;
    readonly packageDigest: string;
    readonly chunkDigest: string;
    readonly hunkIndex: number;
    readonly range: RevisionByteRange;
}

/** Source-stage proposal only. No permission, execution receipt or transaction authority. */
export interface RevisionFragmentProposal {
    readonly schema: 'fsusblog.revision-fragment-proposal.v1';
    readonly status: 'unexecuted';
    readonly selection: RevisionFragmentSelection;
    readonly historicalRevisionId: string;
    readonly baseSourceIdentity: string;
    readonly compareSourceIdentity: string;
    readonly basePackageReference: Readonly<ArticleRevisionComparePackageReference>;
    readonly comparePackageReference: Readonly<ArticleRevisionComparePackageReference>;
    readonly hunkRange: RevisionByteRange;
    readonly current: RevisionFragmentCurrentSnapshot;
    readonly fragmentText: string;
    readonly fragmentUtf8: readonly number[];
    readonly fragmentDigest: string;
    readonly executionRequirements: readonly [
        'current-permission-recheck', 'historical-package-recheck',
        'current-document-selection-and-fragment-recheck', 'canonical-host-composition'
    ];
    readonly contentDigest: string;
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const same = (left: unknown, right: unknown): boolean =>
    calculateOpenArticleDocumentDigest(left) === calculateOpenArticleDocumentDigest(right);
function fail(reason: string): never
{
    throw new Error(`revision_fragment_${reason}`);
}

function captureCurrent(readCurrent: () => RevisionFragmentCurrentSnapshot, articleId: number): RevisionFragmentCurrentSnapshot
{
    const captured = structuredClone(readCurrent());
    const selection = captured?.selection;
    if (!validateArticleDocumentContext(captured?.document) || captured.document.articleId !== articleId
        || !selection || Object.keys(selection).length !== 3
        || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)
        || selection.start < 0 || selection.end < selection.start
        || !['forward', 'backward', 'none'].includes(selection.direction))
    {
        fail('current_context_invalid');
    }
    return captured;
}

function sourceSnapshot(presentation: RevisionSourcePresentation)
{
    if (!(presentation.baseBytes instanceof Uint8Array) || !(presentation.compareBytes instanceof Uint8Array))
    {
        fail('source_stale');
    }
    return { ...structuredClone({ plan: presentation.response.planReceipt, diff: presentation.response.sourceDiff }),
        baseBytes: Uint8Array.from(presentation.baseBytes), compareBytes: Uint8Array.from(presentation.compareBytes) };
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
 * Read an exact historical hunk slice from the already authorized compare presentation.
 * The host supplies a fresh native document/selection capture both before and after hashing.
 * This join cannot establish fresh permission or historical-package authority: those and
 * canonical transaction/position-map composition remain required before any execution.
 */
export async function createRevisionFragmentProposal(
    presentation: RevisionSourcePresentation,
    selection: RevisionFragmentSelection,
    readCurrent: () => RevisionFragmentCurrentSnapshot,
    signal?: AbortSignal
): Promise<RevisionFragmentProposal>
{
    signal?.throwIfAborted();
    const selected = structuredClone(selection);
    if (!Number.isSafeInteger(selected.articleId) || selected.articleId <= 0
        || typeof selected.actionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(selected.actionId)
        || !['base', 'compare'].includes(selected.side)
        || !Number.isSafeInteger(selected.hunkIndex) || selected.hunkIndex < 0
        || ![selected.planDigest, selected.basePackageDigest, selected.comparePackageDigest,
            selected.sourceDigest, selected.packageDigest, selected.chunkDigest].every(hash))
    {
        fail('selection_invalid');
    }
    const current = captureCurrent(readCurrent, selected.articleId);
    const snapshot = sourceSnapshot(presentation);
    const { plan, diff, baseBytes, compareBytes } = snapshot;
    const receipt = diff.receipt;
    if (plan.status !== 0 || diff.status !== 0 || diff.isSuccess !== true || receipt.status !== 0
        || diff.attemptReceipt.status !== 0 || plan.planDigest !== selected.planDigest
        || receipt.planDigest !== plan.planDigest || plan.admissionDigest !== receipt.admissionDigest
        || diff.attemptReceipt.semanticContentDigest !== receipt.contentDigest
        || plan.basePackageDigest !== selected.basePackageDigest
        || plan.comparePackageDigest !== selected.comparePackageDigest)
    {
        fail('plan_stale');
    }
    for (const side of ['base', 'compare'] as const)
    {
        const reference = plan[`${side}PackageReference`];
        const bytes = side === 'base' ? baseBytes : compareBytes;
        if (!(bytes instanceof Uint8Array) || reference.packageDigest !== plan[`${side}PackageDigest`]
            || !hash(reference.sourceDigest) || reference.sourceDigest !== receipt[`${side}SourceDigest`]
            || reference.sourceByteLength !== bytes.length || receipt[`${side}SourceByteCount`] !== bytes.length
            || await revisionSourceDigest(bytes) !== reference.sourceDigest)
        {
            fail('source_stale');
        }
        // Reject malformed full sources as well as split UTF-8 boundaries below.
        readRevisionSourceRange(bytes, { offset: 0, length: bytes.length, end: bytes.length });
    }
    const reference = plan[`${selected.side}PackageReference`];
    if (reference.sourceKind !== 1 || typeof reference.revisionId !== 'string' || !reference.revisionId || !Number.isSafeInteger(reference.revisionNo)
        || reference.revisionNo! <= 0 || reference.serverRevision !== null || reference.documentEpoch !== null
        || reference.sourceIdentity !== `revision:${reference.revisionId}:${reference.revisionNo}`
        || reference.sourceIdentity !== selected.sourceIdentity || reference.sourceDigest !== selected.sourceDigest
        || reference.packageDigest !== selected.packageDigest)
    {
        fail('historical_package_invalid');
    }
    const chunks = diff.chunks.filter(chunk => chunk.contentDigest === selected.chunkDigest);
    if (chunks.length !== 1)
    {
        fail('hunk_invalid');
    }
    const hunk = chunks[0].hunks[selected.hunkIndex];
    if (!hunk || ![1, 2, 3].includes(hunk.kind))
    {
        fail('hunk_invalid');
    }
    const bytes = selected.side === 'base' ? baseBytes : compareBytes;
    const hunkRange = hunk[selected.side];
    readRevisionSourceRange(bytes, hunkRange);
    const fragmentText = readRevisionSourceRange(bytes, selected.range);
    if (selected.range.length <= 0 || selected.range.offset < hunkRange.offset || selected.range.end > hunkRange.end)
    {
        fail('range_outside_hunk');
    }
    const fragmentBytes = bytes.slice(selected.range.offset, selected.range.end);
    const fragmentDigest = await revisionSourceDigest(fragmentBytes);
    signal?.throwIfAborted();
    // No await after these final checks: reject switching, edits, selection movement and
    // mutable presentation/request drift while the asynchronous source hashing ran.
    if (!same(current, captureCurrent(readCurrent, selected.articleId)))
    {
        fail('current_stale');
    }
    const live = sourceSnapshot(presentation);
    if (!same(selected, selection) || !same(snapshot.plan, live.plan) || !same(snapshot.diff, live.diff)
        || baseBytes.length !== live.baseBytes.length || compareBytes.length !== live.compareBytes.length
        || baseBytes.some((byte, index) => byte !== live.baseBytes[index])
        || compareBytes.some((byte, index) => byte !== live.compareBytes[index]))
    {
        fail('source_stale');
    }
    const unsigned = {
        schema: 'fsusblog.revision-fragment-proposal.v1' as const,
        status: 'unexecuted' as const,
        selection: selected,
        historicalRevisionId: reference.revisionId,
        baseSourceIdentity: plan.basePackageReference.sourceIdentity,
        compareSourceIdentity: plan.comparePackageReference.sourceIdentity,
        basePackageReference: plan.basePackageReference,
        comparePackageReference: plan.comparePackageReference,
        hunkRange,
        current,
        fragmentText,
        fragmentUtf8: Array.from(fragmentBytes),
        fragmentDigest,
        executionRequirements: ['current-permission-recheck', 'historical-package-recheck',
            'current-document-selection-and-fragment-recheck', 'canonical-host-composition'] as const
    };
    const proposal: RevisionFragmentProposal = { ...unsigned, contentDigest: calculateOpenArticleDocumentDigest(unsigned) };
    freezeTree(proposal);
    signal?.throwIfAborted();
    return proposal;
}
