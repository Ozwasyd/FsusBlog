import { createSessionExpiry, createSessionRead } from './sessionLifecycle'
import { computed, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'
import { purgeVerifiedDraftScope, verifyDraftScope } from './authoring/draftScope'

const authChannelName = 'fsusblog-v2-admin-auth'
const adminHintKey = 'fsusblog.adminActive'

export function hasAdminSessionHint(): boolean {
  try { return globalThis.sessionStorage?.getItem(adminHintKey) === '1' }
  catch { return false }
}

export function markAdminSessionHint(active: boolean) {
  try {
    if (active) globalThis.sessionStorage?.setItem(adminHintKey, '1')
    else globalThis.sessionStorage?.removeItem(adminHintKey)
  } catch { /* ignore restricted storage environments */ }
}

const authority = shallowRef<{ session: Session | null; identity: number; credential: number }>({
  session: null, identity: 0, credential: 0,
})
let requestEpoch = 0
let mutation: number | undefined
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
  markAdminSessionHint(next !== null)
  scheduleExpiry(next)
}

export function invalidateSession() {
  requestEpoch++
  updateSession(null)
}

const scheduleExpiry = createSessionExpiry(() => authority.value.session, invalidateSession)
export const refreshSession = createSessionRead({
  blocked: () => mutation !== undefined,
  begin: () => ++requestEpoch,
  current: request => request === requestEpoch,
  session: () => authority.value.session,
  update: updateSession,
  read: signal => api.authoringSession(signal),
  allowUnauthorized: true,
})

export async function recheckCredential(handle: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || handle !== authority.value.session?.siteSessionId) return
  await refreshSession(signal, false).catch(() => {})
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
    markAdminSessionHint(false)
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
