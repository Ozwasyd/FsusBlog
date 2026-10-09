/** Read model only. It defines no package schema, transport, permission or executable plan. */
export interface ArticlePackageCandidateReviewSummary
{
    readonly articleCount: number;
    readonly fileCount: number;
    readonly schemaVersion: number;
    readonly canonicalHashVersion: number;
    readonly propertySchemaVersion: number;
    readonly packageBytesDigest: string;
    readonly manifestSemanticDigest: string;
    readonly checksumComponentDigest: string;
}

/** Int64 is supplied as an exact decimal string and must never pass through Number. */
export interface ArticlePackageCandidateReviewTarget
{
    readonly portableArticle: string;
    readonly requiresNewIdentity: boolean;
    readonly requestedTargetArticleId: number | null;
    readonly expectedTargetRevision: string | null;
}

/** Matches the backend projection using the repository's camel-case serialization convention. */
export interface ArticlePackageCandidateReview
{
    readonly candidateStatus: 'finite_bytes_validated';
    readonly summary: ArticlePackageCandidateReviewSummary;
    readonly requestedMode: 'CreateNew' | 'UpdateRequested';
    readonly policyDigest: string;
    readonly createdAtUtc: string;
    readonly expiresAtUtc: string;
    readonly intervalStatus: 'caller_interval_not_started' | 'caller_interval_current' | 'caller_interval_expired';
    readonly planDigest: string;
    readonly pageIndex: number;
    readonly pageSize: number;
    readonly totalTargets: number;
    readonly targets: readonly ArticlePackageCandidateReviewTarget[];
    readonly requiredAuthorities: readonly string[];
    readonly executeDisabled: true;
    readonly executionReasonCode: 'article_package_import_authority_unavailable';
}

/**
 * UI-only read identity. The host must echo this complete request in pageCompletion.
 * It carries no backend execution, validation or permission authority.
 */
export interface ArticlePackageCandidateReviewPageRequest
{
    readonly requestId: string;
    readonly planDigest: string;
    readonly pageIndex: number;
    readonly pageSize: number;
}

/**
 * Host-owned completion, separate from the immutable backend projection.
 * Ready requires an exact digest/pageIndex/pageSize result. Cancelled retains the
 * accepted page. Only the active request can settle; late/duplicate results are ignored.
 * Clear pageCompletion when seeding/replacing review/state. Clear review to reset
 * the same candidate after an error; a bare ready transition never settles a read.
 */
export type ArticlePackageCandidateReviewPageCompletion =
    | {
        readonly request: ArticlePackageCandidateReviewPageRequest;
        readonly status: 'ready';
        readonly review: ArticlePackageCandidateReview;
    }
    | {
        readonly request: ArticlePackageCandidateReviewPageRequest;
        readonly status: 'cancelled' | 'error';
    };
