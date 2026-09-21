import { digestPattern, fail, sha } from './runtime-observation-probe-fact-common.mjs'

export function verifyCacheFacts(facts, expectedReleaseId)
{
  if (facts.schema !== 'fsusblog.cache-search-outbox-probe-facts.v1'
    || facts.terminal?.state !== 'converged' || facts.terminal.processedEvents < 1
    || facts.terminal.poisonEvents !== 0 || facts.query?.containsMarker !== true
    || facts.query?.releaseId !== expectedReleaseId
    || facts.query?.releaseScopedPath !== `/release-derived/${expectedReleaseId}/search/index.bin`
    || facts.readModel?.visible !== true || facts.output?.containsMarker !== true
    || !Array.isArray(facts.events) || facts.events.length !== facts.terminal.processedEvents
    || facts.events.some((event) => event.status !== 'processed' || event.last_error != null)
    || new Set(facts.events.map(({ id }) => id)).size !== facts.events.length
    || !Array.isArray(facts.edges?.eventTypes)
    || facts.edges.eventTypes.length !== facts.events.length
    || facts.generation?.present !== true
    || typeof facts.generation?.value !== 'string' || facts.generation.value.length === 0
    || facts.generation.valueDigest !== sha(facts.generation.value)
    || [
      facts.authorityCoordinate?.articleIdDigest,
      facts.authorityCoordinate?.mutationIdDigest,
      facts.generation?.valueDigest,
      facts.query?.searchIndexDigest,
      facts.readModel?.projectionDigest,
      facts.readModel?.detailDigest,
      facts.readModel?.detailTitleDigest,
      facts.output?.navigationDigest,
      facts.output?.envelopeDigest
    ].some((value) => !digestPattern.test(String(value ?? ''))))
  {
    fail('cache/search/outbox facts are stale or partial')
  }
}
