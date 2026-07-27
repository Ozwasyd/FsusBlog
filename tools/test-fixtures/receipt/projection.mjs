/**
 * Narrow ID projection from a verified FixtureReceipt (#1710).
 *
 * Projections are consumer convenience only — never authoritative receipt evidence.
 */

import { digestCanonical, freezeDeep } from './canonical.mjs'
import { validateFixtureReceipt } from './fixture-receipt.mjs'
import { writePrivateJson } from './private-io.mjs'
import { assertNoSecrets } from './secrets.mjs'
import { FIXTURE_ID_PROJECTION_SCHEMA } from './schemas.mjs'

/**
 * Deterministically project stable entity IDs from a verified receipt.
 */
export function projectFixtureIds(receipt, {
  catalogs,
  requireVerified = true
} = {}) {
  const validated = validateFixtureReceipt(receipt, { catalogs, requireVerified })
  if (validated.terminalStatus !== 'verified') {
    throw new Error('ID projection requires a verified FixtureReceipt')
  }

  const entities = []
  for (const producerReceipt of validated.producerReceipts ?? []) {
    for (const entity of producerReceipt.entityIdentities ?? []) {
      entities.push({
        producerId: producerReceipt.producerId,
        kind: entity.kind,
        id: entity.id,
        handle: entity.handle ?? null
      })
    }
  }
  entities.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))

  const byKind = {}
  for (const entity of entities) {
    if (!byKind[entity.kind]) byKind[entity.kind] = []
    byKind[entity.kind].push(entity.id)
  }

  const projection = freezeDeep({
    schema: FIXTURE_ID_PROJECTION_SCHEMA,
    authority: 'derived-from-verified-fixture-receipt',
    notAuthoritative: true,
    sourceReceiptDigest: validated.receiptDigest,
    profileId: validated.profileIdentity.profileId,
    runId: validated.executionIdentity.runId,
    namespace: validated.executionIdentity.namespace,
    catalogDigest: validated.catalogDigest,
    entities: Object.freeze(entities.map((item) => freezeDeep(item))),
    idsByKind: freezeDeep(byKind),
    // Convenience single-ID fields when exactly one article/category/tag exists.
    articleId: byKind.article?.length === 1 ? byKind.article[0] : null,
    categoryId: byKind.category?.length === 1 ? byKind.category[0] : null,
    tagId: byKind.tag?.length === 1 ? byKind.tag[0] : null,
    projectionDigest: null
  })

  assertNoSecrets(projection)
  const projectionDigest = digestCanonical({
    ...projection,
    projectionDigest: undefined
  })
  return freezeDeep({ ...projection, projectionDigest })
}

export function writeFixtureIdProjection(file, receipt, options = {}) {
  const projection = projectFixtureIds(receipt, options)
  writePrivateJson(file, projection, { label: 'fixture-id-projection' })
  return projection
}

/**
 * Fail closed if a consumer treats a projection document as a verified receipt.
 */
export function assertNotAuthoritativeReceipt(document) {
  if (document?.schema === FIXTURE_ID_PROJECTION_SCHEMA || document?.notAuthoritative === true) {
    throw new Error('fixture ID projection is not an authoritative FixtureReceipt')
  }
  if (document?.schema === 'fsusblog.fixture-receipt.v1') {
    throw new Error('retired fixture receipt schema cannot authorize fixtures')
  }
}
