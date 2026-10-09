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

/** Host-owned read request; the host must return the same plan digest or replace the review. */
export interface ArticlePackageCandidateReviewPageRequest
{
    readonly planDigest: string;
    readonly pageIndex: number;
    readonly pageSize: number;
}
