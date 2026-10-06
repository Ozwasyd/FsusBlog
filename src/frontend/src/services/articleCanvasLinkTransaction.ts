import { articleCanvasLinksApi } from '@/api/articleCanvasLinks';
import { encodeArticleCanvasLinkRequest, type ArticleCanvasLinkRequest, type ArticleCanvasLinkReceipt,
    type ArticleCanvasLinkHistoryResponse } from '@/codecs/binary/articleCanvasLinkWire.generated';
import { BinaryTransportError } from '@/composition/binaryTransport';
import type { EdgeToLinkCommitRequest, EdgeToLinkHistoryRequest, EdgeToLinkReceipt,
    EdgeToLinkTransaction } from '@/services/authoringCanvasEdgeToLink';
import type { CanvasOwnerContext } from '@/services/authoringCanvasStorage';
import { privateRequestRuntime, StalePrivateResponseError } from '@/services/privateRequestRuntime';

const emptyGuid = '00000000-0000-0000-0000-000000000000';
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const positivePattern = /^[1-9][0-9]*$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export type ArticleCanvasLinkPendingWrite = Readonly<
    { kind: 'commit'; request: EdgeToLinkCommitRequest; }
    | { kind: 'undo' | 'redo'; request: EdgeToLinkHistoryRequest; }
>;
export interface ArticleCanvasLinkTransaction extends EdgeToLinkTransaction
{
    pendingWrite(): ArticleCanvasLinkPendingWrite | null;
    retryPending(): Promise<EdgeToLinkReceipt>;
}

function positive(value: number | string, maximum = 9223372036854775807n): string
{
    if (typeof value === 'number' && !Number.isSafeInteger(value))
    {
        throw new RangeError('article_canvas_link_integer_invalid');
    }
    const text = String(value);
    if (!positivePattern.test(text) || text.length > 19 || BigInt(text) > maximum)
    {
        throw new RangeError('article_canvas_link_integer_invalid');
    }
    return text;
}
function article(value: number | string): number
{
    return Number(positive(value, 2147483647n));
}
function guid(value: string): string
{
    if (!guidPattern.test(value) || value === emptyGuid)
    {
        throw new RangeError('article_canvas_link_guid_invalid');
    }
    return value;
}
async function digest(values: readonly (string | number)[]): Promise<string>
{
    const text = values.map((value) =>
    {
        const text = String(value);
        return `${text.length}:${text}`;
    }).join('');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}
