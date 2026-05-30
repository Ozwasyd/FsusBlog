import { getBrowserFp } from '@/utils/fingerprint'
import { appErrorFromStatus, createAppError, AppErrorCode } from '@/utils/appError'
import { FSUS_HEADERS } from './contracts'

export type HumanReadScope = 'site' | 'article'

export type HumanReadChallenge = {
  token: string
  scope: HumanReadScope
  routeKey: string
  articleId: number | null
  minDwellMs: number
  issuedAt: string
  expiresAt: string
}

export type HumanReadSubmitResult = {
  counted: boolean
  status: string
}

type JsonApiResponse<T> = {
  success: boolean
  data?: T | null
  message?: string | null
}

function browserHeaders(): Headers {
  const headers = new Headers()
  headers.set('Accept', 'application/json')
  headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp())
  return headers
}

async function readJsonEnvelope<T>(response: Response): Promise<T> {
  const envelope = await response.json() as JsonApiResponse<T>
  if (!response.ok || !envelope.success || envelope.data == null) {
    const message = envelope.message || `read_proof_request_failed:${response.status}`
    if (!response.ok) {
      throw appErrorFromStatus(response.status, message)
    }

    throw createAppError(AppErrorCode.ProtocolFailure, message, { status: response.status })
  }

  return envelope.data
}

export async function requestHumanReadChallenge(input: {
  scope: HumanReadScope
  routeKey: string
  articleId?: number | null
  signal?: AbortSignal
}): Promise<HumanReadChallenge> {
  const params = new URLSearchParams()
  params.set('scope', input.scope)
  params.set('routeKey', input.routeKey)
  if (input.articleId != null) {
    params.set('articleId', String(input.articleId))
  }

  const response = await fetch(`/api/read-proof/challenge?${params.toString()}`, {
    credentials: 'include',
    headers: browserHeaders(),
    signal: input.signal
  })
  return await readJsonEnvelope<HumanReadChallenge>(response)
}

export async function submitHumanReadProof(input: {
  token: string
  scope: HumanReadScope
  routeKey: string
  articleId?: number | null
  dwellMs: number
  signal?: AbortSignal
}): Promise<HumanReadSubmitResult> {
  const headers = browserHeaders()
  headers.set('Content-Type', 'application/json')

  const response = await fetch('/api/read-proof/submit', {
    method: 'POST',
    credentials: 'include',
    headers,
    signal: input.signal,
    body: JSON.stringify({
      token: input.token,
      scope: input.scope,
      routeKey: input.routeKey,
      articleId: input.articleId ?? null,
      dwellMs: input.dwellMs
    })
  })
  return await readJsonEnvelope<HumanReadSubmitResult>(response)
}
