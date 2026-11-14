import { readonly, ref, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'
import { loginWithPasskey, provisionPasskey } from '../../Contracts/passkey'
import { completeMfaLogin, type Factor } from '../../Contracts/mfa'
import { hasSiteRefreshCookie, signOutSiteRefresh } from '../../Contracts/site-refresh'
import { purgeVerifiedDraftScope, verifyDraftScope } from './authoring/draftScope'
import { announceSiteAuthChange, readSiteAuthority, refreshSiteAuthority, withSiteAuthMutation } from './site-refresh-coordination'

const session = shallowRef<Session | null>(null)
const sessionEpoch = ref(0)
let requestEpoch = 0
let mutation: number | undefined
let pendingMfa: string | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let sessionRead: { completion: Promise<void>; signal?: AbortSignal } | undefined

export const currentSession = readonly(session)
export const identityEpoch = readonly(sessionEpoch)

function updateSession(value: Session | null, newLogin = false) {
  const previous = session.value
  const next = value && value.expiresAt > Date.now() ? value : null
  session.value = next
  if (newLogin || previous?.generation !== next?.generation || previous?.name !== next?.name ||
      previous?.canAuthor !== next?.canAuthor || previous?.expiresAt !== next?.expiresAt || previous?.siteSessionId !== next?.siteSessionId ||
      previous?.siteRefresh !== next?.siteRefresh) {
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

export async function refreshSession(signal?: AbortSignal, rotate = true): Promise<void> {
  if (mutation !== undefined || pendingMfa !== undefined || signal?.aborted) return
  if (sessionRead && !sessionRead.signal?.aborted) {
    if (rotate) return sessionRead.completion
    await sessionRead.completion.catch(() => {})
    if (mutation !== undefined || pendingMfa !== undefined || signal?.aborted) return
  }
  const request = ++requestEpoch
  const admissible = () => request === requestEpoch && mutation === undefined && pendingMfa === undefined && !signal?.aborted
  const completion = (async () => {
    try {
      const value = rotate ? await refreshSiteAuthority(admissible, signal) : await readSiteAuthority(signal)
      if (admissible()) updateSession(value)
    } catch (error) {
      if (admissible()) updateSession(null)
      throw error
    }
  })()
  sessionRead = { completion, signal }
  try { await completion }
  finally { if (sessionRead?.completion === completion) sessionRead = undefined }
}

export async function signIn(ticket: string, signal?: AbortSignal) {
  pendingMfa = undefined
  await mutateLogin(() => api.signIn(ticket, signal), signal)
}

export async function signInWithPasskey(signal?: AbortSignal, rememberMe = false): Promise<string | null> {
  pendingMfa = undefined
  let pending: string | null = null
  const accepted = await mutateLogin(async () => {
    const outcome = await loginWithPasskey(signal, rememberMe)
    if (outcome.status === 'signed-in') return outcome.session
    pending = outcome.token
    return null
  }, signal)
  if (accepted && pending !== null) pendingMfa = pending
  return accepted ? pending : null
}

export async function signInWithMfa(token: string, factor: Factor, signal?: AbortSignal) {
  if (await mutateLogin(() => completeMfaLogin(token, factor, signal), signal)) cancelMfaLogin(token)
}

export function cancelMfaLogin(token: string) {
  if (pendingMfa === token) pendingMfa = undefined
}

export async function registerFirstPasskey(ticket: string, signal?: AbortSignal) {
  pendingMfa = undefined
  await mutateLogin(async () => {
    await provisionPasskey(ticket, signal)
    return null
  }, signal)
}

async function mutateLogin(perform: () => Promise<Session | null>, signal?: AbortSignal) {
  const request = ++requestEpoch
  mutation = request
  try {
    return await withSiteAuthMutation(signal, async () => {
      if (request !== requestEpoch || signal?.aborted) return false
      const value = await perform()
      if (request !== requestEpoch || signal?.aborted) return false
      updateSession(value, true)
      if (value) announceSiteAuthChange()
      return true
    })
  } finally {
    if (mutation === request) mutation = undefined
  }
}

export async function signOut(signal?: AbortSignal) {
  pendingMfa = undefined
  const epoch = sessionEpoch.value
  const author = session.value?.canAuthor === true
  const persistent = session.value?.siteRefresh === 'persistent'
  const request = ++requestEpoch
  mutation = request
  try {
    await withSiteAuthMutation(signal, async () => {
      if (request !== requestEpoch || signal?.aborted) return
      let recoveryError: unknown
      if (author) {
        try { await verifyDraftScope(epoch, () => request === requestEpoch, signal) }
        catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) recoveryError = error
        }
      }
      if (request !== requestEpoch || signal?.aborted) return
      updateSession(null)
      try {
        const hasRefresh = persistent || await hasSiteRefreshCookie(signal)
        if (request !== requestEpoch || signal?.aborted) return
        if (hasRefresh) await signOutSiteRefresh(signal)
        else await api.signOut(signal)
        announceSiteAuthChange()
      }
      catch (logoutError) {
        try { await purgeVerifiedDraftScope(epoch) }
        catch (cleanupError) { throw new AggregateError([logoutError, cleanupError]) }
        throw logoutError
      }
      await purgeVerifiedDraftScope(epoch)
      if (recoveryError) throw recoveryError
    })
  } finally {
    if (mutation === request) mutation = undefined
  }
}
