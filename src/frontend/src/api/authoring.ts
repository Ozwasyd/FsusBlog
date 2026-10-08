import { AppErrorCode, createAppError } from '@/utils/appError';
import type { BinaryRouteRequest, BinaryTransportRequest } from '@/contracts/binaryTransport';
import { encodeJsonRequest } from '@/codecs/binary/jsonRequestEncoder';
import { requestBinaryJson, requestBinaryOnly } from '@/composition/binaryTransport';
import { getBrowserFp } from '@/utils/fingerprint';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';
import { FSUS_HEADERS } from './contracts';


import type { ArticleMutationResponse, ArticleRightsRequest } from './article';
import type { ApiRequestConfig } from './requestConfig';

export interface ServerDraftSaveRequest {
    draftKey: string;
    articleId: number | null;
    baseRevisionId: string | null;
    title: string;
    content: string;
    summary: string | null;
    coverImageUrl: string | null;
    categoryId: number;
    tagIds: number[];
    clientRevision: string;
    status: number;
    scheduledPublishAt: string | null;
    rights: ArticleRightsRequest;
    expectedServerRevision: number | null;
    warningOverrideReason?: string | null;
}

export interface PluginAdminSummary {
    pluginId: string;
    name: string;
    version: string;
    runtime: 'ts/js' | 'lua' | 'native' | 'wasm';
    installState: string;
    healthState: 'healthy' | 'degraded' | 'quarantined' | 'disabled' | 'failed';
    enabled: boolean;
    installedAtUtc: string;
    updatedAtUtc: string;
    lastErrorCode: string | null;
    activeHookCount: number;
    grantedCapabilityCount: number;
    requestedCapabilityCount: number;
    clusterConsistent: boolean;
}

export interface PluginAdminOverview {
    generatedAtUtc: string;
    currentNodeId: string;
    plugins: PluginAdminSummary[];
}

export interface PluginAdminHook {
    name: string;
    priority: number;
    timeoutMs: number;
    failPolicy: string;
    executionMode: string;
    scope: string;
    idempotent: boolean;
}

export interface PluginAdminCapability {
    name: string;
    risk: 'safe' | 'sensitive' | 'dangerous' | 'trusted';
    granted: boolean;
    requiresAdministratorConfirmation: boolean;
    reason: string;
}

export interface PluginAdminExecutionMetric {
    pluginId: string;
    pluginVersion: string;
    runtime: string;
    hookName: string;
    durationMilliseconds: number;
    success: boolean;
    errorCode: string | null;
    timeout: boolean;
    memoryUsedBytes: number;
    memoryBudgetBytes: number;
    nodeId: string;
    traceId: string;
    failPolicy: string;
    scope: string;
    createdAtUtc: string;
}

export interface PluginAdminLog {
    pluginId: string;
    runtime: string;
    hookName: string;
    nodeId: string;
    traceId: string;
    level: string;
    message: string;
    createdAtUtc: string;
}

export interface PluginAdminError {
    pluginId: string;
    runtime: string;
    hookName: string;
    nodeId: string;
    traceId: string;
    code: string;
    createdAtUtc: string;
}

export interface PluginAdminNodeState {
    nodeId: string;
    memberStatus: string;
    runtimeState: string;
    loaded: boolean;
    registeredHooks: string[];
    lastErrorCode: string | null;
    observedAtUtc: string | null;
}

export interface PluginAdminDetail {
    summary: PluginAdminSummary;
    manifest: {
        pluginId: string;
        name: string;
        version: string;
        author: string;
        description: string;
        hostVersionRange: string;
        runtime: string;
        runtimeEntry: string;
        requestedCapabilities: string[];
        deniedRawPermissions: string[];
        hooks: PluginAdminHook[];
    };
    permissions: PluginAdminCapability[];
    config: {
        version: number;
        schema: Record<string, unknown>;
        value: Record<string, unknown>;
        updatedAtUtc: string;
        reloadState: string;
    };
    metrics: {
        executionCount: number;
        successCount: number;
        errorCount: number;
        timeoutCount: number;
        permissionDeniedCount: number;
        quarantineCount: number;
        runtimeLoadCount: number;
        runtimeLoadFailureCount: number;
        averageDurationMilliseconds: number;
        maximumDurationMilliseconds: number;
    };
    recentExecutions: PluginAdminExecutionMetric[];
    recentLogs: PluginAdminLog[];
    recentErrors: PluginAdminError[];
    nodes: PluginAdminNodeState[];
}

export interface PluginAdminMutation {
    action: 'grant' | 'revoke' | 'enable' | 'disable' | 'reload' | 'quarantine' | 'restore' | 'uninstall' | 'update-config';
    capabilities?: string[];
    confirmed?: boolean;
    expectedConfigVersion?: number;
    config?: Record<string, unknown>;
}

export interface ServerDraftResponse {
    draftKey: string;
    articleId: number | null;
    baseRevisionId: string | null;
    title: string;
    content: string;
    summary: string | null;
    coverImageUrl: string | null;
    categoryId: number;
    tagIds: number[];
    clientRevision: string | null;
    status: number;
    scheduledPublishAt: string | null;
    rights: ArticleRightsRequest;
    updatedAt: string;
    serverRevision: number;
}

export interface ArticleRevisionSummaryResponse {
    id: string;
    articleId: number;
    revisionNo: number;
    title: string;
    diffSummary: string;
    createdByAdminPrincipalId: string;
    createdAt: string;
    rollbackSourceRevisionId: string | null;
    rollbackReason: string | null;
}

export interface ArticleRevisionRightsSnapshotResponse {
    id: string;
    enabled: boolean;
    licenseType: string;
    copyrightHolder: string | null;
    copyrightYear: number | null;
    rightsStatement: string | null;
    attributionTemplate: string | null;
    copyPolicy: string;
    maxExcerptChars: number;
    allowCodeCopy: boolean;
    showPublicBadge: boolean;
    proofBindingEnabled: boolean;
    policyHash: string;
    contentCanonicalHash: string;
    createdAt: string;
}

export interface ArticleRevisionResponsibilitySnapshotResponse {
    id: string;
    responsibilityVersion: number;
    previousSnapshotId: string | null;
    inheritSiteAuthor: boolean;
    authors: ArticleResponsiblePerson[];
    reviewer: ArticleResponsiblePerson | null;
    sources: ArticleEvidenceSource[];
    updateSummary: string | null;
    updateReason: string | null;
    effectiveAt: string | null;
    conclusionImpact: string | null;
    methodology: string | null;
    applicability: string | null;
    limitations: string | null;
    responsiblePersonConfirmed: boolean;
    createdAt: string;
}

export interface ArticleRevisionReleaseResponse {
    id: string;
    publicationNo: number;
    transitionKind: string;
    publishedAt: string;
}

export interface ArticleRevisionDetailResponse extends ArticleRevisionSummaryResponse {
    content: string;
    summary: string | null;
    coverImageUrl: string | null;
    categoryId: number;
    tagIds: number[];
    packageComplete: boolean;
    rights: ArticleRevisionRightsSnapshotResponse | null;
    responsibility: ArticleRevisionResponsibilitySnapshotResponse | null;
    release: ArticleRevisionReleaseResponse | null;
}

export interface ArticleRevisionRollbackRequest {
    baseRevisionId: string;
    targetStatus: 0 | 2 | 3;
    reason: string;
}

export interface ArticleResponsiblePerson {
    name: string;
    profileUrl: string | null;
}

export interface ArticleEvidenceSource {
    title: string;
    url: string;
    sourceType: string;
    accessedOn: string | null;
    version: string | null;
    citationNote: string | null;
    isPublic?: boolean;
}

export interface ArticleResponsibilityDraft {
    inheritSiteAuthor: boolean;
    authors: ArticleResponsiblePerson[];
    reviewer: ArticleResponsiblePerson | null;
    sources: ArticleEvidenceSource[];
    updateSummary: string | null;
    updateReason: string | null;
    effectiveAt: string | null;
    conclusionImpact: 'none' | 'clarified' | 'changed' | 'unknown' | null;
    methodology: string | null;
    applicability: string | null;
    limitations: string | null;
    responsiblePersonConfirmed: boolean;
    containsStrongClaims: boolean;
    isSubstantiveUpdate: boolean;
    requiresMethodsDisclosure: boolean;
    expectedVersion: number;
}

