import assert from 'node:assert/strict'
import test from 'node:test'

import { parseReleaseId } from '../../tools/release/release-id.mjs'
import {
  SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT,
  assertSchemaCompatibilityWindow,
  compareSchemaCompatibilityCoordinates,
  parseLegacySchemaCompatibilityCoordinate,
  parseSchemaCompatibilityCoordinate
} from '../../tools/release/schema-compatibility-coordinate.mjs'

const MIN = SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT.minimum
const MAX = SCHEMA_COMPATIBILITY_COORDINATE_CONTRACT.maximum

test('canonical coordinates preserve UTC release order and bound it with sentinels', () => {
  assert.equal(compareSchemaCompatibilityCoordinates(MIN, '20260719235959-ffffffffffff'), -1)
  assert.equal(compareSchemaCompatibilityCoordinates(
    '20260719235959-ffffffffffff',
    '20260720000000-000000000000'
  ), -1)
  assert.equal(compareSchemaCompatibilityCoordinates('20260720000000-000000000000', MAX), -1)
})

test('same-second SHA order is deterministic and is not treated as publication chronology', () => {
  const first = '20260720000000-000000000001'
  const second = '20260720000000-ffffffffffff'
  assert.equal(compareSchemaCompatibilityCoordinates(first, second), -1)
  assert.equal(parseReleaseId(first)?.createdAtUtc, parseReleaseId(second)?.createdAtUtc)
})

test('manifest accepts only canonical coordinates and rejects reversed windows', () => {
  assert.deepEqual(assertSchemaCompatibilityWindow(MIN, MAX), {
    minimumCoordinate: MIN,
    maximumCoordinate: MAX
  })
  assert.throws(() => assertSchemaCompatibilityWindow(MAX, MIN), /reversed/u)
  assert.equal(parseSchemaCompatibilityCoordinate('20260720-online-migration-gate'), null)
  assert.equal(parseSchemaCompatibilityCoordinate('20260720000000-AAAAAAAAAAAA'), null)
})

test('release identity rejects schema fences while explicit legacy adapter preserves history', () => {
  assert.equal(parseReleaseId(MIN), null)
  assert.equal(parseReleaseId(MAX), null)
  const legacy = parseLegacySchemaCompatibilityCoordinate('20260711-online-migration-gate')
  assert.equal(legacy?.value, '20260711-online-migration-gate')
  assert.equal(legacy?.kind, 'legacy')
  assert.equal(parseReleaseId(legacy?.value), null)
})