function requestValues(value: ArticleCanvasLinkRequest): readonly (string | number)[]
{
    return [1, value.requestId, value.sourceArticleId, value.expectedArticleRevision, value.mode,
        value.targetJournalId, value.canvasId, value.canvasRevision, value.canvasContentDigest,
        value.edgeId, value.targetArticleId, value.expectedTargetRevision];
}
async function validateReceipt(value: ArticleCanvasLinkReceipt, sourceArticleId: number, owner: CanvasOwnerContext): Promise<void>
{
    if (article(value.sourceArticleId) !== sourceArticleId || !guidPattern.test(value.requestId)
        || value.ownerAdminPrincipalId !== owner.userId || value.siteScope !== owner.siteId
        || value.requestId === emptyGuid || !guidPattern.test(value.journalId) || value.journalId === emptyGuid
        || !guidPattern.test(value.parentJournalId) || !guidPattern.test(value.targetJournalId)
        || !guidPattern.test(value.canvasId) || value.canvasId === emptyGuid || !guidPattern.test(value.edgeId)
        || value.edgeId === emptyGuid || !digestPattern.test(value.canvasContentDigest)
        || !digestPattern.test(value.requestDigest) || !digestPattern.test(value.receiptDigest)
        || ![0, 1, 2].includes(value.mode) || (value.mode === 0) !== (value.targetJournalId === emptyGuid)
        || positive(value.articleRevision) === positive(value.previousArticleRevision)
        || !Number.isInteger(value.undoDepth) || value.undoDepth < 0 || value.undoDepth > 100
        || !Number.isInteger(value.redoDepth) || value.redoDepth < 0 || value.redoDepth > 100)
    {
        throw new Error('article_canvas_link_receipt_invalid');
    }
    positive(value.originalBeforeRevision);
    positive(value.originalAfterRevision);
    positive(value.canvasRevision);
    positive(value.targetRevision);
    article(value.targetArticleId);
    const expected = await digest([1, value.requestId, value.journalId, value.parentJournalId,
        value.ownerAdminPrincipalId, value.siteScope,
        value.sourceArticleId, value.previousArticleRevision, value.articleRevision,
        value.originalBeforeRevision, value.originalAfterRevision, value.mode, value.targetJournalId,
        value.canvasId, value.canvasRevision, value.canvasContentDigest, value.edgeId,
        value.targetArticleId, value.targetRevision, value.undoDepth, value.redoDepth, value.requestDigest]);
    if (value.receiptDigest !== expected)
    {
        throw new Error('article_canvas_link_receipt_digest_mismatch');
    }
}
async function validateHistory(value: ArticleCanvasLinkHistoryResponse, sourceArticleId: number, owner: CanvasOwnerContext): Promise<void>
{
    if (value.sourceArticleId !== sourceArticleId || !guidPattern.test(value.lastJournalId)
        || value.undoEntries.length > 100 || value.redoEntries.length > 100
        || !digestPattern.test(value.historyDigest))
    {
        throw new Error('article_canvas_link_history_invalid');
    }
    positive(value.articleRevision);
    if (value.historyArticleRevision === '0')
    {
        if (value.lastJournalId !== emptyGuid || value.undoEntries.length || value.redoEntries.length)
        {
            throw new Error('article_canvas_link_empty_history_invalid');
        }
    }
    else
    {
        positive(value.historyArticleRevision);
        guid(value.lastJournalId);
    }
    const ids = new Set<string>();
    for (const entry of [...value.undoEntries, ...value.redoEntries])
    {
        await validateReceipt(entry, sourceArticleId, owner);
        if (entry.mode !== 0 || ids.has(entry.journalId)
            || entry.originalBeforeRevision !== entry.previousArticleRevision || entry.originalAfterRevision !== entry.articleRevision)
        {
            throw new Error('article_canvas_link_history_entry_invalid');
        }
        ids.add(entry.journalId);
    }
    const expected = await digest([1, sourceArticleId, value.historyArticleRevision, value.lastJournalId,
        value.undoEntries.map((entry) => entry.receiptDigest).join(','),
        value.redoEntries.map((entry) => entry.receiptDigest).join(',')]);
    if (expected !== value.historyDigest)
    {
        throw new Error('article_canvas_link_history_digest_mismatch');
    }
}

