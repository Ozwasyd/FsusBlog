function responseStatus(response) {
  return typeof response?.status === 'function' ? response.status() : response?.status
}

function responseHeaders(response) {
  const headers = typeof response?.headers === 'function' ? response.headers() : response?.headers
  if (!headers || typeof headers !== 'object') return {}
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
  )
}

export function retryablePublicAotDelayMs(response) {
  if (responseStatus(response) !== 503) return null

  const headers = responseHeaders(response)
  const retryAfter = headers['retry-after'] ?? ''
  if (!/^\d+$/u.test(retryAfter) || Number(retryAfter) <= 0) return null
  if (headers['x-fsus-public-aot-source'] !== 'server-status') return null
  if (headers['x-fsus-public-aot-state'] !== 'transient-failure') return null
  if (!String(headers['cache-control'] ?? '').toLowerCase().includes('no-store')) return null
  if (!String(headers['x-robots-tag'] ?? '').toLowerCase().includes('noindex')) return null

  return Number(retryAfter) * 1_000
}

export async function navigateThroughRetryablePublicAot({
  navigate,
  sleep,
  deadlineAtMs,
  now = Date.now,
  onRetryableResponse = null
}) {
  if (typeof navigate !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('public AOT navigation requires navigate and sleep functions')
  }
  if (onRetryableResponse !== null && typeof onRetryableResponse !== 'function') {
    throw new TypeError('public AOT navigation retry observer must be a function')
  }
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= now()) {
    throw new TypeError('public AOT navigation requires a future runtime-derived deadline')
  }

  while (true) {
    const response = await navigate()
    const retryDelayMs = retryablePublicAotDelayMs(response)
    if (retryDelayMs === null) return response

    const remainingMs = deadlineAtMs - now()
    if (retryDelayMs >= remainingMs) {
      throw new Error(
        `retryable public AOT response exceeds the runtime navigation deadline: retryAfterMs=${retryDelayMs} remainingMs=${Math.max(0, remainingMs)}`
      )
    }
    await onRetryableResponse?.({ response, retryDelayMs })
    await sleep(retryDelayMs)
  }
}
