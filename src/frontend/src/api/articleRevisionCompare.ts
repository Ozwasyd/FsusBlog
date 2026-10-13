import { requestAuthoringBinary } from '@/api/authoring';
import type { ApiRequestConfig } from '@/api/requestConfig';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { FrameType } from '@wasm/protocol/frame';

export type RevisionCompareSourceKind = 0 | 1 | 2;
export type RevisionDiffKind = 0 | 1 | 2 | 3;

export interface ArticleRevisionCompareSelector {
    kind: RevisionCompareSourceKind;
    revisionId?: string | null;
    draftKey?: string | null;
    expectedServerRevision?: string | null;
    documentEpoch?: string | null;
    expectedSourceDigest?: string | null;
}

export interface ArticleRevisionCompareRequest {
    base: ArticleRevisionCompareSelector;
    compare: ArticleRevisionCompareSelector;
    options: {
        viewMode: 0 | 1;
        wordSegmentation: 0;
        contextLineCount: number;
        headingNavigation: boolean;
        metadataFieldIds: string[];
    };
    budgets: {
        maxSourceBytes: number;
        maxLineCount: number;
        maxTokenCount: number;
        maxOutputBytes: number;
        maxMemoryBytes: number;
        maxHunksPerChunk: number;
        maxChunks: number;
        timeoutMilliseconds: number;
    };
    cancellationIdentity: string;
}

export interface ArticleRevisionCompareDraftCoordinateRequest {
    draftKey: string;
    expectedServerRevision: string;
}

export interface ArticleRevisionCompareDraftCoordinateResponse {
    draftKey: string;
    articleId: number;
    serverRevision: string;
    documentEpoch: string;
    sourceDigest: string;
}

export interface RevisionByteRange {
    offset: number;
    length: number;
    end: number;
}

export interface RevisionDiffLine {
    index: number;
    content: RevisionByteRange;
    terminator: RevisionByteRange;
    terminatorKind: 0 | 1 | 2 | 3;
}

export interface RevisionDiffHeading {
    level: number;
    lineIndex: number;
    source: RevisionByteRange;
    identityDigest: string;
}

export interface RevisionDiffHunk {
    kind: RevisionDiffKind;
    baseStartLine: number;
    baseLineCount: number;
    compareStartLine: number;
    compareLineCount: number;
    base: RevisionByteRange;
    compare: RevisionByteRange;
    wordEdits: { kind: RevisionDiffKind; base: RevisionByteRange; compare: RevisionByteRange; }[];
    headingIdentities: string[];
}

export interface ArticleRevisionComparePackageReference {
    sourceKind: RevisionCompareSourceKind;
    sourceIdentity: string;
    revisionId: string | null;
    revisionNo: number | null;
    serverRevision: string | null;
    documentEpoch: string | null;
    sourceDigest: string;
    packageDigest: string;
    sourceByteLength: number;
}

export interface ArticleRevisionComparePlanReceipt {
    schemaVersion: number;
    requestId: string;
    status: 0;
    reasonCode: string;
    planDigest: string;
    basePackageDigest: string;
    comparePackageDigest: string;
    basePackageReference: ArticleRevisionComparePackageReference;
    comparePackageReference: ArticleRevisionComparePackageReference;
    permissionScopeDigest: string;
    metadataSchemaDigest: string;
    optionsDigest: string;
    budgetDigest: string;
    admissionDigest: string;
    cancellationIdentity: string;
    contentDigest: string;
}

export interface RevisionSourceDiffReceipt {
    schemaVersion: number;
    engineVersion: string;
    segmenterVersion: string;
    structureParserVersion: string;
    status: 0;
    reasonCode: string;
    planDigest: string;
    baseSourceDigest: string;
    compareSourceDigest: string;
    baseStructureDigest: string;
    compareStructureDigest: string;
    budgetDigest: string;
    admissionDigest: string;
    baseSourceByteCount: number;
    compareSourceByteCount: number;
    baseLineCount: number;
    compareLineCount: number;
    tokenCount: number;
    wordEditCount: number;
    headingCount: number;
    contextGroupCount: number;
    hunkCount: number;
    chunkCount: number;
    estimatedMemoryBytes: number;
    estimatedOutputBytes: number;
    contentDigest: string;
}

export interface ArticleRevisionMetadataDiffValue {
    kind: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    text: string | null;
    number: string | null;
    boolean: boolean | null;
    ids: number[];
}

