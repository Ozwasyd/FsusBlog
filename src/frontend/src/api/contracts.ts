export const AEDS_BINARY_MEDIA_TYPE = 'application/octet-stream'
export const PUBLIC_AOT_HYDRATION_MEDIA_TYPE = 'application/vnd.fsus.aeds'

export const FSUS_HEADERS = Object.freeze({
  deviceFingerprint: 'X-Fsus-Device-Fp',
  powProof: 'X-Fsus-Pow-Proof',
  challengeProof: 'X-Fsus-Challenge-Proof',
  challengeId: 'X-Fsus-Challenge-Id',
  challengeKind: 'X-Fsus-Challenge-Kind',
  challengeProofOutcome: 'X-Fsus-Challenge-Proof-Outcome',
  challengeAction: 'X-Fsus-Challenge-Action',
  challengeRouteKey: 'X-Fsus-Challenge-Route-Key',
  challengePolicyVersion: 'X-Fsus-Challenge-Policy-Version',
  riskDecision: 'X-Fsus-Risk-Decision',
  frameVersion: 'X-Fsus-Frame-Version',
  csrfToken: 'X-Fsus-Csrf-Token'
})

export function withBinaryAccept(headers?: HeadersInit): Headers {
  const created = new Headers(headers)
  created.set('Accept', AEDS_BINARY_MEDIA_TYPE)
  return created
}

export function applyBinaryRequestHeaders(headers: Headers, hasBody: boolean): Headers {
  headers.set('Accept', AEDS_BINARY_MEDIA_TYPE)
  if (hasBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', AEDS_BINARY_MEDIA_TYPE)
  }

  return headers
}
