import type { ApiRequestConfig } from './requestConfig'
import { FSUS_HEADERS } from './contracts'
import { getBrowserFp } from '@/utils/fingerprint'
import { AppErrorCode, appErrorFromStatus, createAppError } from '@/utils/appError'

export interface ServerDraftSaveRequest {
  draftKey: string
  articleId: number | null
  title: string
  content: string
  summary: string | null
  coverImageUrl: string | null
  categoryId: number
  tagIds: number[]
  clientRevision: string
  status: number
  scheduledPublishAt: string | null
  warningOverrideReason?: string | null
}

export interface ServerDraftResponse {
  draftKey: string
  articleId: number | null
  title: string
  content: string
  summary: string | null
  coverImageUrl: string | null
  categoryId: number
  tagIds: number[]
  clientRevision: string | null
  status: number
  scheduledPublishAt: string | null
  updatedAt: string
}

export interface ArticleRevisionSummaryResponse {
  id: number
  articleId: number
  revisionNo: number
  title: string
  diffSummary: string
  createdByUserId: number
  createdAt: string
}

export interface ArticleRevisionDetailResponse extends ArticleRevisionSummaryResponse {
  content: string
  summary: string | null
  coverImageUrl: string | null
  categoryId: number
  tagIds: number[]
}

export interface PrepublishIssue {
  severity: string
  code: string
  message: string
}

export interface ArticlePreviewResponse {
  html: string
  plainText: string
  issues: PrepublishIssue[]
}

export interface AssetLibraryItemResponse {
  id: number
  url: string
  altText: string | null
  sourceArticleId: number | null
  referenceCount: number
  sha256: string | null
  updatedAt: string
}

export interface AdminCategoryItemResponse {
  id: number
  name: string
  publicArticleCount: number
  draftArticleCount: number
  scheduledArticleCount: number
  archivedArticleCount: number
  totalBlockingArticleCount: number
  canDelete: boolean
}

export interface AdminTagItemResponse {
  id: number
  name: string
  publicArticleCount: number
  draftArticleCount: number
  scheduledArticleCount: number
  archivedArticleCount: number
  deletedArticleCount: number
  totalBlockingArticleCount: number
  canDelete: boolean
}

export interface AuthorAnalyticsMetricResponse {
  label: string
  count: number
}

export interface AuthorRumMetricResponse {
  name: string
  count: number
  p75: number
  average: number
}

export interface AuthorAnalyticsResponse {
  publishedArticles: number
  draftArticles: number
  scheduledArticles: number
  archivedArticles: number
  totalHumanReadEvents: number
  totalSearchableArticles: number
  aotHitRate: number
  averageDwellMs: number
  readingCompletionRate: number
  topSearchKeywords: AuthorAnalyticsMetricResponse[]
  topSourceRoutes: AuthorAnalyticsMetricResponse[]
  notFoundHotspots: AuthorAnalyticsMetricResponse[]
  rumMetrics: AuthorRumMetricResponse[]
  rumPageTypes: AuthorAnalyticsMetricResponse[]
  rumAotSources: AuthorAnalyticsMetricResponse[]
}

export interface AuditLogRuntimeResponse {
  queuedCount: number
  droppedCount: number
  writeSuccessCount: number
  writeFailureCount: number
  fallbackWriteCount: number
  lastWriteSuccessUtc: string | null
  lastWriteFailureUtc: string | null
  lastFallbackWriteUtc: string | null
}

export interface AuditLogItemResponse {
  id: number
  source: string
  type: string
  action: string
  outcome: string
  severity: string
  isHighValue: boolean
  actorType: string | null
  actorId: string | null
  actorRole: string | null
  targetType: string | null
  targetId: string | null
  reasonCode: string | null
  occurredAtUtc: string
  eventInfo: string
  traceId: string | null
  requestPath: string | null
  requestMethod: string | null
  ipHash: string | null
  userAgentHash: string | null
  sessionIdHash: string | null
  deviceFingerprintHash: string | null
  chainId: string | null
  prevHash: string | null
  recordHash: string | null
  recordMac: string | null
}

