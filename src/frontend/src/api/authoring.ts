import type { ApiRequestConfig } from './requestConfig'
import { FrameType } from '@wasm/protocol/frame'
import { decode } from '@wasm/aeds'
import { binaryRequest } from '@/api/binaryApiClient'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame } from './binaryFrame'
import { encodeAuthoringJsonRequest } from '@/adapters/binary/authoringAdapter'
import { FSUS_HEADERS } from './contracts'
import { getBrowserFp } from '@/utils/fingerprint'
import type { ArticleRightsRequest } from './article'
import { AppErrorCode, createAppError } from '@/utils/appError'

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
  rights: ArticleRightsRequest
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
  rights: ArticleRightsRequest
  updatedAt: string
}

export interface ArticleRevisionSummaryResponse {
  id: string
  articleId: number
  revisionNo: number
  title: string
  diffSummary: string
  createdByAdminPrincipalId: string
  createdAt: string
}

export interface ArticleRevisionDetailResponse extends ArticleRevisionSummaryResponse {
  content: string
  summary: string | null
  coverImageUrl: string | null
  categoryId: number
  tagIds: number[]
}

export interface ArticleResponsiblePerson {
  name: string
  profileUrl: string | null
}

export interface ArticleEvidenceSource {
  title: string
  url: string
  sourceType: string
  accessedOn: string | null
  version: string | null
  citationNote: string | null
  isPublic?: boolean
}

export interface ArticleResponsibilityDraft {
  inheritSiteAuthor: boolean
  authors: ArticleResponsiblePerson[]
  reviewer: ArticleResponsiblePerson | null
  sources: ArticleEvidenceSource[]
  updateSummary: string | null
  updateReason: string | null
  effectiveAt: string | null
  conclusionImpact: 'none' | 'clarified' | 'changed' | 'unknown' | null
  methodology: string | null
  applicability: string | null
  limitations: string | null
  responsiblePersonConfirmed: boolean
  containsStrongClaims: boolean
  isSubstantiveUpdate: boolean
  requiresMethodsDisclosure: boolean
}

