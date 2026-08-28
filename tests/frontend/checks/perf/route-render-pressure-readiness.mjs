function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function isNavigationContextReset(error) {
  const message = errorMessage(error)
  return /execution context was destroyed|most likely because of a navigation|cannot find context with specified id/iu.test(message)
}

export async function evaluateAfterNavigationSettles(page, pageFunction, argument, options = {}) {
  if (options.maxAttempts !== undefined && Number(options.maxAttempts) !== 1) {
    throw new Error('route render pressure correctness evaluation permits exactly one attempt')
  }
  return await page.evaluate(pageFunction, argument)
}