export interface AuditLogListResponse {
  items: AuditLogItemResponse[]
  total: number
  page: number
  pageSize: number
  runtime: AuditLogRuntimeResponse
}

export interface AuditLogDetailResponse {
  item: AuditLogItemResponse
  contextJson: string | null
  tamperEvidenceValid: boolean
}

export interface AuditFacetResponse {
  value: string
  count: number
}

export interface AuditLogSummaryResponse {
  total: number
  sources: AuditFacetResponse[]
  actions: AuditFacetResponse[]
  outcomes: AuditFacetResponse[]
  severities: AuditFacetResponse[]
  runtime: AuditLogRuntimeResponse
}

export interface AuditTamperVerifyResponse {
  id: number
  valid: boolean
  recordHash: string | null
  recordMac: string | null
  chainId: string | null
}

export interface AdminMetricResponse {
  key: string
  value: unknown
}

export interface AdminServiceStatusResponse {
  key: string
  label: string
  status: string
  detail: string | null
  updatedAt: string | null
  metrics: AdminMetricResponse[]
}

export interface BackupArtifactResponse {
  kind: string
  status: string
  path: string | null
  updatedAt: string | null
  sizeBytes: number | null
  detail: string | null
}

export interface BackupStatusResponse {
  status: string
  checkedAt: string
  backupRoot: string
  artifacts: BackupArtifactResponse[]
  restoreDrillCommand: string
  restoreCommand: string
}

export interface QueueBacklogResponse {
  articleMutationPending: number
  articleMutationFailed: number
  auditQueued: number
  auditDropped: number
}

export interface OpsHealthResponse {
  status: string
  checkedAt: string
  environment: string
  version: string
  commit: string
  services: AdminServiceStatusResponse[]
  workers: AdminServiceStatusResponse[]
  queueBacklog: QueueBacklogResponse
  backup: BackupStatusResponse
  recentErrors: string[]
}

export interface AotDiagnosticsResponse {
  status: string
  version: number
  lastBuildAt: string | null
  lastBuildStatus: string | null
  lastBuildReason: string | null
  lastError: string | null
  stalePageCount: number
  invalidationVersion: number
  trackedInvalidationKeys: number
}

export interface SearchIndexDiagnosticsResponse {
  status: string
  version: string | null
  lastUpdatedAt: string | null
  schemaVersion: number
  shardCount: number
  manifestExists: boolean
  manifestPath: string
  lastError: string | null
}

export interface DistributionDiagnosticsResponse {
  status: string
  checkedAt: string
  sitemapUrlCount: number
  feedItemCount: number
  sitemapUpdatedAt: string | null
  feedUpdatedAt: string | null
  lastError: string | null
}

export interface CacheInvalidationRuntimeSnapshot {
  articleMutationCount: number
  seoCount: number
  systemPageCount: number
  categoryTagCount: number
  commentMutationCount: number
  statsCount: number
  articleViewCount: number
  hotArticlesCount: number
  lastInvalidatedAt: string | null
  lastKind: string | null
  lastDetail: string | null
}

export interface OutputCacheDiagnosticsResponse {
  status: string
  enabled: boolean
  tags: string[]
  detail: string
}

export interface PublicHotReadCounterSnapshot {
  articleHit: number
  articleMiss: number
  listHit: number
  listMiss: number
  htmlHit: number
  htmlMiss: number
  rejected: number
  bytes: number
}

export interface ArticleCacheDiagnosisResponse {
  articleId: number
  publiclyVisible: boolean
  articleFrameReady: boolean
  htmlFrameReady: boolean
  searchEligible: boolean
  sitemapEligible: boolean
  detail: string
}

export interface CacheDiagnosticsResponse {
  status: string
  checkedAt: string
  aot: AotDiagnosticsResponse
  search: SearchIndexDiagnosticsResponse
  distribution: DistributionDiagnosticsResponse
  commentCache: CacheInvalidationRuntimeSnapshot
  outputCache: OutputCacheDiagnosticsResponse
  publicHotReadCounters: PublicHotReadCounterSnapshot
  article: ArticleCacheDiagnosisResponse | null
}

export interface AdminCacheActionRequest {
  action: string
  articleId?: number | null
}

