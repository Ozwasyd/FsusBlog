import { api, ApiError, type Session } from '../../Contracts/client.ts'
import { hasSiteRefreshCookie, rotateSiteRefresh } from '../../Contracts/site-refresh.ts'

const refreshLock = 'fsusblog-v2-site-refresh'
const contentionWait = 60_000
const renewalWindow = 60_000
const rotationTimeout = 15_000
const busyLock = Symbol('refresh in progress')

let channel: BroadcastChannel | undefined
let rotation: Promise<void> | undefined
let fallbackFlight: Promise<Session | null> | undefined
let retryAt = 0
let uncertain = false

export async function readSiteAuthority(signal?: AbortSignal): Promise<Session | null> {
  try { return await api.session(signal) }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export async function refreshSiteAuthority(mayRotate: () => boolean, signal?: AbortSignal): Promise<Session | null> {
  const first = await readSiteAuthority(signal)
  const allowed = () => !uncertain && Date.now() >= retryAt && mayRotate() && !signal?.aborted
  if (!eligible(first) || !allowed()) return first

  const lead = async () => {
    const current = await readSiteAuthority(signal)
    if (!eligible(current) || !allowed()) return current
    let hasRefresh: boolean
    try { hasRefresh = await hasSiteRefreshCookie(signal) }
    catch (error) {
      if (signal?.aborted || !current || current.expiresAt <= Date.now()) throw error
      return current
    }
    if (!hasRefresh || !allowed()) return current
    const request = rotateSiteRefresh(AbortSignal.timeout(rotationTimeout))
    rotation = request
    let message = 'recheck'
    try { await request }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) retryAt = Date.now() + contentionWait
      else if (error instanceof ApiError && (error.status === 401 || error.status === 404)) retryAt = Date.now() + contentionWait
      else {
        uncertain = true
        message = 'rotation-uncertain'
      }
    } finally {
      if (rotation === request) rotation = undefined
    }
    channel?.postMessage(message)
    try { return await readSiteAuthority(signal) }
    catch (error) {
      if (signal?.aborted || !current || current.expiresAt <= Date.now()) throw error
      return current
    }
  }

  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) {
    const result = await locks.request(refreshLock, { ifAvailable: true }, lock => lock ? lead() : busyLock)
    return result === busyLock ? locks.request(refreshLock, { signal }, () => readSiteAuthority(signal)) : result
  }

  if (fallbackFlight) {
    await fallbackFlight.catch(() => {})
    return readSiteAuthority(signal)
  }
  const flight = lead()
  fallbackFlight = flight
  try { return await flight }
  finally { if (fallbackFlight === flight) fallbackFlight = undefined }
}

function eligible(value: Session | null): boolean {
  return value === null || (value.siteRefresh === 'persistent' && value.expiresAt - Date.now() < renewalWindow)
}

export function siteRenewalDelay(expiresAt: number): number {
  return Math.min(Math.max(0, expiresAt - Date.now() - renewalWindow + 1_000), 2_147_483_647)
}

export async function withSiteAuthMutation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) return locks.request(refreshLock, { signal }, work)
  await rotation?.catch(() => {})
  return work()
}

export function announceSiteAuthChange() {
  uncertain = false
  retryAt = 0
  channel?.postMessage('recheck')
}

export function observeSiteRefresh(revalidate: () => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {}
  let receiver: BroadcastChannel
  try { receiver = new BroadcastChannel(refreshLock) }
  catch { return () => {} }
  channel = receiver
  receiver.onmessage = (message: MessageEvent<unknown>) => {
    if (message.data !== 'recheck' && message.data !== 'rotation-uncertain') return
    if (message.data === 'rotation-uncertain') uncertain = true
    revalidate()
  }
  return () => {
    if (channel === receiver) channel = undefined
    receiver.close()
  }
}
