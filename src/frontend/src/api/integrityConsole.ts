import type { ApiRequestConfig } from './requestConfig'

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof'
const ENDPOINT = '/api/admin/integrity/console'

export interface IntegrityAdminConsoleQuery {
  articleId?: number | null
  articleRevisionId?: number | null
  revisionNo?: number | null
}

export interface IntegrityAdminConsoleResponse {
  checkedAtUtc: string
  proofs: IntegrityAdminProofSummaryResponse
  transparencyLog: IntegrityAdminTransparencyLogStatusResponse
  checkpoint: IntegrityAdminCheckpointStatusResponse
  keyRegistry: IntegrityAdminKeyRegistryResponse
  recentProofs: IntegrityAdminProofRowResponse[]
  failedOrRetryingProofs: IntegrityAdminProofRowResponse[]
}

export interface IntegrityAdminProofSummaryResponse {
  total: number
  pending: number
  ready: number
  failed: number
  retrying: number
  superseded: number
  notPublic: number
}

export interface IntegrityAdminTransparencyLogStatusResponse {
  status: string
  headSeq: number | null
  headHash: string | null
  errorCode: string | null
  failedSeq: number | null
}

export interface IntegrityAdminCheckpointStatusResponse {
  status: string
  checkpointKind: string | null
  scopeKey: string | null
  logHeadSeq: number | null
  logHeadHash: string | null
  createdAtUtc: string | null
}

export interface IntegrityAdminKeyRegistryResponse {
  currentKeyId: string | null
  keys: IntegrityAdminKeyStatusResponse[]
}

export interface IntegrityAdminKeyStatusResponse {
  keyId: string
  version: number | null
  algorithm: string
  status: string
  revokedAtUtc: string | null
  compromisedAtUtc: string | null
}

export interface IntegrityAdminProofRowResponse {
  proofId: number
  articleId: number
  articleRevisionId: number
  revisionNo: number
  proofStatus: string
  artifactStatus: string
  signatureStatus: string
  transparencyLogStatus: string
  checkpointStatus: string
  canonicalHash: string | null
  signingKeyId: string | null
  failureCode: string | null
  retryAvailable: boolean
  publishedAtUtc: string
  updatedAtUtc: string
}

export interface IntegrityAdminRetryResponse {
  proofId: number
  proofStatus: string
  retriedAtUtc: string
}

export async function getIntegrityAdminConsole(
  query: IntegrityAdminConsoleQuery = {},
  config?: ApiRequestConfig
): Promise<IntegrityAdminConsoleResponse> {
  const search = new URLSearchParams()
  if (query.articleId) search.set('articleId', String(query.articleId))
  if (query.articleRevisionId) search.set('articleRevisionId', String(query.articleRevisionId))
  if (query.revisionNo) search.set('revisionNo', String(query.revisionNo))

  return requestJson<IntegrityAdminConsoleResponse>(
    `${ENDPOINT}${search.size ? `?${search.toString()}` : ''}`,
    { signal: config?.signal, method: 'GET' }
  )
}

export async function retryIntegrityProof(
  proofId: number,
  mfaProofToken: string,
  config?: ApiRequestConfig
): Promise<IntegrityAdminRetryResponse> {
  const headers = new Headers()
  headers.set(ADMIN_SENSITIVE_MFA_HEADER, mfaProofToken)
  return requestJson<IntegrityAdminRetryResponse>(
    `${ENDPOINT}/proofs/${proofId}/retry`,
    {
      method: 'POST',
      signal: config?.signal,
      headers
    }
  )
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: init.headers ?? new Headers()
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}`)
  }

  return await response.json() as T
}