export interface ArticleResponsibilitySaveResponse {
  saved: boolean
  articleId: number
  articleRevisionId: string
  revisionNo: number
  issues: PrepublishIssue[]
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
  id: string
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

export type AuditPiiMode = 'pii-redacted' | 'investigation'

export interface AuditLogItemResponse {
  id: string
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
  piiMode: AuditPiiMode
}

export interface AuditLogListResponse {
  items: AuditLogItemResponse[]
  total: number
  page: number
  pageSize: number
  nextCursor?: string | null
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
  id: string
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

export interface RecentOpsErrorResponse {
  occurredAt: string
  severity: string
  action: string
  message: string
  detail: string | null
  count: number
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
  recentErrors: RecentOpsErrorResponse[]
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

export interface HotStatsInvalidationSnapshot {
  hotArticlesVersion: number
  statsDirtyCount: number
  statsFlushCount: number
  statsCoalescedDirtyCount: number
  hotArticlesDirtyCount: number
  hotArticlesFlushCount: number
  hotArticlesCoalescedDirtyCount: number
  statsDirty: boolean
  hotArticlesDirty: boolean
  lastDirtyAt: string | null
  lastFlushAt: string | null
  lastDirtyReason: string | null
  lastFlushReason: string | null
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
  hotStatsInvalidation: HotStatsInvalidationSnapshot
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
  cursor?: string | null
  piiMode?: AuditPiiMode | null
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
  authorMode?: 'anonymous' | 'public' | 'zk_anonymous' | string | null
  authorDisplayName?: string | null
  displayLanguage?: 'zh-CN' | 'en' | string | null
  anonymousScope?: string | null
  rateClass?: 'common' | 'unknown' | string | null
  requiresModeration?: boolean | null
  riskLabels?: string[] | null
  nullifierHash?: string | null
  nullifierStatusLabel?: string | null
  anonymousCredentialId?: string | null
  canBlockAnonymousNullifier?: boolean | null
  canRevokeAnonymousCredential?: boolean | null
  content: string
  createTime: string
  status: CommentModerationStatus
  reason: string | null
  moderatedByAdminPrincipalId: number | null
  moderatedAt: string | null
  autoModerated: boolean
  moderationActor: string
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

export interface AnonymousNullifierBlockRequest {
  nullifierHash: string
  scope: string
  reason: string | null
}

export interface AnonymousCredentialRevokeRequest {
  reason: string | null
}

export interface AnonymousGovernanceActionResponse {
  applied: boolean
}

export interface AnonymousCommentPolicyResponse {
  anonymousCommentsEnabled: boolean
  publicCommentsEnabled: boolean
  zkAnonymousEnabled: boolean
  defaultAuthorMode: 'public' | 'zk_anonymous'
  supportedDisplayLanguages: string[]
  commentMaxChars: number
  commentMaxUtf8Bytes: number
  snapshotHash: string
  changedBy?: string | null
  reason?: string | null
  updatedAtUtc?: string | null
}

export interface AnonymousCommentPolicyUpdateRequest {
  anonymousCommentsEnabled?: boolean | null
  publicCommentsEnabled?: boolean | null
  zkAnonymousEnabled?: boolean | null
  defaultAuthorMode?: 'public' | 'zk_anonymous' | null
  supportedDisplayLanguages?: string[] | null
  commentMaxChars?: number | null
  commentMaxUtf8Bytes?: number | null
  reason?: string | null
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
  runtimePath: string | null
  runtimeChannel: string
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
  modelProfile?: string | null
  thresholdProfile?: string | null
  reason?: string | null
}

export interface ModerationRegionDefinition {
  regionCode: string
  displayName: string
  parentRegion: string | null
  primaryGroup: string | null
  policyTemplate: string | null
  enabled: boolean
  builtin: boolean
  description: string | null
}

export interface ModerationRegionGroupDefinition {
  groupCode: string
  displayName: string
  policyTemplate: string | null
  builtin: boolean
  enabled: boolean
  regions: string[]
  description: string | null
}

export interface ModerationPolicyTemplateRule {
  category: string
  submitAction: string
  displayAction: string
}

export interface ModerationPolicyTemplateDefinition {
  templateId: string
  version: string
  scope: string
  region: string | null
  regionGroup: string | null
  source: string
  reviewedBy: string
  reviewedAtUtc: string | null
  builtin: boolean
  enabled: boolean
  notLegalAdvice: boolean
  description: string
  checksum: string
  rules: ModerationPolicyTemplateRule[]
}

export interface ModerationEffectivePolicyStep {
  step: string
  sourceId: string
  sourceType: string
  rules: ModerationPolicyTemplateRule[]
}

export interface ModerationEffectivePolicyRule {
  category: string
  submitAction: string
  displayAction: string
  sourceId: string
  sourceType: string
}

export interface ModerationEffectivePolicyPreview {
  region: string
  displayName: string
  regionGroups: string[]
  inheritance: ModerationEffectivePolicyStep[]
  rules: ModerationEffectivePolicyRule[]
  checksum: string
  warnings: string[]
}

export interface ModerationEffectivePolicyPreviewRequest {
  regionCode: string
  operatorOverrides?: ModerationPolicyTemplateRule[] | null
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

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof'
const BINARY_API_PREFIX = '/api/binary'
const authoringJsonDecoder = new TextDecoder()

type AuthoringBinaryRequestOptions = {
  method?: string
  requestFrame?: FrameType
  request?: unknown
}

const authoringHeaders = (mfaProofToken?: string | null): Headers => {
  const headers = new Headers()
  headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp())
  const proofToken = mfaProofToken?.trim()
  if (proofToken) {
    headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken)
  }

