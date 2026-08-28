import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const observationRelative = '.tmp/contracts/content-lifecycle/content-lifecycle-observation.json'
const expectedArtifactId = 'content-lifecycle-observation'
const expectedSchema = 'fsusblog.content-lifecycle-observation.v2'

const requiredFactKeys = Object.freeze([
  'article.lifecycle.states',
  'article.lifecycle.allowed-transitions',
  'article.lifecycle.forbidden-transitions',
  'article.publication.required-coordinates',
  'article.scheduled.boundary',
  'article.scheduled.preDueCurrent',
  'article.scheduled.dueTransition',
  'article.scheduled.replaceCancelStale',
  'article.rollback.semantics',
  'article.rollback.causal',
  'article.restore.semantics',
  'article.restore.causal',
  'article.delete.semantics',
  'article.delete.causal',
  'article.public-visibility.states',
  'article.outbox.required-edges',
  'article.outbox.optional-edges',
  'article.outbox.terminal-states',
  'article.rights.required-fields',
  'article.responsibility.requirement',
  'comment.moderation.states',
  'comment.moderation.allowed-transitions',
  'comment.public-visibility.states',
  'comment.thread.max-depth',
  'comment.thread.child-limit',
  'comment.thread.root-parent-invariants',
  'comment.edit-delete.version-semantics',
  'comment.region.visibility-states',
  'comment.deletedRoot.publicDescendants',
  'comment.deletedRoot.adminDescendants',
  'comment.outbox.required-edges',
  'comment.notification.conditions',
  'comment.privacy.persisted-fields',
  'comment.privacy.forbidden-exact-fields',
  'comment.appeal.allowed-source-states'
])

function failResult(reasons)
{
  return {
    status: 'failed',
    failureReasons: reasons.map(String),
    observations: {}
  }
}

function isSortedUniqueStrings(values)
{
  if (!Array.isArray(values) || values.length === 0) return false
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return false
  if (new Set(values).size !== values.length) return false
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted.every((value, index) => value === values[index])
}

function isTypedBoundary(value)
{
  return value != null
    && typeof value === 'object'
    && typeof value.value === 'number'
    && Number.isFinite(value.value)
    && typeof value.unit === 'string'
    && value.unit.length > 0
}

const causalFactKeys = Object.freeze([
  'article.scheduled.preDueCurrent',
  'article.scheduled.dueTransition',
  'article.scheduled.replaceCancelStale',
  'article.rollback.causal',
  'article.restore.causal',
  'article.delete.causal',
  'comment.deletedRoot.publicDescendants',
  'comment.deletedRoot.adminDescendants'
])