export interface ArticleResponsibilitySaveResponse {
    saved: boolean;
    versionConflict: boolean;
    articleId: number;
    articleRevisionId: string;
    revisionNo: number;
    responsibilitySnapshotId: string | null;
    responsibilityVersion: number;
    previousSnapshotId: string | null;
    articlePublicationId: string | null;
    publicationNo: number | null;
    issues: PrepublishIssue[];
}

export interface ArticleResponsibilityVersionResponse extends ArticleRevisionResponsibilitySnapshotResponse {
    articleId: number;
    articleRevisionId: string;
    revisionNo: number;
}

export interface PrepublishIssue {
    severity: string;
    code: string;
    message: string;
}

export interface ArticlePreviewResponse {
    normalizedTitle: string;
    normalizedSummary: string;
    normalizedCoverImageUrl: string | null;
    normalizedMarkdownSource: string;
    plainText: string;
    sourceIdentity: string;
    issues: PrepublishIssue[];
}

const PREVIEW_SOURCE_IDENTITY_PATTERN = /^preview:sha256:[a-f0-9]{64}$/u;
const FORBIDDEN_PREVIEW_PROTOCOL_FIELDS = new Set(['html', 'srcdoc', 'trustedhtml']);

export function normalizePreviewCoverImageUrl(raw: string | null | undefined): string | null
{
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0)
    {
        return null;
    }

    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'))
    {
        return value;
    }

    let uri: URL;
    try
    {
        uri = new URL(value);
    }
    catch
    {
        return null;
    }

    const scheme = uri.protocol.toLowerCase();
    if ((scheme !== 'https:' && scheme !== 'http:') || uri.username !== '' || uri.password !== '')
    {
        return null;
    }

    return value;
}

export function readStructuredArticlePreviewResponse(value: unknown): ArticlePreviewResponse
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'article_preview_payload_invalid');
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
    {
        if (FORBIDDEN_PREVIEW_PROTOCOL_FIELDS.has(key.toLowerCase()))
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'article_preview_html_field_forbidden');
        }
    }

    const sourceIdentity = readPreviewString(record.sourceIdentity, 'sourceIdentity');
    if (!PREVIEW_SOURCE_IDENTITY_PATTERN.test(sourceIdentity))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'article_preview_source_identity_invalid');
    }

    return {
        normalizedTitle: readPreviewString(record.normalizedTitle, 'normalizedTitle'),
        normalizedSummary: readPreviewString(record.normalizedSummary, 'normalizedSummary'),
        normalizedCoverImageUrl: normalizePreviewCoverImageUrl(
            record.normalizedCoverImageUrl == null
                ? null
                : readPreviewString(record.normalizedCoverImageUrl, 'normalizedCoverImageUrl')
        ),
        normalizedMarkdownSource: readPreviewString(
            record.normalizedMarkdownSource,
            'normalizedMarkdownSource'
        ),
        plainText: readPreviewString(record.plainText, 'plainText'),
        sourceIdentity,
        issues: readPreviewIssues(record.issues)
    };
}

function readPreviewString(value: unknown, field: string): string
{
    if (typeof value !== 'string')
    {
        throw createAppError(AppErrorCode.ProtocolFailure, `article_preview_${field}_invalid`);
    }

    return value;
}

function readPreviewIssues(value: unknown): PrepublishIssue[]
{
    if (!Array.isArray(value))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'article_preview_issues_invalid');
    }

    return value.map((item) =>
    {
        if (item === null || typeof item !== 'object' || Array.isArray(item))
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'article_preview_issues_invalid');
        }

        const issue = item as Record<string, unknown>;
        return {
            severity: readPreviewString(issue.severity, 'issueSeverity'),
            code: readPreviewString(issue.code, 'issueCode'),
            message: readPreviewString(issue.message, 'issueMessage')
        };
    });
}

export type ArticlePreviewIdentityInput = Pick<
    ServerDraftSaveRequest,
  'title' | 'content' | 'summary' | 'coverImageUrl'
>;

export async function createArticlePreviewSourceIdentity(
    input: ArticlePreviewIdentityInput
): Promise<string>
{
    const encoder = new TextEncoder();
    const fields = [input.title, input.content, input.summary ?? '', input.coverImageUrl ?? ''];
    const chunks: Uint8Array[] = [encoder.encode('fsusblog.article-preview.v1\0')];
    let length = chunks[0].byteLength;
    for (const field of fields)
    {
        const bytes = encoder.encode(field);
        const prefix = encoder.encode(`${bytes.byteLength}:`);
        chunks.push(prefix, bytes, Uint8Array.of(0));
        length += prefix.byteLength + bytes.byteLength + 1;
    }

    const payload = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks)
    {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', payload));
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    return `preview:sha256:${hex}`;
}

export interface AssetLibraryItemResponse {
    id: string;
    url: string;
    altText: string | null;
    sourceArticleId: number | null;
    referenceCount: number;
    sha256: string | null;
    updatedAt: string;
}

export interface AdminCategoryItemResponse {
    id: number;
    name: string;
    publicArticleCount: number;
    draftArticleCount: number;
    scheduledArticleCount: number;
    archivedArticleCount: number;
    totalBlockingArticleCount: number;
    canDelete: boolean;
}

export interface AdminTagItemResponse {
    id: number;
    name: string;
    publicArticleCount: number;
    draftArticleCount: number;
    scheduledArticleCount: number;
    archivedArticleCount: number;
    deletedArticleCount: number;
    totalBlockingArticleCount: number;
    canDelete: boolean;
}

export interface AuthorAnalyticsMetricResponse {
    label: string;
    count: number;
}

export interface AuthorRumMetricResponse {
    name: string;
    count: number;
    p75: number;
    average: number;
}

export interface AuthorAnalyticsResponse {
    publishedArticles: number;
    draftArticles: number;
    scheduledArticles: number;
    archivedArticles: number;
    totalHumanReadEvents: number;
    totalSearchableArticles: number;
    aotHitRate: number;
    averageDwellMs: number;
    readingCompletionRate: number;
    topSearchKeywords: AuthorAnalyticsMetricResponse[];
    topSourceRoutes: AuthorAnalyticsMetricResponse[];
    notFoundHotspots: AuthorAnalyticsMetricResponse[];
    rumMetrics: AuthorRumMetricResponse[];
    rumPageTypes: AuthorAnalyticsMetricResponse[];
    rumAotSources: AuthorAnalyticsMetricResponse[];
}

export interface AuditLogRuntimeResponse {
    queuedCount: number;
    droppedCount: number;
    writeSuccessCount: number;
    writeFailureCount: number;
    fallbackWriteCount: number;
    lastWriteSuccessUtc: string | null;
    lastWriteFailureUtc: string | null;
    lastFallbackWriteUtc: string | null;
}

export type AuditPiiMode = 'pii-redacted' | 'investigation';

export interface AuditLogItemResponse {
    id: string;
    source: string;
    type: string;
    action: string;
    outcome: string;
    severity: string;
    isHighValue: boolean;
    actorType: string | null;
    actorId: string | null;
    actorRole: string | null;
    targetType: string | null;
    targetId: string | null;
    reasonCode: string | null;
    occurredAtUtc: string;
    eventInfo: string;
    traceId: string | null;
    requestPath: string | null;
    requestMethod: string | null;
    ipHash: string | null;
    userAgentHash: string | null;
    sessionIdHash: string | null;
    deviceFingerprintHash: string | null;
    chainId: string | null;
    prevHash: string | null;
    recordHash: string | null;
    recordMac: string | null;
    piiMode: AuditPiiMode;
}

export interface AuditLogListResponse {
    items: AuditLogItemResponse[];
    total: number;
    page: number;
    pageSize: number;
    nextCursor?: string | null;
    runtime: AuditLogRuntimeResponse;
}

export interface AuditLogDetailResponse {
    item: AuditLogItemResponse;
    contextJson: string | null;
    tamperEvidenceValid: boolean;
}

export interface AuditFacetResponse {
    value: string;
    count: number;
}

export interface AuditLogSummaryResponse {
    total: number;
    sources: AuditFacetResponse[];
    actions: AuditFacetResponse[];
    outcomes: AuditFacetResponse[];
    severities: AuditFacetResponse[];
    runtime: AuditLogRuntimeResponse;
}

