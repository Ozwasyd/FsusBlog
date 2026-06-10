import type { ApiRequestConfig } from './requestConfig'
import { FSUS_HEADERS } from './contracts'
import { getBrowserFp } from '@/utils/fingerprint'
import { AppErrorCode, appErrorFromStatus, createAppError } from '@/utils/appError'

export type SecurityMode = 'disabled' | 'observe' | 'enforce' | 'strict'

export interface AntiCrawlerPolicyOptions {
  mode: SecurityMode
  publicReadChallengeEnabled: boolean
  searchCrawlerVerificationEnabled: boolean
  socialPreviewGuardEnabled: boolean
  riskScoringEnabled: boolean
  eventPersistenceEnabled: boolean
  dashboardAggregationEnabled: boolean
  cidrAutoUpdateEnabled: boolean
  illegalPathHardAbortEnabled: boolean
  requireChallengeScore: number
  blockScore: number
  maxRiskScore: number
  defaultRiskTtlSeconds: number
  zeroRiskCacheTtlSeconds: number
  fixedIpPermitLimit: number
  fixedIpQueueLimit: number
  verifiedCrawlerFixedIpPermitLimit: number
  publicReadPermitLimit: number
  publicReadQueueLimit: number
  verifiedCrawlerPublicReadPermitLimit: number
  socialPreviewPublicReadPermitLimit: number
  readProofPermitLimit: number
  cidrUpdateIntervalMinutes: number
  cidrInitialDelaySeconds: number
  cidrMinUpdateIntervalMinutes: number
  googleCrawlerRangesUrl: string
  bingCrawlerRangesUrl: string
  snapshotPath: string | null
  socialPreviewAllowedPathPrefixes: string[]
  blockedUserAgentKeywords: string[]
  securityChallengeReference: string
}

export type AntiCrawlerOptionsUpdateRequest = Partial<AntiCrawlerPolicyOptions> & {
  reason?: string | null
}

export interface PowPolicyOptions {
  mode: SecurityMode
  defaultDifficulty: number
  adaptiveDifficultyEnabled: boolean
  proofTtlSeconds: number
  replayProtectionEnabled: boolean
  riskScoreLinkEnabled: boolean
  challengeEndpoint: string
  verificationStrategy: string
}

export type PowOptionsUpdateRequest = Partial<PowPolicyOptions> & {
  reason?: string | null
}

export interface AntiCrawlerPolicySnapshot {
  snapshotId: string
  updatedAtUtc: string
  updatedBy: string
  reason: string | null
  options: AntiCrawlerPolicyOptions
}

export interface PowPolicySnapshot {
  snapshotId: string
  updatedAtUtc: string
  updatedBy: string
  reason: string | null
  options: PowPolicyOptions
}

export interface AntiCrawlerOverviewSummary {
  mode: SecurityMode
  enabled: boolean
  enforcing: boolean
  eventsLastHour: number
  eventsLastDay: number
  verifiedCrawlerEvents: number
  fakeCrawlerEvents: number
  unknownBotEvents: number
  blockedUserAgentEvents: number
  socialPreviewEvents: number
  riskSnapshotCount: number
  cidrSource: string
  googleRanges: number
  bingRanges: number
  lastSyncAt: string | null
  nextSyncAt: string | null
}

export interface SecurityRiskOverviewResponse {
  eventsLastHour: number
  eventsLastDay: number
  snapshotCount: number
  highRiskSnapshotCount: number
  topReason: string
  topSource: string
}

export interface CrawlerRangesAdminStatus {
  autoUpdateEnabled: boolean
  updateIntervalMinutes: number
  minUpdateIntervalMinutes: number
  initialDelaySeconds: number
  nextSyncAt: string | null
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastOutcome: string
  running: boolean
  googleRanges: number
  bingRanges: number
  lastSyncAt: string | null
  lastSuccessAt: string | null
  source: string
  lastError: string | null
  googleUrl: string
  bingUrl: string
  snapshotPath: string | null
}

export interface AntiCrawlerRiskEventResponse {
  id: string
  occurredAtUtc: string
  source: string
  reason: string
  action: string
  scoreDelta: number
  totalScore: number
  ip: string
  path: string
  method: string
  userAgent: string | null
  detail: string | null
}

