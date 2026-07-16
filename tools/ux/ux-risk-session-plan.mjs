import { resolveSessionFixtureFile } from '../../tests/frontend/support/fixture-paths.mjs'
import { resolveWorkerTestSession } from '../../tests/frontend/support/test-session.mjs'

export function buildUxRiskSessionPlan(sessionCount, options = {}) {
  if (!Number.isInteger(sessionCount) || sessionCount <= 0) {
    throw new Error(`UX risk session count must be a positive integer, got ${sessionCount}`)
  }

  const env = options.env ?? process.env
  const fixtureOptions = {
    env,
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {})
  }
  const sessionIds = Array.from(
    { length: sessionCount },
    (_, index) => resolveWorkerTestSession(index, env)
  )
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new Error('UX risk session plan contains duplicate session IDs')
  }

  const fixtureFiles = sessionIds.map((sessionId) =>
    resolveSessionFixtureFile(sessionId, fixtureOptions))

  return {
    sessionIds,
    fixtureFiles,
    bootstrapFixtureFile: fixtureFiles[0]
  }
}