export interface AuditTamperVerifyResponse {
    id: string;
    valid: boolean;
    recordHash: string | null;
    recordMac: string | null;
    chainId: string | null;
}

export interface AdminMetricResponse {
    key: string;
    value: unknown;
}

export interface AdminServiceStatusResponse {
    key: string;
    label: string;
    status: string;
    detail: string | null;
    updatedAt: string | null;
    metrics: AdminMetricResponse[];
}

export interface BackupArtifactResponse {
    kind: string;
    status: string;
    path: string | null;
    updatedAt: string | null;
    sizeBytes: number | null;
    detail: string | null;
}

export interface BackupStatusResponse {
    status: string;
    checkedAt: string;
    backupRoot: string;
    artifacts: BackupArtifactResponse[];
    restoreDrillCommand: string;
    restoreCommand: string;
}

export interface QueueBacklogResponse {
    articleMutationPending: number;
    articleMutationFailed: number;
    auditQueued: number;
    auditDropped: number;
}

export interface RecentOpsErrorResponse {
    occurredAt: string;
    severity: string;
    action: string;
    message: string;
    detail: string | null;
    count: number;
}

export interface OpsHealthResponse {
    status: string;
    checkedAt: string;
    environment: string;
    releaseIdentity: OpsReleaseIdentityResponse;
    services: AdminServiceStatusResponse[];
    workers: AdminServiceStatusResponse[];
    queueBacklog: QueueBacklogResponse;
    backup: BackupStatusResponse;
    recentErrors: RecentOpsErrorResponse[];
}

export interface OpsReleaseIdentityResponse {
    releaseId: string;
    commitSha: string;
    releaseSlot: string;
}

export interface AotDiagnosticsResponse {
    status: string;
    version: number;
    lastBuildAt: string | null;
    lastBuildStatus: string | null;
    lastBuildReason: string | null;
    lastError: string | null;
    stalePageCount: number;
    invalidationVersion: number;
    trackedInvalidationKeys: number;
}

export interface SearchIndexDiagnosticsResponse {
    status: string;
    version: string | null;
    lastUpdatedAt: string | null;
    schemaVersion: number;
    shardCount: number;
    manifestExists: boolean;
    manifestPath: string;
    lastError: string | null;
}

export interface DistributionDiagnosticsResponse {
    status: string;
    checkedAt: string;
    sitemapUrlCount: number;
    feedItemCount: number;
    sitemapUpdatedAt: string | null;
    feedUpdatedAt: string | null;
    lastError: string | null;
}

export interface CacheInvalidationRuntimeSnapshot {
    articleMutationCount: number;
    seoCount: number;
    systemPageCount: number;
    categoryTagCount: number;
    commentMutationCount: number;
    statsCount: number;
    articleViewCount: number;
    hotArticlesCount: number;
    lastInvalidatedAt: string | null;
    lastKind: string | null;
    lastDetail: string | null;
}

export interface OutputCacheDiagnosticsResponse {
    status: string;
    enabled: boolean;
    tags: string[];
    detail: string;
}

export interface HotStatsInvalidationSnapshot {
    hotArticlesVersion: number;
    statsDirtyCount: number;
    statsFlushCount: number;
    statsCoalescedDirtyCount: number;
    hotArticlesDirtyCount: number;
    hotArticlesFlushCount: number;
    hotArticlesCoalescedDirtyCount: number;
    statsDirty: boolean;
    hotArticlesDirty: boolean;
    lastDirtyAt: string | null;
    lastFlushAt: string | null;
    lastDirtyReason: string | null;
    lastFlushReason: string | null;
}

export interface PublicHotReadHitRateReceipt {
    counterMode: string;
    sampleRate: number;
    hitAccounting: string;
    missAccounting: string;
    observedHitSamples: number;
    calibratedHits: number;
    exactMisses: number;
    capacityHitRate: number | null;
    formulaId: string;
    withheldReason: string | null;
}

export interface PublicHotReadCounterSnapshot {
    articleHit: number;
    articleMiss: number;
    listHit: number;
    listMiss: number;
    htmlHit: number;
    htmlMiss: number;
    rejected: number;
    bytes: number;
    hitRate?: PublicHotReadHitRateReceipt;
}

export interface ArticleCacheDiagnosisResponse {
    articleId: number;
    publiclyVisible: boolean;
    articleFrameReady: boolean;
    htmlFrameReady: boolean;
    searchEligible: boolean;
    sitemapEligible: boolean;
    detail: string;
}

export interface CacheDiagnosticsResponse {
    status: string;
    checkedAt: string;
    aot: AotDiagnosticsResponse;
    search: SearchIndexDiagnosticsResponse;
    distribution: DistributionDiagnosticsResponse;
    commentCache: CacheInvalidationRuntimeSnapshot;
    hotStatsInvalidation: HotStatsInvalidationSnapshot;
    outputCache: OutputCacheDiagnosticsResponse;
    publicHotReadCounters: PublicHotReadCounterSnapshot;
    article: ArticleCacheDiagnosisResponse | null;
}

export interface AdminCacheActionRequest {
    action: string;
    articleId?: number | null;
}

export interface AdminCacheActionResponse {
    action: string;
    status: string;
    detail: string;
    completedAt: string;
}

export interface AdminDiffResponse {
    field: string;
    before: string;
    after: string;
}

export interface IntegrityCheckResponse {
    code: string;
    title: string;
    status: string;
    severity: string;
    count: number;
    autoFixAvailable: boolean;
    detail: string;
    sampleKeys: string[];
    previewDiffs: AdminDiffResponse[];
}

export interface IntegrityReportResponse {
    status: string;
    checkedAt: string;
    checkCount: number;
    issueCount: number;
    checks: IntegrityCheckResponse[];
}

export interface IntegrityFixPreviewResponse {
    status: string;
    checkedAt: string;
    diffs: AdminDiffResponse[];
    confirmationLevel: string;
    auditAction: string;
}

export interface IntegrityFixRequest {
    codes?: string[] | null;
    confirmPhrase: string;
}

export interface IntegrityFixResponse {
    status: string;
    appliedAt: string;
    appliedCount: number;
    diffs: AdminDiffResponse[];
}

export interface DangerousOperationRuleResponse {
    level: string;
    interaction: string;
    examples: string[];
}

export interface DangerousOperationPolicyResponse {
    rules: DangerousOperationRuleResponse[];
    diffRequiredOperations: string[];
    mfaRequiredOperations: string[];
    strategyVersion: string;
}

export interface AuditLogQueryParams {
    page?: number;
    pageSize?: number;
    source?: string | null;
    type?: string | null;
    actor?: string | null;
    action?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    outcome?: string | null;
    severity?: string | null;
    fromUtc?: string | null;
    toUtc?: string | null;
    cursor?: string | null;
    piiMode?: AuditPiiMode | null;
}

export const CommentModerationStatus = {
    Pending: 0,
    Approved: 1,
    Rejected: 2,
    Hidden: 3
} as const;

export type CommentModerationStatus =
    (typeof CommentModerationStatus)[keyof typeof CommentModerationStatus];

export interface CommentModerationModelSignalResponse {
    provider: string;
    model: string;
    contractVersion: string;
    label: string;
    confidence: number;
    severity: string;
    primaryReason: string | null;
    needsSecondRound: boolean;
    riskCategories: string[];
    evidenceJson: string | null;
    rawReason: string | null;
    latencyMs: number;
    status: string;
    errorCode: string | null;
    thresholdProfile: string | null;
    createdAtUtc: string;
}

export interface CommentModerationItemResponse {
    id: string;
    articleId: number;
    articleTitle: string;
    authorMode?: string | null;
    authorDisplayName?: string | null;
    displayLanguage?: string | null;
    anonymousScope?: string | null;
    rateClass?: string | null;
    requiresModeration?: boolean | null;
    riskLabels?: string[] | null;
    nullifierHash?: string | null;
    nullifierStatusLabel?: string | null;
    anonymousCredentialId?: string | null;
    canBlockAnonymousNullifier?: boolean | null;
    canRevokeAnonymousCredential?: boolean | null;
    content: string;
    createTime: string;
    status: CommentModerationStatus;
    reason: string | null;
    moderatedByAdminPrincipalId: number | null;
    moderatedAt: string | null;
    autoModerated: boolean;
    moderationActor: string;
    hitReasons: string[];
    submitRegion: string | null;
    submitRegionConfidence: number | null;
    blockedRegions: string[];
    regionPolicyVersion: string | null;
    regionDecisionReason: string | null;
    regionCanPublish: boolean;
    regionRequiresManualReview: boolean;
    regionHideUntilReviewed: boolean;
    modelSignals: CommentModerationModelSignalResponse[];
    modelLabel: string | null;
    modelConfidence: number | null;
    modelPrimaryReason: string | null;
    modelProvider: string | null;
    modelUnavailable: boolean;
}

