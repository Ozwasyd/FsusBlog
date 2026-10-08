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

export interface ArticleRevisionCompareResponse {
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

// These are envelope joins, never a second source/metadata diff implementation.
function isBoundResponse(value: ArticleRevisionCompareResponse, request: ArticleRevisionCompareRequest): boolean
{
    const plan = value?.planReceipt;
    const diff = value?.sourceDiff;
    const receipt = diff?.receipt;
    const digest = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/u.test(input);
    const matchesSelector = (reference: ArticleRevisionComparePackageReference | undefined, selector: ArticleRevisionCompareSelector): boolean =>
        !!reference && reference.sourceKind === selector.kind
            && (selector.kind === 0
                ? reference.serverRevision === selector.expectedServerRevision && reference.documentEpoch === selector.documentEpoch
                : reference.revisionId === selector.revisionId)
            && (!selector.expectedSourceDigest || reference.sourceDigest === selector.expectedSourceDigest);
    return !!plan && !!diff && !!receipt && plan.status === 0 && diff.status === 0
        && receipt.status === 0 && diff.attemptReceipt?.status === 0
        && [plan.planDigest, plan.budgetDigest, plan.admissionDigest, plan.contentDigest,
            plan.basePackageDigest, plan.comparePackageDigest, plan.permissionScopeDigest,
            plan.metadataSchemaDigest, plan.optionsDigest, receipt.baseSourceDigest,
            receipt.compareSourceDigest, receipt.contentDigest, diff.attemptReceipt.contentDigest].every(digest)
        && matchesSelector(plan.basePackageReference, request.base)
        && matchesSelector(plan.comparePackageReference, request.compare)
        && plan.basePackageReference.packageDigest === plan.basePackageDigest
        && plan.comparePackageReference.packageDigest === plan.comparePackageDigest
        && plan.cancellationIdentity === request.cancellationIdentity
        && plan.planDigest === receipt.planDigest
        && plan.budgetDigest === receipt.budgetDigest
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
    if (!isBoundResponse(response, request))
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
