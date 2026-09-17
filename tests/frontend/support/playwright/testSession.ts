import type { BrowserContextOptions } from '@playwright/test'
import { resolveSessionFixtureFile } from '../fixture-paths.mjs'
import { resolveWorkerTestSession, sanitizeTestSession } from '../test-session.mjs'

export const TEST_SESSION_HEADER = 'X-Fsus-Test-Session'

export function resolveTestSession(explicitSession?: string): string | undefined {
  if (explicitSession) {
    return sanitizeTestSession(explicitSession)
  }
  if (process.env.FSUSBLOG_TEST_SESSION_ISOLATION !== '1' && !process.env.FSUSBLOG_TEST_SESSION) {
    return undefined
  }

  if (process.env.FSUSBLOG_TEST_SESSION) {
    return sanitizeTestSession(process.env.FSUSBLOG_TEST_SESSION)
  }

  const workerIndex = process.env.TEST_PARALLEL_INDEX || process.env.TEST_WORKER_INDEX || '0'
  return resolveWorkerTestSession(workerIndex)
}

export function testSessionHeaders(explicitSession?: string): Record<string, string> {
  const session = resolveTestSession(explicitSession)
  return session ? { [TEST_SESSION_HEADER]: session } : {}
}

export function withTestSessionContextOptions(
  options: BrowserContextOptions = {},
  explicitSession?: string
): BrowserContextOptions {
  const headers = testSessionHeaders(explicitSession)
  if (Object.keys(headers).length === 0) {
    return options
  }

  return {
    ...options,
    extraHTTPHeaders: {
      ...(options.extraHTTPHeaders ?? {}),
      ...headers
    }
  }
}

export function resolveTestSessionFixtureFile(repoRoot?: string): string | undefined {
  const session = resolveTestSession()
  if (!session) {
    return undefined
  }

  return resolveSessionFixtureFile(session, repoRoot
    ? { env: process.env, repoRoot }
    : { env: process.env })
}