function validateCausalFact(key, fact)
{
  const failures = []
  const expectedId = {
    'article.scheduled.preDueCurrent': 'article.scheduled.pre-due-current-publication',
    'article.scheduled.dueTransition': 'article.scheduled.due-publication-transition',
    'article.scheduled.replaceCancelStale': 'article.scheduled.replace-cancel-stale',
    'article.rollback.causal': 'article.rollback.new-revision-publication',
    'article.restore.causal': 'article.restore.new-publication-no-revision',
    'article.delete.causal': 'article.delete.visibility-history',
    'comment.deletedRoot.publicDescendants': 'comment.deleted-root.public-descendants',
    'comment.deletedRoot.adminDescendants': 'comment.deleted-root.admin-descendants'
  }[key]
  if (fact == null || typeof fact !== 'object' || Array.isArray(fact))
  {
    return [`${key} must be a causal fact object`]
  }
  const exactKeys = [
    'condition', 'conflictStatus', 'direction', 'factId', 'object', 'predicate',
    'proofTests', 'schemaVersion', 'scope', 'sourceRanges', 'subject', 'truthValue'
  ]
  if (JSON.stringify(Object.keys(fact).sort()) !== JSON.stringify(exactKeys))
  {
    failures.push(`${key} causal fact fields are not closed`)
  }
  if (fact.factId !== expectedId || fact.schemaVersion !== 1 || fact.direction !== 'forward'
    || fact.truthValue !== true || fact.conflictStatus !== 'consistent')
  {
    failures.push(`${key} causal identity/truth/conflict fields are invalid`)
  }
  for (const field of ['subject', 'predicate', 'object', 'condition', 'scope'])
  {
    if (typeof fact[field] !== 'string' || fact[field].trim().length === 0)
    {
      failures.push(`${key}.${field} must be non-empty`)
    }
  }
  if (fact.sourceRanges == null || typeof fact.sourceRanges !== 'object' || Array.isArray(fact.sourceRanges)
    || Object.keys(fact.sourceRanges).length === 0
    || Object.entries(fact.sourceRanges).some(([sourceId, source]) => !/^source[1-9][0-9]*$/u.test(sourceId)
      || Object.keys(source ?? {}).sort().join('\0') !== 'owner\0range'
      || typeof source.owner !== 'string' || !source.owner.startsWith('src/')
      || typeof source.range !== 'string' || source.range.length === 0))
  {
    failures.push(`${key} must bind production source owners and symbol ranges`)
  }
  if (!isSortedUniqueStrings([...fact.proofTests].sort()) || fact.proofTests.length === 0)
  {
    failures.push(`${key} must bind unique proof test IDs`)
  }
  return failures
}

/**
 * compiled-assembly extractor for article/comment lifecycle, visibility and outbox facts.
 * Reads only the sealed observation artifact for this exact build identity.
 * Never reads docs, fixtures, expected transition tables, or historical baselines.
 */