export interface AdminCacheActionResponse {
  action: string
  status: string
  detail: string
  completedAt: string
}

export interface AdminDiffResponse {
  field: string
  before: string
  after: string
}

export interface IntegrityCheckResponse {
  code: string
  title: string
  status: string
  severity: string
  count: number
  autoFixAvailable: boolean
  detail: string
  sampleKeys: string[]
  previewDiffs: AdminDiffResponse[]
}

export interface IntegrityReportResponse {
  status: string
  checkedAt: string
  checkCount: number
  issueCount: number
  checks: IntegrityCheckResponse[]
}

export interface IntegrityFixPreviewResponse {
  status: string
  checkedAt: string
  diffs: AdminDiffResponse[]
  confirmationLevel: string
  auditAction: string
}

export interface IntegrityFixRequest {
  codes?: string[] | null
  confirmPhrase: string
}

export interface IntegrityFixResponse {
  status: string
  appliedAt: string
  appliedCount: number
  diffs: AdminDiffResponse[]
}

export interface DangerousOperationRuleResponse {
  level: string
  interaction: string
  examples: string[]
}

export interface DangerousOperationPolicyResponse {
  rules: DangerousOperationRuleResponse[]
  diffRequiredOperations: string[]
  mfaRequiredOperations: string[]
  strategyVersion: string
}

export interface AuditLogQueryParams {
  page?: number
  pageSize?: number
  source?: string | null
  type?: string | null
  actor?: string | null
  action?: string | null
  targetType?: string | null
  targetId?: string | null
  outcome?: string | null
  severity?: string | null
  fromUtc?: string | null
  toUtc?: string | null
}

export const CommentModerationStatus = {
  Pending: 0,
  Approved: 1,
  Rejected: 2,
  Hidden: 3
} as const

export type CommentModerationStatus =
  (typeof CommentModerationStatus)[keyof typeof CommentModerationStatus]

export interface CommentModerationModelSignalResponse {
  provider: string
  model: string
  contractVersion: string
  label: string
  confidence: number
  severity: string
  primaryReason: string | null
  needsSecondRound: boolean
  riskCategories: string[]
  evidenceJson: string | null
  rawReason: string | null
  latencyMs: number
  status: string
  errorCode: string | null
  thresholdProfile: string | null
  createdAtUtc: string
}

export interface CommentModerationItemResponse {
  id: string
  articleId: number
  articleTitle: string
  userId: number
  userName: string
  content: string
  createTime: string
  status: CommentModerationStatus
  reason: string | null
  moderatedByUserId: number | null
  moderatedAt: string | null
  hitReasons: string[]
  submitRegion: string | null
  submitRegionConfidence: number | null
  blockedRegions: string[]
  regionPolicyVersion: string | null
  regionDecisionReason: string | null
  regionCanPublish: boolean
  regionRequiresManualReview: boolean
  regionHideUntilReviewed: boolean
  modelSignals: CommentModerationModelSignalResponse[]
  modelLabel: string | null
  modelConfidence: number | null
  modelPrimaryReason: string | null
  modelProvider: string | null
  modelUnavailable: boolean
}

export interface CommentModerationQueueResponse {
  items: CommentModerationItemResponse[]
  pendingCount: number
  rejectedCount: number
  hiddenCount: number
}

export interface CommentModerationRequest {
  status: CommentModerationStatus
  reason: string | null
  banUser?: boolean
}

export interface CommentModerationBulkRequest {
  commentIds: string[]
  status: CommentModerationStatus
  reason: string | null
  banUsers?: boolean
}

export interface CommentModerationBulkResponse {
  updated: number
  bannedUsers: number
}

export interface ModerationOverviewResponse {
  pendingCount: number
  rejectedCount: number
  hiddenCount: number
  dictionaryCount: number
  regionPolicyCount: number
  mainlandStrictStatus: string
  dictionaryLastError: string | null
  modelEnabled: boolean
  modelProvider: string
  modelMode: string
  modelContractVersion: string
  modelTimeoutMs: number
}

export interface ModerationDictionaryRuntimeItem {
  dictionaryId: string
  version: string
  scope: string
  region: string | null
  category: string
  source: string
  reviewedBy: string
  updatedAtUtc: string
  checksum: string
  evidencePolicy: string
  termCount: number
}