export interface CommentModerationQueueResponse {
    items: CommentModerationItemResponse[];
    pendingCount: number;
    rejectedCount: number;
    hiddenCount: number;
    nextCursor: string | null;
    leases: CommentModerationQueueLeaseResponse[];
}

export interface CommentModerationQueueLeaseResponse {
    commentId: string;
    commentRowVersion: string;
    appealPriority: number;
    riskScore: number;
    waitingSinceUtc: string;
    ownerAdminPrincipalId: number | null;
    state: string | null;
    claimedAtUtc: string | null;
    leaseExpiresAtUtc: string | null;
    processSlaDueAtUtc: string | null;
    note: string | null;
    escalationStatus: string | null;
    claimGeneration: number | null;
    claimRowVersion: string | null;
}

export interface CommentModerationClaimRequest {
    leaseSeconds?: number;
    processSlaSeconds?: number;
    note?: string | null;
    escalationStatus?: 'none' | 'watch' | 'escalated';
}

export interface CommentModerationClaimMutationRequest {
    claimToken: string;
    claimGeneration: number;
    claimRowVersion: string;
    leaseSeconds?: number;
}

export interface CommentModerationClaimResponse {
    applied: boolean;
    code: string;
    commentId: string;
    commentRowVersion: string | null;
    claimToken: string | null;
    ownerAdminPrincipalId: number | null;
    state: string | null;
    claimedAtUtc: string | null;
    leaseExpiresAtUtc: string | null;
    processSlaDueAtUtc: string | null;
    note: string | null;
    escalationStatus: string | null;
    claimGeneration: number | null;
    claimRowVersion: string | null;
}

export interface CommentModerationRequest {
    status: CommentModerationStatus;
    reason: string | null;
    banUser?: boolean;
    expectedStatus?: CommentModerationStatus;
    commentRowVersion?: string;
    claimToken?: string;
    claimGeneration?: number;
    claimRowVersion?: string;
}

export interface CommentModerationDecisionPrecondition {
    commentId: string;
    expectedStatus: CommentModerationStatus;
    commentRowVersion: string;
    claimToken: string;
    claimGeneration: number;
    claimRowVersion: string;
}

export interface CommentModerationBulkRequest {
    commentIds: string[];
    status: CommentModerationStatus;
    reason: string | null;
    banUsers?: boolean;
    preconditions?: CommentModerationDecisionPrecondition[];
}

export interface CommentModerationBulkResponse {
    updated: number;
    bannedUsers: number;
    conflicts: string[] | null;
}

export interface AnonymousNullifierBlockRequest {
    nullifierHash: string;
    scope: string;
    reason: string | null;
}

export interface AnonymousCredentialRevokeRequest {
    reason: string | null;
}

export interface AnonymousGovernanceActionResponse {
    applied: boolean;
}

export interface AnonymousCommentPolicyResponse {
    anonymousCommentsEnabled: boolean;
    publicCommentsEnabled: boolean;
    zkAnonymousEnabled: boolean;
    defaultAuthorMode: 'public' | 'zk_anonymous';
    supportedDisplayLanguages: string[];
    commentMaxChars: number;
    commentMaxUtf8Bytes: number;
    snapshotHash: string;
    changedBy?: string | null;
    reason?: string | null;
    updatedAtUtc?: string | null;
}

export interface AnonymousCommentPolicyUpdateRequest {
    anonymousCommentsEnabled?: boolean | null;
    publicCommentsEnabled?: boolean | null;
    zkAnonymousEnabled?: boolean | null;
    defaultAuthorMode?: 'public' | 'zk_anonymous' | null;
    supportedDisplayLanguages?: string[] | null;
    commentMaxChars?: number | null;
    commentMaxUtf8Bytes?: number | null;
    reason?: string | null;
}

export interface EffectiveArticleCommentPolicyResponse {
    articleId: number;
    enabled: boolean;
    publicCommentsEnabled: boolean;
    anonymousCommentsEnabled: boolean;
    moderationMode: 'direct' | 'premoderated' | 'risk_based';
    slowModeSeconds: number;
    closedAtUtc: string | null;
    articlePolicyVersion: number;
    rootCommentId: number | null;
    threadLocked: boolean;
    threadPolicyVersion: number;
    snapshotHash: string;
}

export interface ArticleCommentPolicyUpdateRequest {
    enabled: boolean | null;
    publicCommentsEnabled: boolean | null;
    anonymousCommentsEnabled: boolean | null;
    moderationMode: 'direct' | 'premoderated' | 'risk_based' | null;
    slowModeSeconds: number | null;
    closedAtUtc: string | null;
    expectedPolicyVersion: number;
    reason: string | null;
}

export interface ModerationOverviewResponse {
    pendingCount: number;
    rejectedCount: number;
    hiddenCount: number;
    dictionaryCount: number;
    regionPolicyCount: number;
    mainlandStrictStatus: string;
    dictionaryLastError: string | null;
    modelEnabled: boolean;
    modelProvider: string;
    modelMode: string;
    modelContractVersion: string;
    modelTimeoutMs: number;
}

export interface ModerationDictionaryRuntimeItem {
    dictionaryId: string;
    version: string;
    scope: string;
    region: string | null;
    category: string;
    source: string;
    reviewedBy: string;
    updatedAtUtc: string;
    checksum: string;
    evidencePolicy: string;
    termCount: number;
}

export interface ModerationRegionPolicyRule {
    category: string;
    submitAction: string;
    displayAction: string;
}

export interface ModerationRegionPolicyRuntimeItem {
    region: string;
    version: string;
    inherits: string[];
    dictionaryIds: string[];
    checksum: string;
    ruleCount: number;
    rules: ModerationRegionPolicyRule[];
}

export interface ModerationDictionaryRuntimeSnapshot {
    snapshotId: string;
    version: string;
    checksum: string;
    createdAtUtc: string;
    dictionaries: ModerationDictionaryRuntimeItem[];
    regionPolicies: ModerationRegionPolicyRuntimeItem[];
    lastError: string | null;
}

export interface RegionPolicyCheckResponse {
    code: string;
    label: string;
    status: string;
    detail: string;
}

export interface RegionPolicySummaryResponse {
    region: string;
    version: string;
    inherits: string[];
    dictionaryIds: string[];
    checksum: string;
    ruleCount: number;
    criticalChecks: RegionPolicyCheckResponse[];
}

export interface ModerationModelStatusResponse {
    enabled: boolean;
    provider: string;
    mode: string;
    contractVersion: string;
    timeoutMs: number;
    failOpen: boolean;
    lastSuccessAtUtc: string | null;
    lastErrorCode: string | null;
    lastErrorAtUtc: string | null;
    averageLatencyMs: number;
    p95LatencyMs: number;
}

export interface ModerationDictionaryReloadResponse {
    reloaded: boolean;
    snapshotId: string;
    checksum: string;
    error: string | null;
    reloadedAtUtc: string;
}

export interface ModerationModelRuntimeResponse {
    snapshotId: string;
    enabled: boolean;
    provider: string;
    modelProfile: string;
    thresholdProfile: string;
    contractVersion: string;
    configChecksum: string;
    loadedAtUtc: string;
    loadedBy: string;
    status: string;
    timeoutMs: number;
    failOpen: boolean;
    runtimePath: string | null;
    runtimeChannel: string;
    lastError: string | null;
}

export interface ModerationRuntimeStatusResponse {
    snapshotId: string;
    globalState: string;
    regionStates: Record<string, string>;
    disabledDictionaryIds: string[];
    model: ModerationModelRuntimeResponse;
    changedAtUtc: string;
    changedBy: string;
    reason: string | null;
    expiresAtUtc: string | null;
    lastError: string | null;
}

export interface ModerationRuntimeGlobalStateRequest {
    state: string;
    reason?: string | null;
    expiresAtUtc?: string | null;
}