export interface SecurityRiskSnapshotResponse {
  subject: string
  score: number
  lastReason: string
  lastSource: string
  updatedAtUtc: string
  expiresAtUtc: string
}

export interface AntiCrawlerRuleResponse {
  id: string
  name: string
  enabled: boolean
  matchType: string
  pattern: string
  action: string
  score: number
  notes: string | null
  updatedAtUtc: string
  updatedBy: string
}

export type AntiCrawlerRuleRequest = Omit<AntiCrawlerRuleResponse, 'id' | 'updatedAtUtc' | 'updatedBy'>

export interface AntiCrawlerListEntryResponse {
  id: string
  listType: string
  value: string
  scope: string
  reason: string | null
  enabled: boolean
  updatedAtUtc: string
  updatedBy: string
}

export interface AntiCrawlerListEntryRequest {
  value: string
  scope: string
  reason: string | null
  enabled: boolean
}

export interface AntiCrawlerSimulationRequest {
  method: string
  path: string
  userAgent: string
  ip: string
  referer: string | null
  currentRiskScore: number
}

export interface AntiCrawlerSimulationResult {
  mode: SecurityMode
  finalAction: string
  wouldVerifyCrawler: boolean
  wouldApplySocialPreviewGuard: boolean
  wouldRequireChallenge: boolean
  wouldBlock: boolean
  scoreDelta: number
  resultingRiskScore: number
  matchedRules: string[]
  matchedLists: string[]
  securityChallengeReference: string
}

export interface PowOverviewResponse {
  policy: PowPolicySnapshot
  validationFailuresLastHour: number
  replayRejectsLastHour: number
  challengeRequiredLastHour: number
  challengeEndpointStatus: string
}

export interface SecurityOverviewResponse {
  status: string
  checkedAtUtc: string
  antiCrawler: AntiCrawlerOverviewSummary
  pow: PowOverviewResponse
  risk: SecurityRiskOverviewResponse
}

export interface AntiCrawlerOverviewResponse {
  policy: AntiCrawlerPolicySnapshot
  summary: AntiCrawlerOverviewSummary
  crawlerRanges: CrawlerRangesAdminStatus
  recentEvents: AntiCrawlerRiskEventResponse[]
  rules: AntiCrawlerRuleResponse[]
  allowlist: AntiCrawlerListEntryResponse[]
  blocklist: AntiCrawlerListEntryResponse[]
}

export interface CrawlerRangeSyncResponse {
  status: CrawlerRangesAdminStatus
  outcome: string
  completedAtUtc: string
}

export interface SecurityRiskResetRequest {
  subject: string
  reason: string
}

export interface SecurityRiskResetResponse {
  subject: string
  reset: boolean
  resetAtUtc: string
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
  if (hasBody) headers.set('Content-Type', 'application/json')

  const proofToken = mfaProofToken?.trim()
  if (proofToken) headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken)
  return headers
}

async function readJsonEnvelope<T>(response: Response, fallbackMessage: string): Promise<T> {
  const envelope = await response.json() as JsonApiResponse<T>
  if (!response.ok || !envelope.success || envelope.data == null) {
    const message = envelope.message || fallbackMessage
    if (!response.ok) throw appErrorFromStatus(response.status, message)
    throw createAppError(AppErrorCode.ProtocolFailure, message, { status: response.status })
  }

  return envelope.data
}

async function requestJson<T>(url: string, init: RequestInit = {}, config?: ApiRequestConfig): Promise<T> {
  const hasBody = init.body != null
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: jsonHeaders(hasBody, config?.mfaProofToken),
    signal: config?.signal
  })
  return await readJsonEnvelope<T>(response, `security_request_failed:${response.status}`)
}

const query = (params: Record<string, string | number | null | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const value = search.toString()
  return value ? `?${value}` : ''
}

export const getSecurityOverview = (config?: ApiRequestConfig) =>
  requestJson<SecurityOverviewResponse>('/api/admin/security/overview', {}, config)