  return headers
}

function authoringBody(frameType: FrameType, request: unknown): ArrayBuffer {
  return encodeAedsFrame(frameType, encodeAuthoringJsonRequest(request))
}

function requestAuthoringBinary<T>(
  path: string,
  frameType: FrameType,
  config?: ApiRequestConfig,
  options: AuthoringBinaryRequestOptions = {}
): Promise<T> {
  const requestOptions: RequestInit = {
    credentials: 'include',
    headers: authoringHeaders(config?.mfaProofToken)
  }
  if (options.method) {
    requestOptions.method = options.method
  }
  if (options.requestFrame !== undefined) {
    requestOptions.body = authoringBody(options.requestFrame, options.request)
  }

  return requestBinaryOnly<T>({
    binaryUrl: `${BINARY_API_PREFIX}/author${path}`,
    frameType,
    requestOptions,
    signal: config?.signal as AbortSignal | undefined
  })
}

async function requestAuthoringJson<T>(
  path: string,
  frameType: FrameType,
  config?: ApiRequestConfig,
  options: AuthoringBinaryRequestOptions = {}
): Promise<T> {
  const requestOptions: RequestInit = {
    credentials: 'include',
    headers: authoringHeaders(config?.mfaProofToken),
    signal: config?.signal as AbortSignal | undefined
  }
  if (options.method) {
    requestOptions.method = options.method
  }
  if (options.requestFrame !== undefined) {
    requestOptions.body = authoringBody(options.requestFrame, options.request)
  }

  const frame = decode(await binaryRequest(`${BINARY_API_PREFIX}/author${path}`, requestOptions))
  if (!frame.ok || frame.frameType !== frameType) {
    throw createAppError(AppErrorCode.ProtocolFailure, frame.ok ? 'AUTHORING_FRAME_UNEXPECTED' : 'AUTHORING_FRAME_DECODE_FAILED')
  }

  return JSON.parse(authoringJsonDecoder.decode(frame.payloadView)) as T
}

export async function saveServerDraft(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<ServerDraftResponse> {
  return requestAuthoringBinary<ServerDraftResponse>('/drafts', FrameType.AuthorDraftResponse, config, {
    method: 'POST',
    requestFrame: FrameType.AuthorDraftSaveRequest,
    request: draft
  })
}

export async function getServerDraft(draftKey: string, config?: ApiRequestConfig): Promise<ServerDraftResponse | null> {
  return requestAuthoringBinary<ServerDraftResponse | null>(`/drafts/${encodeURIComponent(draftKey)}`, FrameType.AuthorDraftResponse, config)
}

export async function discardServerDraft(draftKey: string, config?: ApiRequestConfig): Promise<boolean> {
  const result = await requestAuthoringBinary<{ discarded?: boolean }>(`/drafts/${encodeURIComponent(draftKey)}`, FrameType.AuthorDraftDiscardResponse, config, {
    method: 'DELETE'
  })
  return result.discarded === true
}

export async function previewArticleDraft(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<ArticlePreviewResponse> {
  return requestAuthoringBinary<ArticlePreviewResponse>('/preview', FrameType.ArticlePreviewResponse, config, {
    method: 'POST',
    requestFrame: FrameType.ArticlePreviewRequest,
    request: draft
  })
}

export async function checkArticlePrepublish(
  draft: ServerDraftSaveRequest,
  config?: ApiRequestConfig
): Promise<PrepublishCheckResponse> {
  return requestAuthoringBinary<PrepublishCheckResponse>('/prepublish-check', FrameType.PrepublishCheckResponse, config, {
    method: 'POST',
    requestFrame: FrameType.PrepublishCheckRequest,
    request: draft
  })
}

export async function generateAiAssist(
  request: AiAssistRequest,
  config?: ApiRequestConfig
): Promise<AiAssistResponse> {
  return requestAuthoringBinary<AiAssistResponse>('/ai-assist', FrameType.AiAssistResponse, config, {
    method: 'POST',
    requestFrame: FrameType.AiAssistRequest,
    request
  })
}

export async function listAssetLibrary(config?: ApiRequestConfig): Promise<AssetLibraryItemResponse[]> {
  return requestAuthoringBinary<AssetLibraryItemResponse[]>('/assets', FrameType.AssetLibraryList, config)
}

export async function reindexArticleAssets(
  articleId: number,
  config?: ApiRequestConfig
): Promise<AssetLibraryItemResponse[]> {
  return requestAuthoringBinary<AssetLibraryItemResponse[]>(`/articles/${articleId}/assets/reindex`, FrameType.AssetLibraryList, config, {
    method: 'POST'
  })
}

export async function cleanupOrphanAssets(config?: ApiRequestConfig): Promise<number> {
  const result = await requestAuthoringBinary<{ deleted?: number }>('/assets/orphans', FrameType.AssetCleanupResponse, config, {
    method: 'DELETE'
  })
  return Number(result.deleted ?? 0)
}

export async function listAdminCategories(config?: ApiRequestConfig): Promise<AdminCategoryItemResponse[]> {
  return requestAuthoringBinary<AdminCategoryItemResponse[]>('/taxonomy/categories', FrameType.AuthorTaxonomyCategoryList, config)
}

export async function listAdminTags(config?: ApiRequestConfig): Promise<AdminTagItemResponse[]> {
  return requestAuthoringBinary<AdminTagItemResponse[]>('/taxonomy/tags', FrameType.AuthorTaxonomyTagList, config)
}

export async function getAuthorAnalytics(config?: ApiRequestConfig): Promise<AuthorAnalyticsResponse> {
  return requestAuthoringBinary<AuthorAnalyticsResponse>('/analytics', FrameType.AuthorAnalytics, config)
}

export async function listAuditLogs(
  params: AuditLogQueryParams,
  config?: ApiRequestConfig
): Promise<AuditLogListResponse> {
  const search = buildAuditSearch(params)
  return requestAuthoringBinary<AuditLogListResponse>(`/audit?${search.toString()}`, FrameType.AuditLogList, config)
}

export async function getAuditLogSummary(
  params: AuditLogQueryParams,
  config?: ApiRequestConfig
): Promise<AuditLogSummaryResponse> {
  const search = buildAuditSearch(params)
  return requestAuthoringBinary<AuditLogSummaryResponse>(`/audit/summary?${search.toString()}`, FrameType.AuditLogSummary, config)
}

export async function getAuditLogDetail(
  id: string,
  piiMode?: AuditPiiMode | null,
  config?: ApiRequestConfig
): Promise<AuditLogDetailResponse> {
  const search = new URLSearchParams()
  if (piiMode) {
    search.set('piiMode', piiMode)
  }
  const query = search.toString()
  const suffix = query ? `?${query}` : ''
  return requestAuthoringBinary<AuditLogDetailResponse>(`/audit/${id}${suffix}`, FrameType.AuditLogDetail, config)
}

export async function verifyAuditLog(id: string, config?: ApiRequestConfig): Promise<AuditTamperVerifyResponse> {
  return requestAuthoringBinary<AuditTamperVerifyResponse>(`/audit/${id}/verify`, FrameType.AuditTamperVerifyResponse, config)
}

export async function getOpsHealth(config?: ApiRequestConfig): Promise<OpsHealthResponse> {
  return requestAuthoringBinary<OpsHealthResponse>('/ops/health', FrameType.OpsHealth, config)
}

export async function getBackupStatus(config?: ApiRequestConfig): Promise<BackupStatusResponse> {
  return requestAuthoringBinary<BackupStatusResponse>('/ops/backup', FrameType.BackupStatus, config)
}

export async function getDangerousOperationPolicy(config?: ApiRequestConfig): Promise<DangerousOperationPolicyResponse> {
  return requestAuthoringBinary<DangerousOperationPolicyResponse>('/ops/dangerous-operations/policy', FrameType.DangerousOperationPolicy, config)
}

export async function getCacheDiagnostics(articleId?: number | null, config?: ApiRequestConfig): Promise<CacheDiagnosticsResponse> {
  const search = new URLSearchParams()
  if (articleId && articleId > 0) {
    search.set('articleId', String(articleId))
  }

  const query = search.toString()
  return requestAuthoringBinary<CacheDiagnosticsResponse>(`/cache/diagnostics${query ? `?${query}` : ''}`, FrameType.CacheDiagnostics, config)
}

export async function runCacheAction(
  request: AdminCacheActionRequest,
  config?: ApiRequestConfig
): Promise<AdminCacheActionResponse> {
  return requestAuthoringBinary<AdminCacheActionResponse>('/cache/actions', FrameType.AdminCacheActionResponse, config, {
    method: 'POST',
    requestFrame: FrameType.AdminCacheActionRequest,
    request
  })
}

export async function inspectIntegrity(config?: ApiRequestConfig): Promise<IntegrityReportResponse> {
  return requestAuthoringBinary<IntegrityReportResponse>('/integrity', FrameType.IntegrityReport, config)
}

export async function previewIntegrityFix(config?: ApiRequestConfig): Promise<IntegrityFixPreviewResponse> {
  return requestAuthoringBinary<IntegrityFixPreviewResponse>('/integrity/fix-preview', FrameType.IntegrityFixPreview, config)
}

export async function applyIntegrityFix(
  request: IntegrityFixRequest,
  config?: ApiRequestConfig
): Promise<IntegrityFixResponse> {
  return requestAuthoringBinary<IntegrityFixResponse>('/integrity/fix', FrameType.IntegrityFixResponse, config, {
    method: 'POST',
    requestFrame: FrameType.IntegrityFixRequest,
    request
  })
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
  return requestAuthoringBinary<CommentModerationQueueResponse>(`/comments/moderation?${search.toString()}`, FrameType.CommentModerationQueue, config)
}

export async function getModerationOverview(config?: ApiRequestConfig): Promise<ModerationOverviewResponse> {
  return requestAuthoringBinary<ModerationOverviewResponse>('/moderation/overview', FrameType.ModerationOverview, config)
}

export async function getAnonymousCommentPolicy(config?: ApiRequestConfig): Promise<AnonymousCommentPolicyResponse> {
  return requestAuthoringJson<AnonymousCommentPolicyResponse>('/moderation/anonymous-comment-policy', FrameType.CommentPolicySnapshot, config)
}

export async function updateAnonymousCommentPolicy(
  request: AnonymousCommentPolicyUpdateRequest,
  config?: ApiRequestConfig
): Promise<AnonymousCommentPolicyResponse> {
  return requestAuthoringJson<AnonymousCommentPolicyResponse>('/moderation/anonymous-comment-policy', FrameType.CommentPolicySnapshot, config, {
    method: 'PUT',
    requestFrame: FrameType.CommentPolicyUpdateRequest,
    request
  })
}

export async function getModerationDictionarySnapshot(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot> {
  return requestAuthoringBinary<ModerationDictionaryRuntimeSnapshot>('/moderation/dictionaries', FrameType.ModerationDictionarySnapshot, config)
}

export async function reloadModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryReloadResponse> {
  return requestAuthoringBinary<ModerationDictionaryReloadResponse>('/moderation/dictionaries/reload', FrameType.ModerationDictionaryReloadResponse, config, {
    method: 'POST'
  })
}

export async function rollbackModerationDictionaries(config?: ApiRequestConfig): Promise<ModerationDictionaryRuntimeSnapshot> {
  return requestAuthoringBinary<ModerationDictionaryRuntimeSnapshot>('/moderation/dictionaries/rollback', FrameType.ModerationDictionarySnapshot, config, {
    method: 'POST'
  })
}

export async function enableModerationDictionary(
  dictionaryId: string,
  request: ModerationDictionaryStateRequest = {},
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>(`/moderation/dictionaries/${encodeURIComponent(dictionaryId)}/enable`, FrameType.ModerationRuntimeStatus, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationDictionaryStateRequest,
    request
  })
}

export async function disableModerationDictionary(
  dictionaryId: string,
  request: ModerationDictionaryStateRequest = {},
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>(`/moderation/dictionaries/${encodeURIComponent(dictionaryId)}/disable`, FrameType.ModerationRuntimeStatus, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationDictionaryStateRequest,
    request
  })
}

export async function getModerationRuntimeStatus(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/runtime/status', FrameType.ModerationRuntimeStatus, config)
}

export async function setModerationGlobalState(
  request: ModerationRuntimeGlobalStateRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/runtime/global-state', FrameType.ModerationRuntimeStatus, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationRuntimeGlobalStateRequest,
    request
  })
}

export async function setModerationRegionState(
  request: ModerationRuntimeRegionStateRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/runtime/region-state', FrameType.ModerationRuntimeStatus, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationRuntimeRegionStateRequest,
    request
  })
}