export interface ModerationRuntimeRegionStateRequest {
    region: string;
    state: string;
    reason?: string | null;
    expiresAtUtc?: string | null;
    confirmPhrase?: string | null;
}

export interface ModerationDictionaryStateRequest {
    reason?: string | null;
    confirmPhrase?: string | null;
}

export interface ModerationModelRuntimeRequest {
    enabled?: boolean | null;
    modelProfile?: string | null;
    thresholdProfile?: string | null;
    reason?: string | null;
}

export interface ModerationRegionDefinition {
    regionCode: string;
    displayName: string;
    parentRegion: string | null;
    primaryGroup: string | null;
    policyTemplate: string | null;
    enabled: boolean;
    builtin: boolean;
    description: string | null;
}

export interface ModerationRegionGroupDefinition {
    groupCode: string;
    displayName: string;
    policyTemplate: string | null;
    builtin: boolean;
    enabled: boolean;
    regions: string[];
    description: string | null;
}

export interface ModerationPolicyTemplateRule {
    category: string;
    submitAction: string;
    displayAction: string;
}

export interface ModerationPolicyTemplateDefinition {
    templateId: string;
    version: string;
    scope: string;
    region: string | null;
    regionGroup: string | null;
    source: string;
    reviewedBy: string;
    reviewedAtUtc: string | null;
    builtin: boolean;
    enabled: boolean;
    notLegalAdvice: boolean;
    description: string;
    checksum: string;
    rules: ModerationPolicyTemplateRule[];
}

export interface ModerationEffectivePolicyStep {
    step: string;
    sourceId: string;
    sourceType: string;
    rules: ModerationPolicyTemplateRule[];
}

export interface ModerationEffectivePolicyRule {
    category: string;
    submitAction: string;
    displayAction: string;
    sourceId: string;
    sourceType: string;
}

export interface ModerationEffectivePolicyPreview {
    region: string;
    displayName: string;
    regionGroups: string[];
    inheritance: ModerationEffectivePolicyStep[];
    rules: ModerationEffectivePolicyRule[];
    checksum: string;
    warnings: string[];
}

export interface ModerationEffectivePolicyPreviewRequest {
    regionCode: string;
    operatorOverrides?: ModerationPolicyTemplateRule[] | null;
}

export interface ModerationReplayPreviewRequest {
    region?: string | null;
    policyVersion?: string | null;
    dictionaryId?: string | null;
    limit?: number | null;
}

export interface ModerationReplayPreviewItemResponse {
    commentId: number;
    previousPolicyVersion: string;
    nextPolicyVersion: string;
    addedBlockedRegions: string[];
    removedBlockedRegions: string[];
    addedRiskLabels: string[];
    removedRiskLabels: string[];
    publishabilityChanged: boolean;
    manualReviewChanged: boolean;
    publicVisibilityChanged: boolean;
}

export interface ModerationReplayPreviewResponse {
    region: string | null;
    policyVersion: string | null;
    dictionaryId: string | null;
    scannedCount: number;
    affectedCommentCount: number;
    addedBlockedRegionCount: number;
    removedBlockedRegionCount: number;
    addedRiskLabelCount: number;
    removedRiskLabelCount: number;
    publishabilityChangedCount: number;
    manualReviewChangedCount: number;
    publicVisibilityChangedCount: number;
    highRiskChangeCount: number;
    items: ModerationReplayPreviewItemResponse[];
}

export interface ContentRevisionExportResponse {
    revisionNo: number;
    title: string;
    content: string;
    summary: string | null;
    coverImageUrl: string | null;
    categoryId: number;
    tagIds: number[];
    diffSummary: string;
    createdAt: string;
}

export interface ContentExportMetadataResponse {
    sourceArticleId: number | null;
    categoryId: number;
    tagIds: number[];
    status: number;
    scheduledPublishAt: string | null;
    coverImageUrl: string | null;
    revisionCount: number;
    revisions: ContentRevisionExportResponse[];
}

export interface ContentExportResponse {
    fileName: string;
    markdownWithFrontmatter: string;
    metadata: ContentExportMetadataResponse;
}

export interface ContentBackupExportResponse {
    fileName: string;
    exportedAt: string;
    articles: ContentExportResponse[];
}

export interface ContentImportRequest {
    markdownWithFrontmatter: string;
    publish: boolean;
    preserveRevisions?: boolean;
}

export interface ContentImportResponse {
    articleId: number;
    restoredRevisionCount: number;
}

export interface PrepublishCheckResponse {
    canPublish: boolean;
    issues: PrepublishIssue[];
}

export interface AiAssistRequest {
    title: string;
    content: string;
    locale?: string | null;
    operation?: string | null;
}

export interface AiAssistResponse {
    providerEnabled: boolean;
    providerMode: string;
    externalProviderAllowed: boolean;
    auditEvent: string;
    suggestedSummary: string;
    suggestedTags: string[];
    titleCandidates: string[];
    translationDraft: string;
    structureIssues: PrepublishIssue[];
}

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof';

interface AuthoringBinaryRequestOptions {
    requestFrame?: FrameType;
    request?: unknown;
    headers?: Record<string, string>;
}

const authoringHeaders = (mfaProofToken?: string | null): Headers =>
{
    const headers = new Headers();
    headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp());
    const proofToken = mfaProofToken?.trim();
    if (proofToken)
    {
        headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken);
    }

    return headers;
};

function authoringBody(frameType: FrameType, request: unknown): ArrayBuffer
{
    return encodeAedsFrame(frameType, encodeJsonRequest(request));
}

export function requestAuthoringBinary<T>(
    binaryRoute: BinaryRouteRequest,
    frameType: FrameType,
    config?: ApiRequestConfig,
    options: AuthoringBinaryRequestOptions = {}
): Promise<T>
{
    const requestOptions: NonNullable<BinaryTransportRequest['requestOptions']> = {
        headers: authoringHeaders(config?.mfaProofToken)
    };
    for (const [name, value] of Object.entries(options.headers ?? {}))
    {
        ;(requestOptions.headers as Headers).set(name, value);
    }
    if (options.requestFrame !== undefined)
    {
        requestOptions.body = authoringBody(options.requestFrame, options.request);
    }

    return requestBinaryOnly<T>({
        binaryRoute,
        frameType,
        requestOptions,
        signal: config?.signal
    });
}

async function requestAuthoringJson<T>(
    binaryRoute: BinaryRouteRequest,
    frameType: FrameType,
    config?: ApiRequestConfig,
    options: AuthoringBinaryRequestOptions = {}
): Promise<T>
{
    return requestBinaryJson<T>({
        binaryRoute,
        frameType,
        signal: config?.signal,
        requestOptions: {
            headers: authoringHeaders(config?.mfaProofToken),
            ...(options.requestFrame === undefined ? {} : { body: authoringBody(options.requestFrame, options.request) })
        }
    });
}

export async function saveServerDraft(
    draft: ServerDraftSaveRequest,
    config?: ApiRequestConfig
): Promise<ServerDraftResponse>
{
    return requestAuthoringBinary<ServerDraftResponse>({ operationId: 'binary_post_author_drafts' }, FrameType.AuthorDraftResponse, config, {
        requestFrame: FrameType.AuthorDraftSaveRequest,
        request: draft
    });
}

export async function getServerDraft(draftKey: string, config?: ApiRequestConfig): Promise<ServerDraftResponse | null>
{
    return requestAuthoringBinary<ServerDraftResponse | null>({ operationId: 'binary_get_author_drafts_draftKey', params: { draftKey } }, FrameType.AuthorDraftResponse, config);
}

export async function discardServerDraft(
    draftKey: string,
    expectedServerRevision: number,
    config?: ApiRequestConfig
): Promise<boolean>
{
    const query = new URLSearchParams({ expectedServerRevision: expectedServerRevision.toString() });
    const result = await requestAuthoringBinary<{ discarded?: boolean; }>({ operationId: 'binary_delete_author_drafts_draftKey', params: { draftKey }, query: query }, FrameType.AuthorDraftDiscardResponse, config, {
    });
    return result.discarded === true;
}

