/** Public exports for FixtureReceipt / ProducerReceipt (#1710). */

export {
  canonicalJson,
  digestCanonical,
  digestReceiptBody,
  sha256Text,
  sha256Bytes,
  assertDigest,
  freezeDeep
} from './canonical.mjs'

export {
  PRODUCER_RECEIPT_SCHEMA,
  FIXTURE_RECEIPT_SCHEMA,
  FIXTURE_PREPARE_STATE_SCHEMA,
  FIXTURE_ID_PROJECTION_SCHEMA,
  RETIRED_FIXTURE_RECEIPT_SCHEMAS,
  FIXTURE_TERMINAL_STATUSES,
  ENTITY_IDENTITY_KINDS
} from './schemas.mjs'

export { assertNoSecrets, looksLikeSecretKey } from './secrets.mjs'

export {
  readPrivateFile,
  readPrivateJson,
  writePrivateJson,
  fileContentDigest
} from './private-io.mjs'

export {
  normalizeDatabaseObservation,
  normalizeRedisObservation,
  normalizeCacheObservation,
  digestDatabaseObservation,
  digestRedisObservation,
  digestCacheObservation,
  emptyDatabaseObservation,
  emptyRedisObservation,
  emptyCacheObservation,
  mergeDatabaseObservations,
  mergeRedisObservations,
  mergeCacheObservations,
  reverifyObservationDigests
} from './observations.mjs'

export {
  POSTCONDITION_VERIFIERS,
  assertPostconditionRegistryComplete,
  listPostconditionIds,
  runPostcondition,
  verifyCapabilityPostconditions,
  assertProfilePostconditionsBound
} from './postconditions.mjs'

export {
  buildProducerReceipt,
  validateProducerReceipt,
  producerReceiptDigestOf
} from './producer-receipt.mjs'

export {
  buildFixtureReceipt,
  validateFixtureReceipt,
  writeFixtureReceipt,
  readFixtureReceipt,
  aggregateVerifiedFixtureReceipt,
  buildTerminalFailureReceipt
} from './fixture-receipt.mjs'

export {
  projectFixtureIds,
  writeFixtureIdProjection,
  assertNotAuthoritativeReceipt
} from './projection.mjs'

export {
  FIXTURE_REUSE_REASON_CODES,
  FIXTURE_RUN_ONCE_REUSE_CONTRACT,
  assertFixtureReuseBypassForbidden,
  verifyFixtureReusableState,
  createFixtureReceiptReuseVerifier,
  buildFixtureReuseContract,
  isFixtureReuseVerifierRegistered
} from './reuse-verifier.mjs'
