import { computed, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'
import { purgeVerifiedDraftScope, verifyDraftScope } from './authoring/draftScope'

const authChannelName = 'fsusblog-v2-admin-auth'

const authority = shallowRef<{ session: Session | null; identity: number; credential: number }>({
  session: null, identity: 0, credential: 0,
})
let requestEpoch = 0
let mutation: number | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let sessionRead: { completion: Promise<void>; signal?: AbortSignal } | undefined
let channel: BroadcastChannel | undefined

export const currentSession = computed(() => authority.value.session)
export const identityEpoch = computed(() => authority.value.identity)
export const credentialEpoch = computed(() => authority.value.credential)

function updateSession(value: Session | null) {
  const observed = authority.value
  const previous = observed.session
  const next = value && value.canAuthor && value.expiresAt > Date.now() ? value : null
  const changed = previous?.generation !== next?.generation || previous?.name !== next?.name ||
    previous?.canAuthor !== next?.canAuthor || previous?.siteSessionId !== next?.siteSessionId
  authority.value = {
    session: next,
    identity: observed.identity + Number(changed),
    credential: observed.credential + Number(changed),
  }
  clearTimeout(expiryTimer)
  if (next) {
    const expire = () => {
      if (authority.value.session !== next) return
      const remaining = next.expiresAt - Date.now()
      if (remaining > 0) expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      else invalidateSession()
    }
    expire()
  }
}

export function invalidateSession() {
  requestEpoch++
  updateSession(null)
}

export async function recheckCredential(handle: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || handle !== authority.value.session?.siteSessionId) return
  await refreshSession(signal, false).catch(() => {})
}

export async function refreshSession(signal?: AbortSignal, reuseInFlight = true): Promise<void> {
  if (mutation !== undefined || signal?.aborted) return
  if (sessionRead && !sessionRead.signal?.aborted) {
    if (reuseInFlight) return sessionRead.completion
    await sessionRead.completion.catch(() => {})
    if (mutation !== undefined || signal?.aborted) return
  }
  const request = ++requestEpoch
  const admissible = () => request === requestEpoch && mutation === undefined && !signal?.aborted
  const completion = (async () => {
    try {
      let value: Session | null
      try { value = await api.authoringSession(signal) }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) value = null
        else throw error
      }
      if (admissible()) updateSession(value)
    } catch (error) {
      if (admissible() && (authority.value.session?.expiresAt ?? 0) <= Date.now()) updateSession(null)
      throw error
    }
  })()
  sessionRead = { completion, signal }
  try { await completion }
  finally { if (sessionRead?.completion === completion) sessionRead = undefined }
}

export async function clearAuthorSession(signal?: AbortSignal): Promise<void> {
  const epoch = authority.value.identity
  const author = authority.value.session?.canAuthor === true
  const request = ++requestEpoch
  mutation = request
  try {
    if (author) {
      try {
        await verifyDraftScope(epoch, () => request === requestEpoch && epoch === identityEpoch.value,
          () => currentSession.value?.siteSessionId, signal)
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          // Best-effort draft scope capture before admin sign-out completes.
        }
      }
    }
    if (request === requestEpoch) updateSession(null)
    await purgeVerifiedDraftScope(epoch).catch(() => {})
    announceAdminAuthChange()
  } finally {
    if (mutation === request) mutation = undefined
  }
}

export function announceAdminAuthChange() {
  if (channel) {
    channel.postMessage('recheck')
    return
  }
  if (typeof BroadcastChannel !== 'function') return
  try {
    const sender = new BroadcastChannel(authChannelName)
    sender.postMessage('recheck')
    sender.close()
  } catch { /* ignore unsupported channel environments */ }
}

export function observeAdminAuth(revalidate: () => void): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {}
  let receiver: BroadcastChannel
  try { receiver = new BroadcastChannel(authChannelName) }
  catch { return () => {} }
  channel = receiver
  receiver.onmessage = (message: MessageEvent<unknown>) => {
    if (message.data === 'recheck') revalidate()
  }
  return () => {
    if (channel === receiver) channel = undefined
    receiver.close()
  }
}