export async function previewArticleDraft(
    draft: ServerDraftSaveRequest,
    config?: ApiRequestConfig
): Promise<ArticlePreviewResponse>
{
    const preview = await requestAuthoringBinary<unknown>({ operationId: 'binary_post_author_preview' }, FrameType.ArticlePreviewResponse, config, {
        requestFrame: FrameType.ArticlePreviewRequest,
        request: draft
    });
    return readStructuredArticlePreviewResponse(preview);
}

export async function checkArticlePrepublish(
    draft: ServerDraftSaveRequest,
    config?: ApiRequestConfig
): Promise<PrepublishCheckResponse>
{
    return requestAuthoringBinary<PrepublishCheckResponse>({ operationId: 'binary_post_author_prepublish_check' }, FrameType.PrepublishCheckResponse, config, {
        requestFrame: FrameType.PrepublishCheckRequest,
        request: draft
    });
}

export async function generateAiAssist(
    request: AiAssistRequest,
    config?: ApiRequestConfig
): Promise<AiAssistResponse>
{
    return requestAuthoringBinary<AiAssistResponse>({ operationId: 'binary_post_author_ai_assist' }, FrameType.AiAssistResponse, config, {
        requestFrame: FrameType.AiAssistRequest,
        request
    });
}

export async function listAssetLibrary(config?: ApiRequestConfig): Promise<AssetLibraryItemResponse[]>
{
    return requestAuthoringBinary<AssetLibraryItemResponse[]>({ operationId: 'binary_get_author_assets' }, FrameType.AssetLibraryList, config);
}

export async function reindexArticleAssets(
    articleId: number,
    config?: ApiRequestConfig
): Promise<AssetLibraryItemResponse[]>
{
    return requestAuthoringBinary<AssetLibraryItemResponse[]>({ operationId: 'binary_post_author_articles_articleId_int_assets_reindex', params: { articleId } }, FrameType.AssetLibraryList, config, {
    });
}

export async function cleanupOrphanAssets(config?: ApiRequestConfig): Promise<number>
{
    const result = await requestAuthoringBinary<{ deleted?: number; }>({ operationId: 'binary_delete_author_assets_orphans' }, FrameType.AssetCleanupResponse, config, {
    });
    return Number(result.deleted ?? 0);
}

export async function listAdminCategories(config?: ApiRequestConfig): Promise<AdminCategoryItemResponse[]>
{
    return requestAuthoringBinary<AdminCategoryItemResponse[]>({ operationId: 'binary_get_author_taxonomy_categories' }, FrameType.AuthorTaxonomyCategoryList, config);
}

export async function listAdminTags(config?: ApiRequestConfig): Promise<AdminTagItemResponse[]>
{
    return requestAuthoringBinary<AdminTagItemResponse[]>({ operationId: 'binary_get_author_taxonomy_tags' }, FrameType.AuthorTaxonomyTagList, config);
}

export async function getAuthorAnalytics(config?: ApiRequestConfig): Promise<AuthorAnalyticsResponse>
{
    return requestAuthoringBinary<AuthorAnalyticsResponse>({ operationId: 'binary_get_author_analytics' }, FrameType.AuthorAnalytics, config);
}

export async function listAuditLogs(
    params: AuditLogQueryParams,
    config?: ApiRequestConfig
): Promise<AuditLogListResponse>
{
    const search = buildAuditSearch(params);
    return requestAuthoringBinary<AuditLogListResponse>({ operationId: 'binary_get_author_audit', query: search }, FrameType.AuditLogList, config);
}

export async function getAuditLogSummary(
    params: AuditLogQueryParams,
    config?: ApiRequestConfig
): Promise<AuditLogSummaryResponse>
{
    const search = buildAuditSearch(params);
    return requestAuthoringBinary<AuditLogSummaryResponse>({ operationId: 'binary_get_author_audit_summary', query: search }, FrameType.AuditLogSummary, config);
}

export async function getAuditLogDetail(
    id: string,
    piiMode?: AuditPiiMode | null,
    config?: ApiRequestConfig
): Promise<AuditLogDetailResponse>
{
    const search = new URLSearchParams();
    if (piiMode)
    {
        search.set('piiMode', piiMode);
    }
    return requestAuthoringBinary<AuditLogDetailResponse>({ operationId: 'binary_get_author_audit_id_long', params: { id }, query: search }, FrameType.AuditLogDetail, config);
}

export async function verifyAuditLog(id: string, config?: ApiRequestConfig): Promise<AuditTamperVerifyResponse>
{
    return requestAuthoringBinary<AuditTamperVerifyResponse>({ operationId: 'binary_get_author_audit_id_long_verify', params: { id } }, FrameType.AuditTamperVerifyResponse, config);
}

export async function getOpsHealth(config?: ApiRequestConfig): Promise<OpsHealthResponse>
{
    return requestAuthoringBinary<OpsHealthResponse>({ operationId: 'binary_get_author_ops_health' }, FrameType.OpsHealth, config);
}

export async function getBackupStatus(config?: ApiRequestConfig): Promise<BackupStatusResponse>
{
    return requestAuthoringBinary<BackupStatusResponse>({ operationId: 'binary_get_author_ops_backup' }, FrameType.BackupStatus, config);
}

export async function getDangerousOperationPolicy(config?: ApiRequestConfig): Promise<DangerousOperationPolicyResponse>
{
    return requestAuthoringBinary<DangerousOperationPolicyResponse>({ operationId: 'binary_get_author_ops_dangerous_operations_policy' }, FrameType.DangerousOperationPolicy, config);
}

export async function getCacheDiagnostics(articleId?: number | null, config?: ApiRequestConfig): Promise<CacheDiagnosticsResponse>
{
    const search = new URLSearchParams();
    if (articleId && articleId > 0)
    {
        search.set('articleId', String(articleId));
    }

    return requestAuthoringBinary<CacheDiagnosticsResponse>({ operationId: 'binary_get_author_cache_diagnostics', query: search }, FrameType.CacheDiagnostics, config);
}

export async function runCacheAction(
    request: AdminCacheActionRequest,
    config?: ApiRequestConfig
): Promise<AdminCacheActionResponse>
{
    return requestAuthoringBinary<AdminCacheActionResponse>({ operationId: 'binary_post_author_cache_actions' }, FrameType.AdminCacheActionResponse, config, {
        requestFrame: FrameType.AdminCacheActionRequest,
        request
    });
}

export async function inspectIntegrity(config?: ApiRequestConfig): Promise<IntegrityReportResponse>
{
    return requestAuthoringBinary<IntegrityReportResponse>({ operationId: 'binary_get_author_integrity' }, FrameType.IntegrityReport, config);
}

export async function previewIntegrityFix(config?: ApiRequestConfig): Promise<IntegrityFixPreviewResponse>
{
    return requestAuthoringBinary<IntegrityFixPreviewResponse>({ operationId: 'binary_get_author_integrity_fix_preview' }, FrameType.IntegrityFixPreview, config);
}

export async function applyIntegrityFix(
    request: IntegrityFixRequest,
    config?: ApiRequestConfig
): Promise<IntegrityFixResponse>
{
    return requestAuthoringBinary<IntegrityFixResponse>({ operationId: 'binary_post_author_integrity_fix' }, FrameType.IntegrityFixResponse, config, {
        requestFrame: FrameType.IntegrityFixRequest,
        request
    });
}

export async function listPlugins(config?: ApiRequestConfig): Promise<PluginAdminOverview>
{
    return requestAuthoringBinary<PluginAdminOverview>(
        { operationId: 'binary_get_author_plugins' },
        FrameType.PluginAdminSnapshot,
        config
    );
}

export async function getPlugin(
    pluginId: string,
    config?: ApiRequestConfig
): Promise<PluginAdminDetail>
{
    return requestAuthoringBinary<PluginAdminDetail>(
        { operationId: 'binary_get_author_plugins_pluginId', params: { pluginId } },
        FrameType.PluginAdminSnapshot,
        config
    );
}

export async function installPlugin(
    file: File,
    config?: ApiRequestConfig
): Promise<PluginAdminDetail>
{
    const packageBytes = new Uint8Array(await file.arrayBuffer());
    const headers = authoringHeaders(config?.mfaProofToken);
    headers.set('X-Fsus-Plugin-Confirm', 'install');
    return requestBinaryOnly<PluginAdminDetail>({
        binaryRoute: { operationId: 'binary_post_author_plugins_install' },
        frameType: FrameType.PluginAdminSnapshot,
        requestOptions: {
            headers,
            body: encodeAedsFrame(FrameType.PluginPackageInstallRequest, packageBytes)
        },
        signal: config?.signal
    });
}

