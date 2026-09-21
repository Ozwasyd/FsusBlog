import { fail, refreshHashDigest } from './runtime-observation-probe-fact-common.mjs'
import { verifyCacheFacts } from './runtime-observation-probe-cache-facts.mjs'
import { deriveProbeRawFacts } from './runtime-observation-probe-raw-facts.mjs'
import { verifyRouteFacts } from './runtime-observation-probe-route-facts.mjs'
import { verifySessionFacts } from './runtime-observation-probe-session-facts.mjs'

export { deriveProbeRawFacts, refreshHashDigest }

export function verifyFacts(kind, facts, {
  fixture = null,
  fixtureProjection: projectedFixture = null,
  expectedReleaseId = null
} = {})
{
  if (fixture && !projectedFixture) fail('verified fixture projection is required')
  if (facts?.coherent !== true) fail(`${kind} facts are partial or incoherent`)
  if (kind === 'route-response-error')
  {
    return verifyRouteFacts(facts, { fixture, projectedFixture, expectedReleaseId })
  }
  if (kind === 'session-cookie-runtime')
  {
    return verifySessionFacts(facts, expectedReleaseId)
  }
  if (kind === 'cache-search-outbox-convergence')
  {
    return verifyCacheFacts(facts, expectedReleaseId)
  }
  fail(`unsupported probe kind: ${kind}`)
}
