import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PodWriter, ProtocolError } from '../../src/Contracts/binary.ts'
import { decodeAdminSiteTraffic } from '../../src/Contracts/admin-site-traffic.ts'

function payload(enabled: boolean, configured: boolean, days: readonly [string, bigint][], regions: readonly [string, bigint][]) {
  const writer = new PodWriter()
  writer.bool(enabled); writer.bool(configured)
  writer.i32(days.length)
  for (const [date, count] of days) { writer.text(date, 10); writer.i64(count) }
  writer.i32(regions.length)
  for (const [region, count] of regions) { writer.text(region, 7); writer.i64(count) }
  return writer.finish()
}

test('site traffic distinguishes disabled, absent region mapping and valid ISO aggregates', () => {
  assert.deepEqual(decodeAdminSiteTraffic(payload(false, false, [], [])),
    { enabled: false, regionsConfigured: false, days: [], regions: [] })
  assert.deepEqual(decodeAdminSiteTraffic(payload(true, false, [['2026-11-16', 2n]], [])),
    { enabled: true, regionsConfigured: false, days: [{ date: '2026-11-16', views: 2 }], regions: [] })
  assert.deepEqual(decodeAdminSiteTraffic(payload(true, true, [['2026-11-16', 0n], ['2026-11-17', 4n]], [['CN-BJ', 3n], ['unknown', 1n]])),
    { enabled: true, regionsConfigured: true, days: [{ date: '2026-11-16', views: 0 }, { date: '2026-11-17', views: 4 }],
      regions: [{ region: 'CN-BJ', views: 3 }, { region: 'unknown', views: 1 }] })
})

test('site traffic rejects contradictory states, invalid frames and raw addresses', () => {
  for (const invalid of [
    payload(false, true, [], []), payload(false, false, [['2026-11-17', 1n]], []),
    payload(true, false, [], [['CN', 1n]]), payload(true, true, [], [['CN-BJ', 1n], ['CN-BJ', 3n]]),
    payload(true, true, [], [['1.1.1.1', 1n]]), payload(true, true, [], [['CN', 0n]]),
    payload(true, true, [['2026-02-30', 1n]], []), payload(true, true, [['2026-01-01', 9007199254740992n]], []),
    payload(true, true, [['2026-11-17', 1n], ['2026-11-16', 2n]], []),
    Uint8Array.of(...payload(true, true, [], []), 0),
  ]) assert.throws(() => decodeAdminSiteTraffic(invalid), ProtocolError)
})