export async function listModerationRegions(config?: ApiRequestConfig): Promise<ModerationRegionDefinition[]> {
  return requestAuthoringBinary<ModerationRegionDefinition[]>('/moderation/regions', FrameType.ModerationRegionList, config)
}

export async function listModerationRegionGroups(config?: ApiRequestConfig): Promise<ModerationRegionGroupDefinition[]> {
  return requestAuthoringBinary<ModerationRegionGroupDefinition[]>('/moderation/region-groups', FrameType.ModerationRegionGroupList, config)
}

export async function listModerationPolicyTemplates(config?: ApiRequestConfig): Promise<ModerationPolicyTemplateDefinition[]> {
  return requestAuthoringBinary<ModerationPolicyTemplateDefinition[]>('/moderation/policy-templates', FrameType.ModerationPolicyTemplateList, config)
}

export async function getModerationEffectivePolicy(
  regionCode: string,
  config?: ApiRequestConfig
): Promise<ModerationEffectivePolicyPreview> {
  return requestAuthoringBinary<ModerationEffectivePolicyPreview>(`/moderation/effective-policy/${encodeURIComponent(regionCode)}`, FrameType.ModerationEffectivePolicy, config)
}

export async function previewModerationEffectivePolicy(
  request: ModerationEffectivePolicyPreviewRequest,
  config?: ApiRequestConfig
): Promise<ModerationEffectivePolicyPreview> {
  return requestAuthoringBinary<ModerationEffectivePolicyPreview>('/moderation/effective-policy/preview', FrameType.ModerationEffectivePolicy, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationEffectivePolicyPreviewRequest,
    request
  })
}