export async function mutatePlugin(
    pluginId: string,
    request: PluginAdminMutation,
    config?: ApiRequestConfig
): Promise<PluginAdminDetail | null>
{
    return requestAuthoringBinary<PluginAdminDetail | null>(
        { operationId: 'binary_post_author_plugins_pluginId_actions', params: { pluginId } },
        FrameType.PluginAdminSnapshot,
        config,
        {
            requestFrame: FrameType.PluginAdminMutationRequest,
            request: {
                capabilities: [],
                confirmed: false,
                expectedConfigVersion: 0,
                ...request
            }
        }
    );
}

export async function listCommentModerationQueue(
    status: CommentModerationStatus = CommentModerationStatus.Pending,
    limit = 50,
    config?: ApiRequestConfig,
    cursor?: string | null
): Promise<CommentModerationQueueResponse>
{
    const search = new URLSearchParams({
        status: String(status),
        limit: String(limit)
    });
    if (cursor)
    {
        search.set('cursor', cursor);
    };
    return requestAuthoringBinary<CommentModerationQueueResponse>({ operationId: 'binary_get_author_comments_moderation', query: search }, FrameType.CommentModerationQueue, config);
}

export async function claimCommentModeration(
    commentId: string,
    request: CommentModerationClaimRequest,
    config?: ApiRequestConfig
): Promise<CommentModerationClaimResponse>
{
    return requestAuthoringBinary<CommentModerationClaimResponse>({ operationId: 'binary_post_author_comments_commentId_long_moderation_claim', params: { commentId } }, FrameType.CommentModerationClaimResponse, config, {
        requestFrame: FrameType.CommentModerationClaimRequest,
        request
    });
}

export async function renewCommentModerationClaim(
    commentId: string,
    request: CommentModerationClaimMutationRequest,
    config?: ApiRequestConfig
): Promise<CommentModerationClaimResponse>
{
    return requestAuthoringBinary<CommentModerationClaimResponse>({ operationId: 'binary_post_author_comments_commentId_long_moderation_claim_renew', params: { commentId } }, FrameType.CommentModerationClaimResponse, config, {
        requestFrame: FrameType.CommentModerationClaimMutationRequest,
        request
    });
}

export async function releaseCommentModerationClaim(
    commentId: string,
    request: CommentModerationClaimMutationRequest,
    config?: ApiRequestConfig
): Promise<CommentModerationClaimResponse>
{
    return requestAuthoringBinary<CommentModerationClaimResponse>({ operationId: 'binary_post_author_comments_commentId_long_moderation_claim_release', params: { commentId } }, FrameType.CommentModerationClaimResponse, config, {
        requestFrame: FrameType.CommentModerationClaimMutationRequest,
        request
    });
}

export async function getModerationOverview(config?: ApiRequestConfig): Promise<ModerationOverviewResponse>
{
    return requestAuthoringBinary<ModerationOverviewResponse>({ operationId: 'binary_get_author_moderation_overview' }, FrameType.ModerationOverview, config);
}

export async function getAnonymousCommentPolicy(config?: ApiRequestConfig): Promise<AnonymousCommentPolicyResponse>
{
    return requestAuthoringJson<AnonymousCommentPolicyResponse>({ operationId: 'binary_get_author_moderation_anonymous_comment_policy' }, FrameType.CommentPolicySnapshot, config);
}

export async function updateAnonymousCommentPolicy(
    request: AnonymousCommentPolicyUpdateRequest,
    config?: ApiRequestConfig
): Promise<AnonymousCommentPolicyResponse>
{
    return requestAuthoringJson<AnonymousCommentPolicyResponse>({ operationId: 'binary_put_author_moderation_anonymous_comment_policy' }, FrameType.CommentPolicySnapshot, config, {
        requestFrame: FrameType.CommentPolicyUpdateRequest,
        request
    });
}

export async function getArticleCommentPolicy(
    articleId: number,
    rootId?: number,
    config?: ApiRequestConfig
): Promise<EffectiveArticleCommentPolicyResponse>
{
    return requestAuthoringJson<EffectiveArticleCommentPolicyResponse>(
        { operationId: 'binary_get_author_moderation_articles_articleId_int_comment_policy', params: { articleId }, query: { rootId } }, FrameType.CommentPolicySnapshot, config);
}

export async function updateArticleCommentPolicy(
    articleId: number,
    request: ArticleCommentPolicyUpdateRequest,
    config?: ApiRequestConfig
): Promise<EffectiveArticleCommentPolicyResponse>
{
    return requestAuthoringJson<EffectiveArticleCommentPolicyResponse>(
        { operationId: 'binary_put_author_moderation_articles_articleId_int_comment_policy', params: { articleId } }, FrameType.CommentPolicySnapshot, config, {
            requestFrame: FrameType.CommentPolicyUpdateRequest, request
        });
}

export async function updateCommentThreadPolicy(
    articleId: number,
    rootId: number,
    request: { locked: boolean; expectedPolicyVersion: number; reason: string | null; },
    config?: ApiRequestConfig
): Promise<EffectiveArticleCommentPolicyResponse>
{
    return requestAuthoringJson<EffectiveArticleCommentPolicyResponse>(
        { operationId: 'binary_put_author_moderation_articles_articleId_int_comment_threads_rootId_long', params: { articleId, rootId } }, FrameType.CommentPolicySnapshot, config, {
            requestFrame: FrameType.CommentPolicyUpdateRequest, request
        });
}

export async function getModerationDictionarySnapshot(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot>
{
    return requestAuthoringBinary<ModerationDictionaryRuntimeSnapshot>({ operationId: 'binary_get_author_moderation_dictionaries' }, FrameType.ModerationDictionarySnapshot, config);
}

export async function reloadModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryReloadResponse>
{
    return requestAuthoringBinary<ModerationDictionaryReloadResponse>({ operationId: 'binary_post_author_moderation_dictionaries_reload' }, FrameType.ModerationDictionaryReloadResponse, config, {
    });
}

export async function rollbackModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot>
{
    return requestAuthoringBinary<ModerationDictionaryRuntimeSnapshot>({ operationId: 'binary_post_author_moderation_dictionaries_rollback' }, FrameType.ModerationDictionarySnapshot, config, {
    });
}

export async function enableModerationDictionary(
    dictionaryId: string,
    request: ModerationDictionaryStateRequest = {},
    config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_dictionaries_dictionaryId_enable', params: { dictionaryId } }, FrameType.ModerationRuntimeStatus, config, {
        requestFrame: FrameType.ModerationDictionaryStateRequest,
        request
    });
}

export async function disableModerationDictionary(
    dictionaryId: string,
    request: ModerationDictionaryStateRequest = {},
    config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_dictionaries_dictionaryId_disable', params: { dictionaryId } }, FrameType.ModerationRuntimeStatus, config, {
        requestFrame: FrameType.ModerationDictionaryStateRequest,
        request
    });
}

export async function getModerationRuntimeStatus(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_get_author_moderation_runtime_status' }, FrameType.ModerationRuntimeStatus, config);
}

export async function setModerationGlobalState(
    request: ModerationRuntimeGlobalStateRequest,
    config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_runtime_global_state' }, FrameType.ModerationRuntimeStatus, config, {
        requestFrame: FrameType.ModerationRuntimeGlobalStateRequest,
        request
    });
}

export async function setModerationRegionState(
    request: ModerationRuntimeRegionStateRequest,
    config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_runtime_region_state' }, FrameType.ModerationRuntimeStatus, config, {
        requestFrame: FrameType.ModerationRuntimeRegionStateRequest,
        request
    });
}

export async function listModerationRegions(config?: ApiRequestConfig): Promise<ModerationRegionDefinition[]>
{
    return requestAuthoringBinary<ModerationRegionDefinition[]>({ operationId: 'binary_get_author_moderation_regions' }, FrameType.ModerationRegionList, config);
}

export async function listModerationRegionGroups(config?: ApiRequestConfig): Promise<ModerationRegionGroupDefinition[]>
{
    return requestAuthoringBinary<ModerationRegionGroupDefinition[]>({ operationId: 'binary_get_author_moderation_region_groups' }, FrameType.ModerationRegionGroupList, config);
}