export const getAntiCrawlerOverview = (config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerOverviewResponse>('/api/admin/security/anti-crawler/overview', {}, config)

export const getAntiCrawlerOptions = (config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerPolicySnapshot>('/api/admin/security/anti-crawler/options', {}, config)

export const updateAntiCrawlerOptions = (request: AntiCrawlerOptionsUpdateRequest, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerPolicySnapshot>('/api/admin/security/anti-crawler/options', {
    method: 'PUT',
    body: JSON.stringify(request)
  }, config)

export const rollbackAntiCrawlerOptions = (config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerPolicySnapshot>('/api/admin/security/anti-crawler/options/rollback', { method: 'POST' }, config)

export const getCrawlerRangesStatus = (config?: ApiRequestConfig) =>
  requestJson<CrawlerRangesAdminStatus>('/api/admin/security/anti-crawler/crawler-ranges/status', {}, config)

export const syncCrawlerRanges = (config?: ApiRequestConfig) =>
  requestJson<CrawlerRangeSyncResponse>('/api/admin/security/anti-crawler/crawler-ranges/sync', { method: 'POST' }, config)

export const listSecurityRiskEvents = (params: { source?: string | null; reason?: string | null; limit?: number } = {}, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerRiskEventResponse[]>(`/api/admin/security/risk/events${query(params)}`, {}, config)

export const listSecurityRiskSnapshots = (limit = 100, config?: ApiRequestConfig) =>
  requestJson<SecurityRiskSnapshotResponse[]>(`/api/admin/security/risk/snapshots${query({ limit })}`, {}, config)

export const resetSecurityRisk = (request: SecurityRiskResetRequest, config?: ApiRequestConfig) =>
  requestJson<SecurityRiskResetResponse>('/api/admin/security/risk/ip/reset', {
    method: 'POST',
    body: JSON.stringify(request)
  }, config)

export const listAntiCrawlerRules = (config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerRuleResponse[]>('/api/admin/security/anti-crawler/rules', {}, config)

export const createAntiCrawlerRule = (request: AntiCrawlerRuleRequest, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerRuleResponse>('/api/admin/security/anti-crawler/rules', {
    method: 'POST',
    body: JSON.stringify(request)
  }, config)

export const updateAntiCrawlerRule = (id: string, request: AntiCrawlerRuleRequest, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerRuleResponse>(`/api/admin/security/anti-crawler/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(request)
  }, config)

export const deleteAntiCrawlerRule = (id: string, config?: ApiRequestConfig) =>
  requestJson<{ deleted: boolean }>(`/api/admin/security/anti-crawler/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }, config)

export const listAntiCrawlerEntries = (listType: 'allowlist' | 'blocklist', config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerListEntryResponse[]>(`/api/admin/security/anti-crawler/${listType}`, {}, config)

export const createAntiCrawlerEntry = (listType: 'allowlist' | 'blocklist', request: AntiCrawlerListEntryRequest, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerListEntryResponse>(`/api/admin/security/anti-crawler/${listType}`, {
    method: 'POST',
    body: JSON.stringify(request)
  }, config)

export const deleteAntiCrawlerEntry = (listType: 'allowlist' | 'blocklist', id: string, config?: ApiRequestConfig) =>
  requestJson<{ deleted: boolean }>(`/api/admin/security/anti-crawler/${listType}/${encodeURIComponent(id)}`, { method: 'DELETE' }, config)

export const simulateAntiCrawlerPolicy = (request: AntiCrawlerSimulationRequest, config?: ApiRequestConfig) =>
  requestJson<AntiCrawlerSimulationResult>('/api/admin/security/anti-crawler/simulate', {
    method: 'POST',
    body: JSON.stringify(request)
  }, config)

export const getPowOverview = (config?: ApiRequestConfig) =>
  requestJson<PowOverviewResponse>('/api/admin/security/pow/overview', {}, config)

export const getPowOptions = (config?: ApiRequestConfig) =>
  requestJson<PowPolicySnapshot>('/api/admin/security/pow/options', {}, config)

export const updatePowOptions = (request: PowOptionsUpdateRequest, config?: ApiRequestConfig) =>
  requestJson<PowPolicySnapshot>('/api/admin/security/pow/options', {
    method: 'PUT',
    body: JSON.stringify(request)
  }, config)

export const rollbackPowOptions = (config?: ApiRequestConfig) =>
  requestJson<PowPolicySnapshot>('/api/admin/security/pow/options/rollback', { method: 'POST' }, config)
