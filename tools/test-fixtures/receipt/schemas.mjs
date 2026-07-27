/** Fixture receipt schema identifiers (#1710). One-shot migration: no dual v1 adapter. */

export const PRODUCER_RECEIPT_SCHEMA = 'fsusblog.fixture-producer-receipt.v1'
export const FIXTURE_RECEIPT_SCHEMA = 'fsusblog.fixture-receipt.v2'
export const FIXTURE_PREPARE_STATE_SCHEMA = 'fsusblog.fixture-prepare-state.v1'
export const FIXTURE_ID_PROJECTION_SCHEMA = 'fsusblog.fixture-id-projection.v1'

/** Deleted schemas — readers must fail closed, not adapt. */
export const RETIRED_FIXTURE_RECEIPT_SCHEMAS = Object.freeze([
  'fsusblog.fixture-receipt.v1',
  'fsusblog.fixture-orchestrator-receipt.v1'
])

export const FIXTURE_TERMINAL_STATUSES = Object.freeze([
  'verified',
  'partial',
  'failed',
  'cleanup-failed'
])

export const ENTITY_IDENTITY_KINDS = Object.freeze([
  'article',
  'category',
  'tag',
  'user',
  'admin',
  'session',
  'comment',
  'thread',
  'notification',
  'preference',
  'scale-batch',
  'security-subject',
  'other'
])