export interface ModerationRegionPolicyRule {
  category: string
  submitAction: string
  displayAction: string
}

export interface ModerationRegionPolicyRuntimeItem {
  region: string
  version: string
  inherits: string[]
  dictionaryIds: string[]
  checksum: string
  ruleCount: number
  rules: ModerationRegionPolicyRule[]
}

export interface ModerationDictionaryRuntimeSnapshot {
  snapshotId: string
  version: string
  checksum: string
  createdAtUtc: string
  dictionaries: ModerationDictionaryRuntimeItem[]
  regionPolicies: ModerationRegionPolicyRuntimeItem[]
  lastError: string | null
}

export interface RegionPolicyCheckResponse {
  code: string
  label: string
  status: string
  detail: string
}

export interface RegionPolicySummaryResponse {
  region: string
  version: string
  inherits: string[]
  dictionaryIds: string[]
  checksum: string
  ruleCount: number
  criticalChecks: RegionPolicyCheckResponse[]
}

export interface ModerationModelStatusResponse {
  enabled: boolean
  provider: string
  mode: string
  contractVersion: string
  timeoutMs: number
  failOpen: boolean
  externalProviderAllowed: boolean
  externalProviderReviewed: boolean
  lastSuccessAtUtc: string | null
  lastErrorCode: string | null
  lastErrorAtUtc: string | null
  averageLatencyMs: number
  p95LatencyMs: number
}

export interface ModerationDictionaryReloadResponse {
  reloaded: boolean
  snapshotId: string
  checksum: string
  error: string | null
  reloadedAtUtc: string
}

export interface ModerationModelRuntimeResponse {
  snapshotId: string
  enabled: boolean
  provider: string
  modelProfile: string
  thresholdProfile: string
  contractVersion: string
  configChecksum: string
  loadedAtUtc: string
  loadedBy: string
  status: string
  timeoutMs: number
  failOpen: boolean
  externalProviderAllowed: boolean
  externalProviderReviewed: boolean
  lastError: string | null
}

export interface ModerationRuntimeStatusResponse {
  snapshotId: string
  globalState: string
  regionStates: Record<string, string>
  disabledDictionaryIds: string[]
  model: ModerationModelRuntimeResponse
  changedAtUtc: string
  changedBy: string
  reason: string | null
  expiresAtUtc: string | null
  lastError: string | null
}

export interface ModerationRuntimeGlobalStateRequest {
  state: string
  reason?: string | null
  expiresAtUtc?: string | null
}

export interface ModerationRuntimeRegionStateRequest {
  region: string
  state: string
  reason?: string | null
  expiresAtUtc?: string | null
  confirmPhrase?: string | null
}

export interface ModerationDictionaryStateRequest {
  reason?: string | null
  confirmPhrase?: string | null
}

export interface ModerationModelRuntimeRequest {
  enabled?: boolean | null
  provider?: string | null
  modelProfile?: string | null
  thresholdProfile?: string | null
  reason?: string | null
}

export interface ModerationReplayPreviewRequest {
  region?: string | null
  policyVersion?: string | null
  dictionaryId?: string | null
  limit?: number | null
}

export interface ModerationReplayPreviewItemResponse {
  commentId: number
  previousPolicyVersion: string
  nextPolicyVersion: string
  addedBlockedRegions: string[]
  removedBlockedRegions: string[]
  addedRiskLabels: string[]
  removedRiskLabels: string[]
  publishabilityChanged: boolean
  manualReviewChanged: boolean
  publicVisibilityChanged: boolean
}

export interface ModerationReplayPreviewResponse {
  region: string | null
  policyVersion: string | null
  dictionaryId: string | null
  scannedCount: number
  affectedCommentCount: number
  addedBlockedRegionCount: number
  removedBlockedRegionCount: number
  addedRiskLabelCount: number
  removedRiskLabelCount: number
  publishabilityChangedCount: number
  manualReviewChangedCount: number
  publicVisibilityChangedCount: number
  highRiskChangeCount: number
  items: ModerationReplayPreviewItemResponse[]
}

