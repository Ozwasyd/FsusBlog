import { ProtocolError } from './aeds.ts'
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts'
import { PodReader } from './binary.ts'
import { request } from './client.ts'
import { FrameType, WireRoutes } from './wire.generated.ts'

export type AdminSiteTraffic = Readonly<{
  enabled: boolean
  regionsConfigured: boolean
  days: readonly { date: string; views: number }[]
  regions: readonly { region: string; views: number }[]
}>

export function readAdminSiteTraffic(session: AdminSession, signal?: AbortSignal): Promise<AdminSiteTraffic> {
  return request(WireRoutes.AdminSiteTraffic, FrameType.AdminSiteTraffic, (payload, headers) => {
    assertAdminPermissionSession(session, headers)
    return decodeAdminSiteTraffic(payload)
  }, signal)
}

export function decodeAdminSiteTraffic(payload: Uint8Array): AdminSiteTraffic {
  const reader = new PodReader(payload)
  const enabled = reader.bool(), regionsConfigured = reader.bool()
  const dayCount = reader.i32()
  if (dayCount < 0 || dayCount > 30 || !enabled && (regionsConfigured || dayCount !== 0))
    throw new ProtocolError('Invalid site traffic snapshot.')
  const days = []
  let previous = ''
  for (let i = 0; i < dayCount; i++) {
    const date = reader.text(10), views = Number(reader.i64())
    const timestamp = Date.parse(date + 'T00:00:00Z')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-') || !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== date || date <= previous || !Number.isSafeInteger(views) || views < 0)
      throw new ProtocolError('Invalid site traffic day.')
    days.push({ date, views })
    previous = date
  }
  const regionCount = reader.i32()
  if (regionCount < 0 || regionCount > 30 || !regionsConfigured && regionCount !== 0)
    throw new ProtocolError('Invalid site traffic regions.')
  const regions = [], keys = new Set<string>()
  for (let i = 0; i < regionCount; i++) {
    const region = reader.text(7), views = Number(reader.i64())
    if (!/^(?:[A-Z]{2}(?:-[A-Z0-9]{1,3})?|unknown)$/.test(region) || !Number.isSafeInteger(views) || views <= 0 || keys.has(region))
      throw new ProtocolError('Invalid site traffic region.')
    regions.push({ region, views })
    keys.add(region)
  }
  reader.finish()
  return { enabled, regionsConfigured, days, regions }
}