export async function listModerationPolicies(config?: ApiRequestConfig): Promise<RegionPolicySummaryResponse[]> {
  return requestAuthoringBinary<RegionPolicySummaryResponse[]>('/moderation/policies', FrameType.RegionPolicySummaryList, config)
}

export async function getModerationModelStatus(config?: ApiRequestConfig): Promise<ModerationModelStatusResponse> {
  return requestAuthoringBinary<ModerationModelStatusResponse>('/moderation/model/status', FrameType.ModerationModelStatus, config)
}

export async function setModerationModelRuntime(
  request: ModerationModelRuntimeRequest,
  config?: ApiRequestConfig
): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/model/runtime', FrameType.ModerationRuntimeStatus, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationModelRuntimeRequest,
    request
  })
}

export async function reloadModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/model/reload', FrameType.ModerationRuntimeStatus, config, {
    method: 'POST'
  })
}

export async function rollbackModerationModel(config?: ApiRequestConfig): Promise<ModerationRuntimeStatusResponse> {
  return requestAuthoringBinary<ModerationRuntimeStatusResponse>('/moderation/model/rollback', FrameType.ModerationRuntimeStatus, config, {
    method: 'POST'
  })
}

export async function previewModerationReplay(
  request: ModerationReplayPreviewRequest,
  config?: ApiRequestConfig
): Promise<ModerationReplayPreviewResponse> {
  return requestAuthoringBinary<ModerationReplayPreviewResponse>('/moderation/replay/preview', FrameType.ModerationReplayPreview, config, {
    method: 'POST',
    requestFrame: FrameType.ModerationReplayPreviewRequest,
    request
  })
}