export async function listModerationPolicyTemplates(config?: ApiRequestConfig): Promise<ModerationPolicyTemplateDefinition[]>
{
    return requestAuthoringBinary<ModerationPolicyTemplateDefinition[]>({ operationId: 'binary_get_author_moderation_policy_templates' }, FrameType.ModerationPolicyTemplateList, config);
}

export async function getModerationEffectivePolicy(
    regionCode: string,
    config?: ApiRequestConfig
): Promise<ModerationEffectivePolicyPreview>
{
    return requestAuthoringBinary<ModerationEffectivePolicyPreview>({ operationId: 'binary_get_author_moderation_effective_policy_regionCode', params: { regionCode } }, FrameType.ModerationEffectivePolicy, config);
}

export async function previewModerationEffectivePolicy(
    request: ModerationEffectivePolicyPreviewRequest,
    config?: ApiRequestConfig
): Promise<ModerationEffectivePolicyPreview>
{
    return requestAuthoringBinary<ModerationEffectivePolicyPreview>({ operationId: 'binary_post_author_moderation_effective_policy_preview' }, FrameType.ModerationEffectivePolicy, config, {
        requestFrame: FrameType.ModerationEffectivePolicyPreviewRequest,
        request
    });
}

export async function listModerationPolicies(config?: ApiRequestConfig): Promise<RegionPolicySummaryResponse[]>
{
    return requestAuthoringBinary<RegionPolicySummaryResponse[]>({ operationId: 'binary_get_author_moderation_policies' }, FrameType.RegionPolicySummaryList, config);
}

export async function getModerationModelStatus(config?: ApiRequestConfig): Promise<ModerationModelStatusResponse>
{
    return requestAuthoringBinary<ModerationModelStatusResponse>({ operationId: 'binary_get_author_moderation_model_status' }, FrameType.ModerationModelStatus, config);
}

export async function setModerationModelRuntime(
    request: ModerationModelRuntimeRequest,
    config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_model_runtime' }, FrameType.ModerationRuntimeStatus, config, {
        requestFrame: FrameType.ModerationModelRuntimeRequest,
        request
    });
}

export async function reloadModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_model_reload' }, FrameType.ModerationRuntimeStatus, config, {
    });
}

export async function rollbackModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse>
{
    return requestAuthoringBinary<ModerationRuntimeStatusResponse>({ operationId: 'binary_post_author_moderation_model_rollback' }, FrameType.ModerationRuntimeStatus, config, {
    });
}

export async function previewModerationReplay(
    request: ModerationReplayPreviewRequest,
    config?: ApiRequestConfig
): Promise<ModerationReplayPreviewResponse>
{
    return requestAuthoringBinary<ModerationReplayPreviewResponse>({ operationId: 'binary_post_author_moderation_replay_preview' }, FrameType.ModerationReplayPreview, config, {
        requestFrame: FrameType.ModerationReplayPreviewRequest,
        request
    });
}

export async function moderateComment(
    commentId: string,
    request: CommentModerationRequest,
    config?: ApiRequestConfig
): Promise<boolean>
{
    const result = await requestAuthoringBinary<{ moderated?: boolean; }>({ operationId: 'binary_post_author_comments_commentId_long_moderation', params: { commentId } }, FrameType.CommentModerationResult, config, {
        requestFrame: FrameType.CommentModerationRequest,
        request
    });
    return result.moderated === true;
}

export async function moderateCommentsBulk(
    request: CommentModerationBulkRequest,
    config?: ApiRequestConfig
): Promise<CommentModerationBulkResponse>
{
    return requestAuthoringBinary<CommentModerationBulkResponse>({ operationId: 'binary_post_author_comments_moderation_bulk' }, FrameType.CommentModerationBulkResponse, config, {
        requestFrame: FrameType.CommentModerationBulkRequest,
        request
    });
}

export async function blockAnonymousNullifier(
    request: AnonymousNullifierBlockRequest,
    config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse>
{
    return requestAuthoringBinary<AnonymousGovernanceActionResponse>({ operationId: 'binary_post_author_comments_moderation_nullifiers_block' }, FrameType.AnonymousGovernanceActionResponse, config, {
        requestFrame: FrameType.AnonymousGovernanceActionRequest,
        request
    });
}

export async function revokeAnonymousCredential(
    credentialId: string | number,
    request: AnonymousCredentialRevokeRequest,
    config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse>
{
    return requestAuthoringBinary<AnonymousGovernanceActionResponse>({ operationId: 'binary_post_author_comments_moderation_anonymous_credentials_credentialId_revoke', params: { credentialId: String(credentialId) } }, FrameType.AnonymousGovernanceActionResponse, config, {
        requestFrame: FrameType.AnonymousGovernanceActionRequest,
        request
    });
}

export async function exportArticleContent(
    articleId: number,
    config?: ApiRequestConfig
): Promise<ContentExportResponse>
{
    return requestAuthoringBinary<ContentExportResponse>({ operationId: 'binary_get_author_articles_articleId_int_export', params: { articleId } }, FrameType.ContentExport, config);
}

export async function exportContentBackup(config?: ApiRequestConfig): Promise<ContentBackupExportResponse>
{
    return requestAuthoringBinary<ContentBackupExportResponse>({ operationId: 'binary_get_author_content_export' }, FrameType.ContentBackupExport, config);
}

export async function importArticleContent(
    request: ContentImportRequest,
    config?: ApiRequestConfig
): Promise<ContentImportResponse>
{
    return requestAuthoringBinary<ContentImportResponse>({ operationId: 'binary_post_author_articles_import' }, FrameType.ContentImportResponse, config, {
        requestFrame: FrameType.ContentImportRequest,
        request
    });
}

export async function listArticleRevisions(
    articleId: number,
    config?: ApiRequestConfig
): Promise<ArticleRevisionSummaryResponse[]>
{
    return requestAuthoringBinary<ArticleRevisionSummaryResponse[]>({ operationId: 'binary_get_author_articles_articleId_int_revisions', params: { articleId } }, FrameType.ArticleRevisionList, config);
}

export async function getArticleRevision(
    articleId: number,
    revisionId: string,
    config?: ApiRequestConfig
): Promise<ArticleRevisionDetailResponse>
{
    return requestAuthoringBinary<ArticleRevisionDetailResponse>({ operationId: 'binary_get_author_articles_articleId_int_revisions_revisionId_long', params: { articleId, revisionId } }, FrameType.ArticleRevisionDetail, config);
}

export async function rollbackArticleRevision(
    articleId: number,
    revisionId: string,
    request: ArticleRevisionRollbackRequest,
    config?: ApiRequestConfig
): Promise<ArticleMutationResponse>
{
    return requestAuthoringBinary<ArticleMutationResponse>({ operationId: 'binary_post_author_articles_articleId_int_revisions_revisionId_long_rollback', params: { articleId, revisionId } }, FrameType.MutationId, config, {
        requestFrame: FrameType.ArticleRevisionRollbackRequest,
        request
    });
}

export async function saveArticleResponsibility(
    articleId: number,
    revisionId: string,
    request: ArticleResponsibilityDraft,
    config?: ApiRequestConfig
): Promise<ArticleResponsibilitySaveResponse>
{
    return requestAuthoringBinary<ArticleResponsibilitySaveResponse>(
        { operationId: 'binary_put_author_articles_articleId_int_revisions_revisionId_long_responsibility', params: { articleId, revisionId } },
        FrameType.ArticleResponsibilityResponse,
        config,
        {
            requestFrame: FrameType.ArticleResponsibilityRequest,
            request
        }
    );
}

export async function getArticleResponsibilityHistory(
    articleId: number,
    revisionId: string,
    config?: ApiRequestConfig
): Promise<ArticleResponsibilityVersionResponse[]>
{
    return requestAuthoringBinary<ArticleResponsibilityVersionResponse[]>(
        { operationId: 'binary_get_author_articles_articleId_int_revisions_revisionId_long_responsibility', params: { articleId, revisionId } },
        FrameType.ArticleResponsibilityHistory,
        config
    );
}

function buildAuditSearch(params: AuditLogQueryParams): URLSearchParams
{
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
    {
        if (value === undefined || value === null || value === '')
        {
            continue;
        }

        search.set(key, String(value));
    }

    return search;
}