// BEHAVIOR-OWNER: article-comment-lifecycle-outbox
export function extract(context)
{
  const buildIdentity = context.buildIdentity
  if (buildIdentity == null || typeof buildIdentity !== 'object')
  {
    return failResult(['content-lifecycle-fact-extractor requires exact buildIdentity'])
  }
  if (buildIdentity.artifactId !== expectedArtifactId)
  {
    return failResult([`unexpected artifactId ${buildIdentity.artifactId}`])
  }
  if (/bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.artifactId))
    || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
  {
    return failResult(['refuses ambient bin/Debug or bin/Release observation identity'])
  }

  const absolute = path.join(context.repositoryRoot, observationRelative)
  if (!existsSync(absolute))
  {
    return failResult([`missing sealed observation artifact ${observationRelative}`])
  }

  const bytes = readFileSync(absolute)
  const artifactDigest = createHash('sha256').update(bytes).digest('hex')
  if (artifactDigest !== buildIdentity.artifactDigest)
  {
    return failResult([
      `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildIdentity.artifactDigest}, got ${artifactDigest})`
    ])
  }

  let observation
  try
  {
    observation = JSON.parse(bytes.toString('utf8'))
  }
  catch (error)
  {
    return failResult([`observation JSON parse failed: ${error instanceof Error ? error.message : String(error)}`])
  }

  if (observation?.schema !== expectedSchema)
  {
    return failResult([`observation schema is not ${expectedSchema}`])
  }
  if (observation.source === 'checked-in-docs'
    || observation.source === 'test-fixture'
    || observation.source === 'expected-transition-table'
    || observation.generatedFromDocs === true)
  {
    return failResult(['observation must not be reverse-generated from docs, fixtures, or expected transition tables'])
  }
  if (observation.status === 'failed' || (Array.isArray(observation.failureReasons) && observation.failureReasons.length > 0))
  {
    return failResult([
      'observation host reported coherence failure',
      ...(Array.isArray(observation.failureReasons) ? observation.failureReasons.map(String) : [])
    ])
  }

  const facts = observation.facts
  if (facts == null || typeof facts !== 'object' || Array.isArray(facts))
  {
    return failResult(['observation.facts missing'])
  }

  const failureReasons = []
  for (const key of requiredFactKeys)
  {
    if (!Object.hasOwn(facts, key)) failureReasons.push(`missing required fact ${key}`)
  }
  if (failureReasons.length > 0) return failResult(failureReasons)

  if (!isSortedUniqueStrings(facts['article.lifecycle.states']))
  {
    failureReasons.push('article.lifecycle.states must be a sorted unique string set')
  }
  if (!isSortedUniqueStrings(facts['article.lifecycle.allowed-transitions']))
  {
    failureReasons.push('article.lifecycle.allowed-transitions must be a sorted unique directed-edge set')
  }
  if (!isSortedUniqueStrings(facts['article.lifecycle.forbidden-transitions']))
  {
    failureReasons.push('article.lifecycle.forbidden-transitions must be a sorted unique directed-edge set')
  }
  if (!isSortedUniqueStrings(facts['article.publication.required-coordinates']))
  {
    failureReasons.push('article.publication.required-coordinates must be a sorted unique field set')
  }
  if (!isSortedUniqueStrings(facts['article.outbox.required-edges']))
  {
    failureReasons.push('article.outbox.required-edges must be a sorted unique edge set')
  }
  if (!isSortedUniqueStrings(facts['article.outbox.optional-edges']))
  {
    failureReasons.push('article.outbox.optional-edges must be a sorted unique edge set')
  }
  if (!isSortedUniqueStrings(facts['article.outbox.terminal-states']))
  {
    failureReasons.push('article.outbox.terminal-states must be a sorted unique set')
  }
  if (!isSortedUniqueStrings(facts['article.rights.required-fields']))
  {
    failureReasons.push('article.rights.required-fields must be a sorted unique field set')
  }

  const publicVisibility = facts['article.public-visibility.states']
  if (publicVisibility == null || typeof publicVisibility !== 'object' || Array.isArray(publicVisibility))
  {
    failureReasons.push('article.public-visibility.states must be a state→surface map')
  }
  else
  {
    if (publicVisibility.Published !== true)
    {
      failureReasons.push('article public visibility must admit Published')
    }
    for (const state of ['Draft', 'Scheduled', 'Archived', 'Deleted'])
    {
      if (publicVisibility[state] !== false)
      {
        failureReasons.push(`article public visibility must deny ${state}`)
      }
    }
  }

  const requiredEdges = facts['article.outbox.required-edges']
  const optionalEdges = facts['article.outbox.optional-edges']
  if (Array.isArray(requiredEdges) && Array.isArray(optionalEdges))
  {
    const overlap = requiredEdges.filter((edge) => optionalEdges.includes(edge))
    if (overlap.length > 0)
    {
      failureReasons.push(`article outbox required/optional edges must be disjoint: ${overlap.join(',')}`)
    }
    if (requiredEdges.includes('integrity-proof'))
    {
      failureReasons.push('integrity-proof must not be a required article outbox edge')
    }
    if (!requiredEdges.includes('public-hot-read'))
    {
      failureReasons.push('public-hot-read must be a required article outbox edge')
    }
    if (!optionalEdges.includes('integrity-proof') || !optionalEdges.includes('notification'))
    {
      failureReasons.push('integrity-proof and notification must be optional article outbox edges')
    }
  }

  const restore = facts['article.restore.semantics']
  if (restore?.source !== 'Deleted' || restore?.target !== 'Published' || restore?.revivesOldPublicationPointer !== false)
  {
    failureReasons.push('restore must be Deleted→Published with new publication semantics')
  }

  const rollback = facts['article.rollback.semantics']
  if (!Array.isArray(rollback?.allowedTargets)
    || !rollback.allowedTargets.includes('Draft')
    || !rollback.allowedTargets.includes('Published')
    || !rollback.allowedTargets.includes('Archived')
    || (Array.isArray(rollback?.forbiddenTargets) && !rollback.forbiddenTargets.includes('Scheduled')))
  {
    failureReasons.push('rollback targets must allow Draft|Published|Archived and forbid Scheduled')
  }

  if (!isSortedUniqueStrings(facts['comment.moderation.states']))
  {
    failureReasons.push('comment.moderation.states must be a sorted unique string set')
  }
  if (!isSortedUniqueStrings(facts['comment.moderation.allowed-transitions']))
  {
    failureReasons.push('comment.moderation.allowed-transitions must be a sorted unique directed-edge set')
  }
  if (Array.isArray(facts['comment.moderation.allowed-transitions'])
    && facts['comment.moderation.allowed-transitions'].some((edge) => String(edge).endsWith('->Pending')))
  {
    failureReasons.push('comment moderation must not allow transitions back to Pending')
  }

  const commentPublic = facts['comment.public-visibility.states']
  if (commentPublic == null || typeof commentPublic !== 'object' || Array.isArray(commentPublic))
  {
    failureReasons.push('comment.public-visibility.states must be a state→surface map (not a boolean)')
  }
  else
  {
    if (commentPublic.Approved !== true)
    {
      failureReasons.push('comment public visibility must admit Approved')
    }
    for (const state of ['Pending', 'Rejected', 'Hidden'])
    {
      if (commentPublic[state] !== false)
      {
        failureReasons.push(`comment public visibility must deny ${state}`)
      }
    }
  }

  // Public and admin visibility must remain separate surfaces.
  if (facts['comment.admin-visibility.states'] != null)
  {
    if (!isSortedUniqueStrings(facts['comment.admin-visibility.states']))
    {
      failureReasons.push('comment.admin-visibility.states must be a sorted unique set when present')
    }
    if (JSON.stringify(facts['comment.admin-visibility.states']) === JSON.stringify(['Approved']))
    {
      failureReasons.push('comment admin visibility must not collapse to public Approved-only set')
    }
  }

  const maxDepth = facts['comment.thread.max-depth']
  if (!isTypedBoundary(maxDepth?.default)
    || !isTypedBoundary(maxDepth?.minimum)
    || !isTypedBoundary(maxDepth?.maximum)
    || maxDepth.minimum?.boundary !== 'inclusive'
    || maxDepth.maximum?.boundary !== 'inclusive')
  {
    failureReasons.push('comment.thread.max-depth must declare typed default/min/max with inclusive boundaries and units')
  }

  const childLimit = facts['comment.thread.child-limit']
  if (!isTypedBoundary(childLimit?.default)
    || !isTypedBoundary(childLimit?.minimum)
    || !isTypedBoundary(childLimit?.maximum))
  {
    failureReasons.push('comment.thread.child-limit must declare typed default/min/max with units')
  }

  if (!isSortedUniqueStrings(facts['comment.privacy.persisted-fields']))
  {
    failureReasons.push('comment.privacy.persisted-fields must be a sorted unique field set')
  }
  if (!isSortedUniqueStrings(facts['comment.privacy.forbidden-exact-fields']))
  {
    failureReasons.push('comment.privacy.forbidden-exact-fields must be a sorted unique field set from projection contract')
  }
  if (Array.isArray(facts['comment.privacy.forbidden-exact-fields'])
    && !facts['comment.privacy.forbidden-exact-fields'].includes('userId')
    && !facts['comment.privacy.forbidden-exact-fields'].includes('user_id'))
  {
    failureReasons.push('privacy forbidden exact fields must include user identity keys from formal contract')
  }

  if (!isSortedUniqueStrings(facts['comment.appeal.allowed-source-states']))
  {
    failureReasons.push('comment.appeal.allowed-source-states must be a sorted unique set')
  }
  else
  {
    for (const required of ['Hidden', 'Rejected'])
    {
      if (!facts['comment.appeal.allowed-source-states'].includes(required))
      {
        failureReasons.push(`appeal source states must include ${required}`)
      }
    }
  }

  const outboxEdges = facts['comment.outbox.required-edges']
  if (outboxEdges == null || typeof outboxEdges !== 'object' || Array.isArray(outboxEdges))
  {
    failureReasons.push('comment.outbox.required-edges must be eventType→edge-set map')
  }

  const scheduled = facts['article.scheduled.boundary']
  if (scheduled?.scheduledPublishAt?.relationToUtcNow !== 'strictly-after'
    || scheduled?.scheduledPublishAt?.boundary !== 'exclusive')
  {
    failureReasons.push('article.scheduled.boundary must declare exclusive strictly-after utc boundary')
  }

  for (const key of causalFactKeys)
  {
    failureReasons.push(...validateCausalFact(key, facts[key]))
  }

  const rollbackCausal = facts['article.rollback.causal']
  if (!String(rollbackCausal?.object ?? '').includes('new revision and new publication'))
  {
    failureReasons.push('rollback causal fact must bind both new revision and new publication coordinates')
  }
  const restoreCausal = facts['article.restore.causal']
  if (!String(restoreCausal?.object ?? '').includes('without reviving the old publication or creating a new revision'))
  {
    failureReasons.push('restore causal fact must reject old-publication revival and new revision creation')
  }
  const deleteCausal = facts['article.delete.causal']
  if (!String(deleteCausal?.object ?? '').includes('without creating revision publication or tombstone'))
  {
    failureReasons.push('delete causal fact must explicitly reject revision publication and tombstone creation')
  }

  const coherence = facts.coherence
  if (coherence != null)
  {
    for (const key of [
      'articleEntityCoreProjection',
      'articleOutboxRequiredOptional',
      'commentOutboxProducerDispatcher'
    ])
    {
      if (coherence[key] === 'inconsistent')
      {
        failureReasons.push(`multi-layer coherence failed: ${key}`)
      }
    }
    if (coherence.commentPublicAdminVisibilitySeparated !== true)
    {
      failureReasons.push('public and admin comment visibility must be separately expressed')
    }
  }

  const serialized = JSON.stringify(observation)
  if (serialized.includes('expected-transition-table')
    || serialized.includes('comment-moderation-state-machine.yaml')
    || serialized.includes('docs/api/article-publication-revisions.md'))
  {
    return failResult(['observation must not reference docs/yaml/test expected transition authorities'])
  }

  if (failureReasons.length > 0) return failResult(failureReasons)

  const observationFacts = {}
  for (const key of requiredFactKeys)
  {
    observationFacts[key] = facts[key]
  }
  if (facts['article.admin-visibility.states'] != null)
  {
    observationFacts['article.admin-visibility.states'] = facts['article.admin-visibility.states']
  }
  if (facts['comment.admin-visibility.states'] != null)
  {
    observationFacts['comment.admin-visibility.states'] = facts['comment.admin-visibility.states']
  }
  if (facts['comment.outbox.consumer-registry'] != null)
  {
    observationFacts['comment.outbox.consumer-registry'] = facts['comment.outbox.consumer-registry']
  }
  if (facts['comment.outbox.terminal-states'] != null)
  {
    observationFacts['comment.outbox.terminal-states'] = facts['comment.outbox.terminal-states']
  }
  if (facts['article.outbox.event-types'] != null)
  {
    observationFacts['article.outbox.event-types'] = facts['article.outbox.event-types']
  }
  if (facts['comment.moderation.forbidden-transitions'] != null)
  {
    observationFacts['comment.moderation.forbidden-transitions'] = facts['comment.moderation.forbidden-transitions']
  }
  const observations = {
    facts: observationFacts,
    observationDigest: String(observation.observationDigest),
    artifactDigest,
    source: String(observation.source ?? 'compiled-production-constants')
  }
  if (facts.coherence != null)
  {
    observations.coherence = facts.coherence
  }

  return {
    status: 'ok',
    failureReasons: [],
    observations
  }
}