export interface ContentRevisionExportResponse {
  revisionNo: number
  title: string
  content: string
  summary: string | null
  coverImageUrl: string | null
  categoryId: number
  tagIds: number[]
  diffSummary: string
  createdByUserId: number
  createdAt: string
}

export interface ContentExportMetadataResponse {
  sourceArticleId: number | null
  categoryId: number
  tagIds: number[]
  status: number
  scheduledPublishAt: string | null
  coverImageUrl: string | null
  revisionCount: number
  revisions: ContentRevisionExportResponse[]
}

export interface ContentExportResponse {
  fileName: string
  markdownWithFrontmatter: string
  metadata: ContentExportMetadataResponse
}

export interface ContentBackupExportResponse {
  fileName: string
  exportedAt: string
  articles: ContentExportResponse[]
}

export interface ContentImportRequest {
  markdownWithFrontmatter: string
  publish: boolean
  preserveRevisions?: boolean
}

export interface ContentImportResponse {
  articleId: number
  restoredRevisionCount: number
}

export interface PrepublishCheckResponse {
  canPublish: boolean
  issues: PrepublishIssue[]
}

export interface AiAssistRequest {
  title: string
  content: string
  locale?: string | null
  operation?: string | null
}

export interface AiAssistResponse {
  providerEnabled: boolean
  providerMode: string
  externalProviderAllowed: boolean
  auditEvent: string
  suggestedSummary: string
  suggestedTags: string[]
  titleCandidates: string[]
  translationDraft: string
  structureIssues: PrepublishIssue[]
}

type JsonApiResponse<T> = {
  success: boolean
  data?: T | null
  message?: string | null
}

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof'

const jsonHeaders = (hasBody: boolean, mfaProofToken?: string | null): Headers => {
  const headers = new Headers()
  headers.set('Accept', 'application/json')
  headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp())
  if (hasBody) {
    headers.set('Content-Type', 'application/json')
  }

  const proofToken = mfaProofToken?.trim()
  if (proofToken) {
    headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken)
  }

  return headers
}

async function readJsonEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  const envelope = await response.json() as JsonApiResponse<T>
  if (!response.ok || !envelope.success || envelope.data == null) {
    const message = envelope.message || fallbackMessage
    if (!response.ok) {
      throw appErrorFromStatus(response.status, message)
    }

    throw createAppError(AppErrorCode.ProtocolFailure, message, { status: response.status })
  }

  return envelope.data
}

export async function saveServerDraft(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<ServerDraftResponse> {
  const response = await fetch('/api/author/drafts', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(draft)
  })

  return await readJsonEnvelope<ServerDraftResponse>(response, `server_draft_save_failed:${response.status}`)
}

export async function getServerDraft(draftKey: string, config?: ApiRequestConfig): Promise<ServerDraftResponse | null> {
  const response = await fetch(`/api/author/drafts/${encodeURIComponent(draftKey)}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  const envelope = await response.json() as JsonApiResponse<ServerDraftResponse>
  if (!response.ok || !envelope.success) {
    const message = envelope.message || `server_draft_fetch_failed:${response.status}`
    throw appErrorFromStatus(response.status, message)
  }

  return envelope.data ?? null
}

export async function discardServerDraft(draftKey: string, config?: ApiRequestConfig): Promise<boolean> {
  const response = await fetch(`/api/author/drafts/${encodeURIComponent(draftKey)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })
  const result = await readJsonEnvelope<{ discarded?: boolean }>(response, `server_draft_discard_failed:${response.status}`)
  return result.discarded === true
}

export async function previewArticleDraft(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<ArticlePreviewResponse> {
  const response = await fetch('/api/author/preview', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(draft)
  })

  return await readJsonEnvelope<ArticlePreviewResponse>(response, `article_preview_failed:${response.status}`)
}

export async function checkArticlePrepublish(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<PrepublishCheckResponse> {
  const response = await fetch('/api/author/prepublish-check', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(draft)
  })

  return await readJsonEnvelope<PrepublishCheckResponse>(response, `article_prepublish_check_failed:${response.status}`)
}