export interface ArticleRevisionMetadataDiffResponse {
    receipt: {
        engineVersion: string;
        projectionVersion: string;
        registryDigest: string;
        status: 0 | 1;
        coverage: 1 | 2;
        reason: string;
        planDigest: string;
        basePackageDigest: string;
        comparePackageDigest: string;
        fieldCount: number;
        missingAuthorities: string[];
        contentDigest: string;
    };
    fields: {
        fieldId: string;
        beforePackageDigest: string;
        afterPackageDigest: string;
        authority: string;
        normalization: string;
        displayFormat: string;
        sensitive: boolean;
        before: ArticleRevisionMetadataDiffValue;
        after: ArticleRevisionMetadataDiffValue;
        change: 0 | 1 | 2 | 3 | 4 | 5 | 6;
        addedIds: number[];
        removedIds: number[];
    }[];
    timing: { elapsedTicks: string; frequency: string; };
    isSuccess: boolean;
    isReviewable: boolean;
}

export interface ArticleRevisionCompareResponse {
    metadataDiff?: ArticleRevisionMetadataDiffResponse | null;
    planReceipt: ArticleRevisionComparePlanReceipt;
    sourceDiff: {
        status: 0;
        chunks: { index: number; hunks: RevisionDiffHunk[]; contentDigest: string; }[];
        baseLines: RevisionDiffLine[];
        compareLines: RevisionDiffLine[];
        baseHeadings: RevisionDiffHeading[];
        compareHeadings: RevisionDiffHeading[];
        contextGroups: {
            index: number;
            collapsed: boolean;
            baseStartLine: number;
            baseLineCount: number;
            compareStartLine: number;
            compareLineCount: number;
            base: RevisionByteRange;
            compare: RevisionByteRange;
            contentDigest: string;
        }[];
        receipt: RevisionSourceDiffReceipt;
        attemptReceipt: {
            semanticContentDigest: string;
            status: 0;
            elapsedMilliseconds: number;
            contentDigest: string;
        };
        isSuccess: boolean;
    };
}

function isBoundMetadata(value: ArticleRevisionCompareResponse, requested: boolean): boolean
{
    const metadata = value.metadataDiff;
    if (!metadata)
    {
        return !requested;
    }
    const receipt = metadata.receipt;
    const long = (number: unknown, positive = false): boolean =>
    {
        if (typeof number !== 'string' || !/^(?:0|-?[1-9]\d*)$/u.test(number))
        {
            return false;
        }
        const exact = BigInt(number);
        return exact >= (positive ? 1n : -9223372036854775808n) && exact <= 9223372036854775807n;
    };
    const typedValue = (cell: ArticleRevisionMetadataDiffValue): boolean => !!cell && Number.isInteger(cell.kind)
        && cell.kind >= 0 && cell.kind <= 8 && Array.isArray(cell.ids)
        && cell.ids.every(id => Number.isSafeInteger(id) && id > 0)
        && (cell.number === null || long(cell.number))
        && (![4, 6, 7].includes(cell.kind) || long(cell.number))
        && (cell.kind !== 3 || typeof cell.text === 'string')
        && (cell.kind !== 5 || typeof cell.boolean === 'boolean');
    return !!receipt && metadata.isReviewable === true
        && [0, 1].includes(receipt.status) && receipt.coverage === (receipt.status === 0 ? 1 : 2)
        && metadata.isSuccess === (receipt.status === 0)
        && receipt.planDigest === value.planReceipt.planDigest
        && receipt.basePackageDigest === value.planReceipt.basePackageDigest
        && receipt.comparePackageDigest === value.planReceipt.comparePackageDigest
        && /^[a-f0-9]{64}$/u.test(receipt.contentDigest) && /^[a-f0-9]{64}$/u.test(receipt.registryDigest)
        && Array.isArray(metadata.fields) && metadata.fields.length === receipt.fieldCount
        && new Set(metadata.fields.map(field => field.fieldId)).size === metadata.fields.length
        && Array.isArray(receipt.missingAuthorities) && (receipt.status !== 0 || receipt.missingAuthorities.length === 0)
        && long(metadata.timing?.elapsedTicks) && BigInt(metadata.timing.elapsedTicks) >= 0n
        && long(metadata.timing?.frequency, true)
        && metadata.fields.every(field => typeof field.fieldId === 'string' && field.fieldId.length > 0
            && field.beforePackageDigest === receipt.basePackageDigest && field.afterPackageDigest === receipt.comparePackageDigest
            && typeof field.sensitive === 'boolean' && typeof field.authority === 'string'
            && Number.isInteger(field.change) && field.change >= 0 && field.change <= 6
            && typedValue(field.before) && typedValue(field.after));
}

