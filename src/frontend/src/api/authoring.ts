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

export const CommentModerationStatus = {
  Pending: 0,
  Approved: 1,
  Rejected: 2,
  Hidden: 3
} as const

export type CommentModerationStatus =
  (typeof CommentModerationStatus)[keyof typeof CommentModerationStatus]

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

export async function getAuthorAnalytics(config?: ApiRequestConfig): Promise<AuthorAnalyticsResponse> {
  const response = await fetch('/api/author/analytics', {
    credentials: 'include',
    headers: jsonHeaders(false),
    signal: config?.signal
  })

  return await readJsonEnvelope<AuthorAnalyticsResponse>(response, `author_analytics_fetch_failed:${response.status}`)
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