export async function generateAiAssist(
  request: AiAssistRequest,
  config?: ApiRequestConfig
): Promise<AiAssistResponse> {
  const response = await fetch('/api/author/ai-assist', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<AiAssistResponse>(response, `author_ai_assist_failed:${response.status}`)
}

export async function listAssetLibrary(config?: ApiRequestConfig): Promise<AssetLibraryItemResponse[]> {
  const response = await fetch('/api/author/assets', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AssetLibraryItemResponse[]>(response, `asset_library_fetch_failed:${response.status}`)
}

export async function reindexArticleAssets(
  articleId: number,
  config?: ApiRequestConfig
): Promise<AssetLibraryItemResponse[]> {
  const response = await fetch(`/api/author/articles/${articleId}/assets/reindex`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AssetLibraryItemResponse[]>(response, `asset_library_reindex_failed:${response.status}`)
}

export async function cleanupOrphanAssets(config?: ApiRequestConfig): Promise<number> {
  const response = await fetch('/api/author/assets/orphans', {
    method: 'DELETE',
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })
  const result = await readJsonEnvelope<{ deleted?: number }>(response, `asset_orphan_cleanup_failed:${response.status}`)
  return Number(result.deleted ?? 0)
}

export async function listAdminCategories(config?: ApiRequestConfig): Promise<AdminCategoryItemResponse[]> {
  const response = await fetch('/api/author/taxonomy/categories', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AdminCategoryItemResponse[]>(response, `admin_category_fetch_failed:${response.status}`)
}

export async function listAdminTags(config?: ApiRequestConfig): Promise<AdminTagItemResponse[]> {
  const response = await fetch('/api/author/taxonomy/tags', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AdminTagItemResponse[]>(response, `admin_tag_fetch_failed:${response.status}`)
}

export async function getAuthorAnalytics(config?: ApiRequestConfig): Promise<AuthorAnalyticsResponse> {
  const response = await fetch('/api/author/analytics', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuthorAnalyticsResponse>(response, `author_analytics_fetch_failed:${response.status}`)
}

export async function listAuditLogs(
  params: AuditLogQueryParams,
  config?: ApiRequestConfig
): Promise<AuditLogListResponse> {
  const search = buildAuditSearch(params)
  const response = await fetch(`/api/author/audit?${search.toString()}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuditLogListResponse>(response, `audit_log_fetch_failed:${response.status}`)
}

export async function getAuditLogSummary(
  params: AuditLogQueryParams,
  config?: ApiRequestConfig
): Promise<AuditLogSummaryResponse> {
  const search = buildAuditSearch(params)
  const response = await fetch(`/api/author/audit/summary?${search.toString()}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuditLogSummaryResponse>(response, `audit_summary_fetch_failed:${response.status}`)
}

export async function getAuditLogDetail(id: number, config?: ApiRequestConfig): Promise<AuditLogDetailResponse> {
  const response = await fetch(`/api/author/audit/${id}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuditLogDetailResponse>(response, `audit_detail_fetch_failed:${response.status}`)
}

export async function verifyAuditLog(id: number, config?: ApiRequestConfig): Promise<AuditTamperVerifyResponse> {
  const response = await fetch(`/api/author/audit/${id}/verify`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuditTamperVerifyResponse>(response, `audit_verify_failed:${response.status}`)
}

export async function getOpsHealth(config?: ApiRequestConfig): Promise<OpsHealthResponse> {
  const response = await fetch('/api/author/ops/health', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<OpsHealthResponse>(response, `ops_health_fetch_failed:${response.status}`)
}

export async function getBackupStatus(config?: ApiRequestConfig): Promise<BackupStatusResponse> {
  const response = await fetch('/api/author/ops/backup', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<BackupStatusResponse>(response, `backup_status_fetch_failed:${response.status}`)
}

export async function getDangerousOperationPolicy(config?: ApiRequestConfig): Promise<DangerousOperationPolicyResponse> {
  const response = await fetch('/api/author/ops/dangerous-operations/policy', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<DangerousOperationPolicyResponse>(response, `dangerous_policy_fetch_failed:${response.status}`)
}

export async function getCacheDiagnostics(articleId?: number | null, config?: ApiRequestConfig): Promise<CacheDiagnosticsResponse> {
  const search = new URLSearchParams()
  if (articleId && articleId > 0) {
    search.set('articleId', String(articleId))
  }

  const query = search.toString()
  const response = await fetch(`/api/author/cache/diagnostics${query ? `?${query}` : ''}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<CacheDiagnosticsResponse>(response, `cache_diagnostics_fetch_failed:${response.status}`)
}

export async function runCacheAction(
  request: AdminCacheActionRequest,
  config?: ApiRequestConfig
): Promise<AdminCacheActionResponse> {
  const response = await fetch('/api/author/cache/actions', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<AdminCacheActionResponse>(response, `cache_action_failed:${response.status}`)
}

export async function inspectIntegrity(config?: ApiRequestConfig): Promise<IntegrityReportResponse> {
  const response = await fetch('/api/author/integrity', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<IntegrityReportResponse>(response, `integrity_fetch_failed:${response.status}`)
}

export async function previewIntegrityFix(config?: ApiRequestConfig): Promise<IntegrityFixPreviewResponse> {
  const response = await fetch('/api/author/integrity/fix-preview', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<IntegrityFixPreviewResponse>(response, `integrity_fix_preview_failed:${response.status}`)
}

export async function applyIntegrityFix(
  request: IntegrityFixRequest,
  config?: ApiRequestConfig
): Promise<IntegrityFixResponse> {
  const response = await fetch('/api/author/integrity/fix', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<IntegrityFixResponse>(response, `integrity_fix_failed:${response.status}`)
}

export async function listCommentModerationQueue(
  status: CommentModerationStatus = CommentModerationStatus.Pending,
  limit = 50,
  config?: ApiRequestConfig
): Promise<CommentModerationQueueResponse> {
  const search = new URLSearchParams({
    status: String(status),
    limit: String(limit)
  })
  const response = await fetch(`/api/author/comments/moderation?${search.toString()}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<CommentModerationQueueResponse>(response, `comment_moderation_fetch_failed:${response.status}`)
}

export async function getModerationOverview(config?: ApiRequestConfig): Promise<ModerationOverviewResponse> {
  const response = await fetch('/api/author/moderation/overview', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationOverviewResponse>(response, `moderation_overview_fetch_failed:${response.status}`)
}

export async function getModerationDictionarySnapshot(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot> {
  const response = await fetch('/api/author/moderation/dictionaries', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationDictionaryRuntimeSnapshot>(response, `moderation_dictionary_fetch_failed:${response.status}`)
}

export async function reloadModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryReloadResponse> {
  const response = await fetch('/api/author/moderation/dictionaries/reload', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationDictionaryReloadResponse>(response, `moderation_dictionary_reload_failed:${response.status}`)
}

export async function rollbackModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot> {
  const response = await fetch('/api/author/moderation/dictionaries/rollback', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(false, config?.mfaProofToken),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationDictionaryRuntimeSnapshot>(response, `moderation_dictionary_rollback_failed:${response.status}`)
}

export async function enableModerationDictionary(
  dictionaryId: string,
  request: ModerationDictionaryStateRequest = {},
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch(`/api/author/moderation/dictionaries/${encodeURIComponent(dictionaryId)}/enable`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_dictionary_enable_failed:${response.status}`)
}

export async function disableModerationDictionary(
  dictionaryId: string,
  request: ModerationDictionaryStateRequest = {},
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch(`/api/author/moderation/dictionaries/${encodeURIComponent(dictionaryId)}/disable`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_dictionary_disable_failed:${response.status}`)
}

export async function getModerationRuntimeStatus(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/runtime/status', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_runtime_status_fetch_failed:${response.status}`)
}

export async function setModerationGlobalState(
  request: ModerationRuntimeGlobalStateRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/runtime/global-state', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_runtime_global_state_failed:${response.status}`)
}

export async function setModerationRegionState(
  request: ModerationRuntimeRegionStateRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/runtime/region-state', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_runtime_region_state_failed:${response.status}`)
}

export async function listModerationPolicies(config?: ApiRequestConfig): Promise<RegionPolicySummaryResponse[]> {
  const response = await fetch('/api/author/moderation/policies', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<RegionPolicySummaryResponse[]>(response, `moderation_policies_fetch_failed:${response.status}`)
}

export async function getModerationModelStatus(config?: ApiRequestConfig): Promise<ModerationModelStatusResponse> {
  const response = await fetch('/api/author/moderation/model/status', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationModelStatusResponse>(response, `moderation_model_status_fetch_failed:${response.status}`)
}

export async function setModerationModelRuntime(
  request: ModerationModelRuntimeRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/model/runtime', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_model_runtime_failed:${response.status}`)
}

export async function reloadModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/model/reload', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(false, config?.mfaProofToken),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_model_reload_failed:${response.status}`)
}

export async function rollbackModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  const response = await fetch('/api/author/moderation/model/rollback', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(false, config?.mfaProofToken),
    signal: config?.signal
  })

  return await readJsonEnvelope<ModerationRuntimeStatusResponse>(response, `moderation_model_rollback_failed:${response.status}`)
}

export async function previewModerationReplay(
  request: ModerationReplayPreviewRequest,
  config?: ApiRequestConfig
): Promise<ModerationReplayPreviewResponse> {
  const response = await fetch('/api/author/moderation/replay/preview', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ModerationReplayPreviewResponse>(response, `moderation_replay_preview_failed:${response.status}`)
}

export async function moderateComment(
  commentId: string,
  request: CommentModerationRequest,
  config?: ApiRequestConfig
): Promise<boolean> {
  const response = await fetch(`/api/author/comments/${commentId}/moderation`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })
  const result = await readJsonEnvelope<{ moderated?: boolean }>(response, `comment_moderation_failed:${response.status}`)
  return result.moderated === true
}

export async function moderateCommentsBulk(
  request: CommentModerationBulkRequest,
  config?: ApiRequestConfig
): Promise<CommentModerationBulkResponse> {
  const response = await fetch('/api/author/comments/moderation/bulk', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true, config?.mfaProofToken),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<CommentModerationBulkResponse>(response, `comment_moderation_bulk_failed:${response.status}`)
}

export async function exportArticleContent(
  articleId: number,
  config?: ApiRequestConfig
): Promise<ContentExportResponse> {
  const response = await fetch(`/api/author/articles/${articleId}/export`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ContentExportResponse>(response, `content_export_failed:${response.status}`)
}

export async function exportContentBackup(config?: ApiRequestConfig): Promise<ContentBackupExportResponse> {
  const response = await fetch('/api/author/content/export', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ContentBackupExportResponse>(response, `content_backup_export_failed:${response.status}`)
}

export async function importArticleContent(
  request: ContentImportRequest,
  config?: ApiRequestConfig
): Promise<ContentImportResponse> {
  const response = await fetch('/api/author/articles/import', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(true),
    signal: config?.signal,
    body: JSON.stringify(request)
  })

  return await readJsonEnvelope<ContentImportResponse>(response, `content_import_failed:${response.status}`)
}

export async function listArticleRevisions(
  articleId: number,
  config?: ApiRequestConfig
): Promise<ArticleRevisionSummaryResponse[]> {
  const response = await fetch(`/api/author/articles/${articleId}/revisions`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ArticleRevisionSummaryResponse[]>(response, `article_revisions_fetch_failed:${response.status}`)
}

export async function getArticleRevision(
  articleId: number,
  revisionId: number,
  config?: ApiRequestConfig
): Promise<ArticleRevisionDetailResponse> {
  const response = await fetch(`/api/author/articles/${articleId}/revisions/${revisionId}`, {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<ArticleRevisionDetailResponse>(response, `article_revision_fetch_failed:${response.status}`)
}

export async function rollbackArticleRevision(
  articleId: number,
  revisionId: number,
  config?: ApiRequestConfig
): Promise<boolean> {
  const response = await fetch(`/api/author/articles/${articleId}/revisions/${revisionId}/rollback`, {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })
  const result = await readJsonEnvelope<{ rolledBack?: boolean }>(response, `article_revision_rollback_failed:${response.status}`)
  return result.rolledBack === true
}

function buildAuditSearch(params: AuditLogQueryParams): URLSearchParams {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    search.set(key, String(value))
  }

  return search
}
