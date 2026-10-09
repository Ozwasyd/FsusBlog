import type { ArticlePackageCandidateReview } from './articlePackageCandidateReview';

/** Plain observed coordinates, not a signed plan, credential or authority grant. */
export interface ArticlePackageCandidateReadContext
{
    readonly identity: string;
    readonly lifecycleVersion: number;
    readonly generation: number;
    readonly mappingRevision: number;
    readonly scopeRevision: number;
}

/** Mirrors the existing C# typed read DTO; original Int64 hints stay decimal strings. */
export interface ArticlePackageCandidateReadTarget
{
    readonly portableArticle: string;
    readonly requestedTargetArticleId: number;
    readonly expectedTargetRevision: string;
}

/**
 * Typed AEDS JSON-byte payload. archiveBytes is opaque base64 ZIP bytes, never a browser
 * package parser input. Actual closed frame allocation and authenticated I/O belong to
 * the original transport owner. No URL, actor, session or lifecycle intent is accepted.
 */
export interface ArticlePackageCandidateReadIntent
{
    readonly archiveBytes: string;
    readonly requestedMode: 'CreateNew' | 'UpdateRequested';
    readonly callerPolicyDigest: string;
    readonly callerPermissionContextDigest: string;
    readonly createdAtUtc: string;
    readonly expiresAtUtc: string;
    readonly requestedTargets: readonly ArticlePackageCandidateReadTarget[] | null;
    readonly pageSize: number;
}

export interface ArticlePackageCandidateReadRequest extends ArticlePackageCandidateReadIntent
{
    readonly requestId: string;
    readonly pageIndex: number;
    readonly expectedPlanDigest: string | null;
    readonly expectedContext: ArticlePackageCandidateReadContext | null;
}

export interface ArticlePackageCandidateReadResponse
{
    readonly requestId: string;
    readonly review: ArticlePackageCandidateReview;
    readonly context: ArticlePackageCandidateReadContext;
}

/** Required original authenticated typed-frame port; there is no fallback implementation. */
export type ArticlePackageCandidateAuthenticatedRead = (
    request: ArticlePackageCandidateReadRequest,
    signal: AbortSignal
) => Promise<ArticlePackageCandidateReadResponse>;
