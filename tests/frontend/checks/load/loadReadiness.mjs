import { fetchWithTimeout } from '../../support/http.mjs'

export function matchesExpectedStatus(response, expectedStatuses = null) {
  return expectedStatuses ? expectedStatuses.includes(response.status) : response.ok
}

function readinessDelayMs(response, remainingMs, requestTimeoutMs) {
  const retryAfterSeconds = Number(response.headers.get('retry-after'))
  const fallbackMs = Math.max(50, Math.min(250, Math.floor(requestTimeoutMs / 60)))
  const requestedMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : fallbackMs
  return Math.max(1, Math.min(requestedMs, remainingMs))
}

export async function waitForReadyResponse(
  { name, url, headers, expectedStatuses = null },
  {
    requestTimeoutMs,
    fetchResponse = fetchWithTimeout,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now,
    log = console.log
  } = {}
) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('readiness request timeout must be a positive number')
  }

  const deadlineAt = now() + requestTimeoutMs * 2
  const statusCounts = {}
  let attempts = 0

  while (now() < deadlineAt) {
    const remainingBeforeRequestMs = deadlineAt - now()
    const response = await fetchResponse(
      url,
      { headers },
      Math.max(1, Math.min(requestTimeoutMs, remainingBeforeRequestMs))
    )
    attempts += 1
    statusCounts[response.status] = (statusCounts[response.status] || 0) + 1
    if (matchesExpectedStatus(response, expectedStatuses)) {
      if (attempts > 1) {
        log(`[check-load-public-api] ready: ${name} attempts=${attempts} statuses=${JSON.stringify(statusCounts)}`)
      }
      return response
    }

    await response.arrayBuffer()
    if (![410, 503].includes(response.status)) {
      throw new Error(`[${name}] readiness returned unexpected status ${response.status} for ${url}`)
    }

    const remainingMs = deadlineAt - now()
    if (remainingMs <= 0) break
    await sleep(readinessDelayMs(response, remainingMs, requestTimeoutMs))
  }

  throw new Error(`[${name}] readiness did not converge statuses=${JSON.stringify(statusCounts)}`)
}