export async function moderateComment(
  commentId: string,
  request: CommentModerationRequest,
  config?: ApiRequestConfig
): Promise<boolean> {
  const result = await requestAuthoringBinary<{ moderated?: boolean }>(`/comments/${commentId}/moderation`, FrameType.CommentModerationResult, config, {
    method: 'POST',
    requestFrame: FrameType.CommentModerationRequest,
    request
  })
  return result.moderated === true
}

export async function moderateCommentsBulk(
  request: CommentModerationBulkRequest,
  config?: ApiRequestConfig
): Promise<CommentModerationBulkResponse> {
  return requestAuthoringBinary<CommentModerationBulkResponse>('/comments/moderation/bulk', FrameType.CommentModerationBulkResponse, config, {
    method: 'POST',
    requestFrame: FrameType.CommentModerationBulkRequest,
    request
  })
}

export async function blockAnonymousNullifier(
  request: AnonymousNullifierBlockRequest,
  config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse> {
  return requestAuthoringBinary<AnonymousGovernanceActionResponse>('/comments/moderation/nullifiers/block', FrameType.AnonymousGovernanceActionResponse, config, {
    method: 'POST',
    requestFrame: FrameType.AnonymousGovernanceActionRequest,
    request
  })
}

export async function revokeAnonymousCredential(
  credentialId: string | number,
  request: AnonymousCredentialRevokeRequest,
  config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse> {
  return requestAuthoringBinary<AnonymousGovernanceActionResponse>(`/comments/moderation/anonymous-credentials/${encodeURIComponent(String(credentialId))}/revoke`, FrameType.AnonymousGovernanceActionResponse, config, {
    method: 'POST',
    requestFrame: FrameType.AnonymousGovernanceActionRequest,
    request
  })
}

export async function exportArticleContent(
  articleId: number,
  config?: ApiRequestConfig
): Promise<ContentExportResponse> {
  return requestAuthoringBinary<ContentExportResponse>(`/articles/${articleId}/export`, FrameType.ContentExport, config)
}

export async function exportContentBackup(config?: ApiRequestConfig): Promise<ContentBackupExportResponse> {
  return requestAuthoringBinary<ContentBackupExportResponse>('/content/export', FrameType.ContentBackupExport, config)
}

export async function importArticleContent(
  request: ContentImportRequest,
  config?: ApiRequestConfig
): Promise<ContentImportResponse> {
  return requestAuthoringBinary<ContentImportResponse>('/articles/import', FrameType.ContentImportResponse, config, {
    method: 'POST',
    requestFrame: FrameType.ContentImportRequest,
    request
  })
}

export async function listArticleRevisions(
  articleId: number,
  config?: ApiRequestConfig
): Promise<ArticleRevisionSummaryResponse[]> {
  return requestAuthoringBinary<ArticleRevisionSummaryResponse[]>(`/articles/${articleId}/revisions`, FrameType.ArticleRevisionList, config)
}

export async function getArticleRevision(
  articleId: number,
  revisionId: string,
  config?: ApiRequestConfig
): Promise<ArticleRevisionDetailResponse> {
  return requestAuthoringBinary<ArticleRevisionDetailResponse>(`/articles/${articleId}/revisions/${revisionId}`, FrameType.ArticleRevisionDetail, config)
}

export async function rollbackArticleRevision(
  articleId: number,
  revisionId: string,
  config?: ApiRequestConfig
): Promise<boolean> {
  const result = await requestAuthoringBinary<{ rolledBack?: boolean }>(`/articles/${articleId}/revisions/${revisionId}/rollback`, FrameType.ArticleRevisionRollbackResponse, config, {
    method: 'POST'
  })
  return result.rolledBack === true
}

export async function saveArticleResponsibility(
  articleId: number,
  revisionId: string,
  request: ArticleResponsibilityDraft,
  config?: ApiRequestConfig
): Promise<ArticleResponsibilitySaveResponse> {
  return requestAuthoringBinary<ArticleResponsibilitySaveResponse>(
    `/articles/${articleId}/revisions/${revisionId}/responsibility`,
    FrameType.ArticleResponsibilityResponse,
    config,
    {
      method: 'PUT',
      requestFrame: FrameType.ArticleResponsibilityRequest,
      request
    }
  )
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