/** A single unresolved request survives retries in this provider; it owns no document authority. */
export function createArticleCanvasLinkTransaction(owner: CanvasOwnerContext, signal?: AbortSignal): ArticleCanvasLinkTransaction
{
    const boundOwner = Object.freeze({ ...owner });
    const boundGeneration = privateRequestRuntime.currentGeneration('admin');
    positive(boundOwner.userId);
    if (boundOwner.siteId !== 'primary-site')
    {
        throw new Error('article_canvas_link_site_invalid');
    }
    let pending: { public: ArticleCanvasLinkPendingWrite; wire: ArticleCanvasLinkRequest; bytes: Uint8Array; uncertain: boolean; } | null = null;
    let inFlight = false;
    function lease()
    {
        if (privateRequestRuntime.currentGeneration('admin') !== boundGeneration)
        {
            throw new StalePrivateResponseError('admin');
        }
        return privateRequestRuntime.open('admin', signal);
    }
    async function submit(publicRequest: ArticleCanvasLinkPendingWrite, wire: ArticleCanvasLinkRequest): Promise<EdgeToLinkReceipt>
    {
        const bytes = encodeArticleCanvasLinkRequest(wire);
        if (inFlight)
        {
            throw new Error('article_canvas_link_request_in_flight');
        }
        const active = lease();
        if (pending && (pending.bytes.length !== bytes.length || bytes.some((value, index) => value !== pending!.bytes[index])))
        {
            active.release();
            throw new Error('article_canvas_link_unresolved_request');
        }
        pending ??= { public: publicRequest, wire: Object.freeze(wire), bytes, uncertain: false };
        inFlight = true;
        try
        {
            const receipt = await articleCanvasLinksApi.convert(pending.wire, active.signal);
            await validateReceipt(receipt, wire.sourceArticleId, boundOwner);
            if (receipt.requestId !== wire.requestId || receipt.mode !== wire.mode
                || receipt.targetJournalId !== wire.targetJournalId
                || receipt.previousArticleRevision !== wire.expectedArticleRevision
                || receipt.requestDigest !== await digest(requestValues(wire)))
            {
                throw new Error('article_canvas_link_receipt_binding_mismatch');
            }
            if (wire.mode === 0 && (receipt.canvasId !== wire.canvasId || receipt.canvasRevision !== wire.canvasRevision
                || receipt.canvasContentDigest !== wire.canvasContentDigest || receipt.edgeId !== wire.edgeId
                || receipt.targetArticleId !== wire.targetArticleId || receipt.targetRevision !== wire.expectedTargetRevision
                || receipt.originalBeforeRevision !== wire.expectedArticleRevision || receipt.originalAfterRevision !== receipt.articleRevision))
            {
                throw new Error('article_canvas_link_apply_receipt_mismatch');
            }
            active.signal?.throwIfAborted();
            active.assertCurrent();
            pending = null;
            return receipt;
        }
        catch (error)
        {
            const definiteRejection = error instanceof BinaryTransportError
                && ['auth_failed', 'forbidden', 'not_found', 'conflict', 'validation', 'precondition_required'].includes(error.kind);
            // After an ambiguous attempt, a later denial cannot prove the original write did not commit.
            if (definiteRejection && pending && !pending.uncertain)
            {
                pending = null;
            }
            else if (pending)
            {
                pending.uncertain = true;
            }
            throw error;
        }
        finally
        {
            active.release();
            inFlight = false;
        }
    }
    function historyWrite(kind: 'undo' | 'redo', request: EdgeToLinkHistoryRequest): Promise<EdgeToLinkReceipt>
    {
        const frozen = Object.freeze({ ...request });
        return submit(Object.freeze({ kind, request: frozen }), {
            requestId: guid(request.requestId), sourceArticleId: article(request.sourceArticleId),
            expectedArticleRevision: positive(request.expectedArticleRevision), mode: kind === 'undo' ? 1 : 2,
            targetJournalId: guid(request.targetJournalId), canvasId: emptyGuid, canvasRevision: '0',
            canvasContentDigest: '', edgeId: emptyGuid, targetArticleId: 0, expectedTargetRevision: '0'
        });
    }
    return {
        commit(request)
        {
            if (!request.plan.valid || request.plan.edgeType !== 'explicit-reference-note'
                || request.plan.insertPosition !== 'end_of_document'
                || String(request.plan.sourceArticleId) !== String(request.sourceArticleId)
                || String(request.plan.targetArticleId) !== String(request.targetArticleId)
                || !digestPattern.test(request.canvasContentDigest))
            {
                throw new Error('article_canvas_link_plan_invalid');
            }
            const frozen = Object.freeze({ ...request, plan: Object.freeze({ ...request.plan }) });
            return submit(Object.freeze({ kind: 'commit', request: frozen }), {
                requestId: guid(request.requestId), sourceArticleId: article(request.sourceArticleId),
                expectedArticleRevision: positive(request.expectedArticleRevision), mode: 0,
                targetJournalId: emptyGuid, canvasId: guid(request.canvasId), canvasRevision: positive(request.canvasRevision),
                canvasContentDigest: request.canvasContentDigest, edgeId: guid(request.plan.edgeId),
                targetArticleId: article(request.targetArticleId), expectedTargetRevision: positive(request.expectedTargetRevision)
            });
        },
        async history(sourceArticleId)
        {
            const id = article(sourceArticleId);
            const active = lease();
            try
            {
                const result = await articleCanvasLinksApi.history(id, active.signal);
                await validateHistory(result, id, boundOwner);
                active.signal?.throwIfAborted();
                active.assertCurrent();
                return result;
            }
            finally
            {
                active.release();
            }
        },
        undo: (request) => historyWrite('undo', request),
        redo: (request) => historyWrite('redo', request),
        pendingWrite: () => pending?.public ?? null,
        retryPending()
        {
            if (!pending)
            {
                throw new Error('article_canvas_link_pending_request_missing');
            }
            return submit(pending.public, pending.wire);
        }
    };
}
