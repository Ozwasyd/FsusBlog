import { readonly, ref, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'
import { loginWithPasskey, provisionPasskey } from '../../Contracts/passkey'
import { completeMfaLogin, type Factor } from '../../Contracts/mfa'
import { purgeVerifiedDraftScope, verifyDraftScope } from './authoring/draftScope'

const session = shallowRef<Session | null>(null)
const sessionEpoch = ref(0)
let requestEpoch = 0
let mutation: number | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined

export const currentSession = readonly(session)
export const identityEpoch = readonly(sessionEpoch)

function updateSession(value: Session | null, newLogin = false) {
  const previous = session.value
  const next = value && value.expiresAt > Date.now() ? value : null
  session.value = next
  if (newLogin || previous?.generation !== next?.generation || previous?.name !== next?.name ||
      previous?.canAuthor !== next?.canAuthor || previous?.expiresAt !== next?.expiresAt || previous?.siteSessionId !== next?.siteSessionId) {
    sessionEpoch.value++
  }
  clearTimeout(expiryTimer)
  if (next) {
    const expire = () => {
      if (session.value !== next) return
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

export async function refreshSession(signal?: AbortSignal) {
  if (mutation !== undefined) return
  const request = ++requestEpoch
  try {
    const value = await api.session(signal)
    if (request === requestEpoch && !signal?.aborted) updateSession(value)
  } catch (error) {
    if (request === requestEpoch && !signal?.aborted) updateSession(null)
    if (!(error instanceof ApiError) || error.status !== 401) throw error
  }
}

export async function signIn(ticket: string, signal?: AbortSignal) {
  await mutateLogin(() => api.signIn(ticket, signal), signal)
}

export async function signInWithPasskey(signal?: AbortSignal): Promise<string | null> {
  let pending: string | null = null
  const accepted = await mutateLogin(async () => {
    const outcome = await loginWithPasskey(signal)
    if (outcome.status === 'signed-in') return outcome.session
    pending = outcome.token
    return null
  }, signal)
  return accepted ? pending : null
}

export async function signInWithMfa(token: string, factor: Factor, signal?: AbortSignal) {
  await mutateLogin(() => completeMfaLogin(token, factor, signal), signal)
}

export async function registerFirstPasskey(ticket: string, signal?: AbortSignal) {
  await mutateLogin(async () => {
    await provisionPasskey(ticket, signal)
    return null
  }, signal)
}

async function mutateLogin(perform: () => Promise<Session | null>, signal?: AbortSignal) {
  const request = ++requestEpoch
  mutation = request
  try {
    const value = await perform()
    if (request !== requestEpoch || signal?.aborted) return false
    updateSession(value, true)
    return true
  } finally {
    if (mutation === request) mutation = undefined
  }
}

export async function signOut(signal?: AbortSignal) {
  const epoch = sessionEpoch.value
  const author = session.value?.canAuthor === true
  const request = ++requestEpoch
  mutation = request
  try {
    let recoveryError: unknown
    if (author) {
      try { await verifyDraftScope(epoch, () => request === requestEpoch, signal) }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) recoveryError = error
      }
    }
    if (request !== requestEpoch || signal?.aborted) return
    updateSession(null)
    try { await api.signOut(signal) }
    catch (logoutError) {
      try { await purgeVerifiedDraftScope(epoch) }
      catch (cleanupError) { throw new AggregateError([logoutError, cleanupError]) }
      throw logoutError
    }
    await purgeVerifiedDraftScope(epoch)
    if (recoveryError) throw recoveryError
  } finally {
    if (mutation === request) mutation = undefined
  }
}
