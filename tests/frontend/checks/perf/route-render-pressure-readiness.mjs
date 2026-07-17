function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function isNavigationContextReset(error) {
  const message = errorMessage(error)
  return /execution context was destroyed|most likely because of a navigation|cannot find context with specified id/iu.test(message)
}

export async function evaluateAfterNavigationSettles(page, pageFunction, argument, options = {}) {
  const maxAttempts = Math.max(1, Math.trunc(Number(options.maxAttempts) || 3))
  const settleDelayMs = Math.max(
    0,
    Math.trunc(options.settleDelayMs === undefined ? 100 : Number(options.settleDelayMs))
  )
  const loadStateTimeoutMs = Math.max(1, Math.trunc(Number(options.loadStateTimeoutMs) || 10_000))

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, argument)
    } catch (error) {
      if (!isNavigationContextReset(error) || attempt === maxAttempts) throw error
      await page.waitForLoadState('domcontentloaded', { timeout: loadStateTimeoutMs }).catch(() => {})
      if (settleDelayMs > 0) await page.waitForTimeout(settleDelayMs)
    }
  }

  throw new Error('route render pressure evaluation exhausted without a result')
}