// These are envelope joins, never a second source/metadata diff implementation.
function isBoundResponse(value: ArticleRevisionCompareResponse, request: ArticleRevisionCompareRequest): boolean
{
    const plan = value?.planReceipt;
    const diff = value?.sourceDiff;
    const receipt = diff?.receipt;
    const digest = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/u.test(input);
    const matchesSelector = (reference: ArticleRevisionComparePackageReference | undefined, selector: ArticleRevisionCompareSelector): boolean =>
    {
        if (reference?.sourceKind !== selector.kind || typeof reference.sourceIdentity !== 'string'
            || reference.sourceIdentity.length > 256)
        {
            return false;
        }
        if (selector.kind === 0)
        {
            // Original package reader: draft:{principal}:{exact key}:{revision}:{context digest}.
            // The client joins the selected key and coordinate; it never supplies a principal.
            const identity = /^draft:([1-9]\d*):([\s\S]*):([1-9]\d*):([a-f0-9]{64})$/u.exec(reference.sourceIdentity);
            if (!identity || identity[1].length > 19 || BigInt(identity[1]) > 9223372036854775807n
                || identity[2] !== selector.draftKey || identity[3] !== selector.expectedServerRevision
                || reference.revisionId !== null || reference.revisionNo !== null
                || reference.serverRevision !== selector.expectedServerRevision || reference.documentEpoch !== selector.documentEpoch)
            {
                return false;
            }
        }
        else if (reference.revisionId !== selector.revisionId || !Number.isSafeInteger(reference.revisionNo)
            || reference.revisionNo! <= 0 || reference.revisionNo! > 2147483647
            || reference.serverRevision !== null || reference.documentEpoch !== null
            || reference.sourceIdentity !== `revision:${reference.revisionId}:${reference.revisionNo}`)
        {
            return false;
        }
        return !selector.expectedSourceDigest || reference.sourceDigest === selector.expectedSourceDigest;
    };
    return !!plan && !!diff && !!receipt && plan.status === 0 && diff.status === 0 && diff.isSuccess === true
        && receipt.status === 0 && diff.attemptReceipt?.status === 0
        && [plan.planDigest, plan.budgetDigest, plan.admissionDigest, plan.contentDigest,
            plan.basePackageDigest, plan.comparePackageDigest, plan.permissionScopeDigest,
            plan.metadataSchemaDigest, plan.optionsDigest, receipt.baseSourceDigest,
            receipt.compareSourceDigest, receipt.budgetDigest, receipt.contentDigest, diff.attemptReceipt.contentDigest].every(digest)
        && matchesSelector(plan.basePackageReference, request.base)
        && matchesSelector(plan.comparePackageReference, request.compare)
        && plan.basePackageReference.packageDigest === plan.basePackageDigest
        && plan.comparePackageReference.packageDigest === plan.comparePackageDigest
        && plan.cancellationIdentity === request.cancellationIdentity
        && plan.planDigest === receipt.planDigest
        // The original source engine hashes budgets plus source options; the
        // planner hashes budgets alone. Their domain digests must stay distinct.
        && plan.admissionDigest === receipt.admissionDigest
        && plan.basePackageReference?.sourceDigest === receipt.baseSourceDigest
        && plan.comparePackageReference?.sourceDigest === receipt.compareSourceDigest
        && diff.attemptReceipt.semanticContentDigest === receipt.contentDigest
        && Array.isArray(diff.chunks) && Array.isArray(diff.contextGroups)
        && Array.isArray(diff.baseLines) && Array.isArray(diff.compareLines)
        && Array.isArray(diff.baseHeadings) && Array.isArray(diff.compareHeadings)
        && diff.chunks.length === receipt.chunkCount
        && diff.contextGroups.length === receipt.contextGroupCount;
}

export async function compareArticleRevisionSources(
    articleId: number,
    request: ArticleRevisionCompareRequest,
    config?: ApiRequestConfig
): Promise<ArticleRevisionCompareResponse>
{
    const response = await requestAuthoringBinary<ArticleRevisionCompareResponse>(
        `/articles/${articleId}/revisions/compare`, FrameType.ArticleRevisionCompareResponse,
        config, { method: 'POST', requestFrame: FrameType.ArticleRevisionCompareRequest, request });
    config?.signal?.throwIfAborted();
    if (!isBoundResponse(response, request) || !isBoundMetadata(response, request.options.metadataFieldIds.length > 0))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'ARTICLE_REVISION_COMPARE_RECEIPT_INVALID');
    }
    return response;
}

export async function readArticleRevisionCompareDraftCoordinate(
    articleId: number,
    request: ArticleRevisionCompareDraftCoordinateRequest,
    config?: ApiRequestConfig
): Promise<ArticleRevisionCompareDraftCoordinateResponse>
{
    const response = await requestAuthoringBinary<ArticleRevisionCompareDraftCoordinateResponse>(
        `/articles/${articleId}/revisions/compare/draft-coordinate`, FrameType.ArticleRevisionCompareDraftCoordinateResponse,
        config, { method: 'POST', requestFrame: FrameType.ArticleRevisionCompareDraftCoordinateRequest, request });
    config?.signal?.throwIfAborted();
    if (response?.articleId !== articleId || response.draftKey !== request.draftKey
        || response.serverRevision !== request.expectedServerRevision
        || typeof response.documentEpoch !== 'string' || !response.documentEpoch.trim()
        || typeof response.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(response.sourceDigest))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'ARTICLE_REVISION_COMPARE_DRAFT_COORDINATE_INVALID');
    }
    return response;
}
