import { computed, shallowRef } from 'vue'
import { api, type Session } from '../../Contracts/client'
import { loginWithPasskey, provisionPasskey } from '../../Contracts/passkey'
import { completeMfaLogin, type Factor } from '../../Contracts/mfa'
import { hasSiteRefreshCookie, signOutSiteRefresh } from '../../Contracts/site-refresh'
import { announceSiteAuthChange, readSiteAuthority, refreshSiteAuthority, withSiteAuthMutation } from './site-refresh-coordination'

const authority = shallowRef<{ session: Session | null; identity: number; credential: number }>({
  session: null, identity: 0, credential: 0,
})
let requestEpoch = 0
let mutation: number | undefined
let pendingMfa: string | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let sessionRead: { completion: Promise<void>; signal?: AbortSignal } | undefined

export const currentSession = computed(() => authority.value.session)
export const identityEpoch = computed(() => authority.value.identity)
export const credentialEpoch = computed(() => authority.value.credential)

function updateSession(value: Session | null, newLogin = false) {
  const observed = authority.value
  const previous = observed.session
  const next = value && value.expiresAt > Date.now() ? value : null
  const changed = newLogin || previous?.generation !== next?.generation || previous?.name !== next?.name ||
    previous?.canAuthor !== next?.canAuthor || previous?.siteRefresh !== next?.siteRefresh ||
    (previous?.siteSessionContinuity ?? previous?.siteSessionId) !== (next?.siteSessionContinuity ?? next?.siteSessionId)
  const replacedCredential = previous?.siteSessionId !== next?.siteSessionId
  authority.value = {
    session: next,
    identity: observed.identity + Number(changed),
    credential: observed.credential + Number(changed || replacedCredential),
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
  const session = authority.value.session
  if (session?.siteRefresh === 'persistent' && session.siteSessionId && session.expiresAt > Date.now()) {
    void recheckCredential(session.siteSessionId, AbortSignal.timeout(5000))
  } else {
    requestEpoch++
    updateSession(null)
  }
}

export async function recheckCredential(handle: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || handle !== authority.value.session?.siteSessionId) return
  await refreshSession(signal, false).catch(() => {})
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
      if (admissible() && (authority.value.session?.expiresAt ?? 0) <= Date.now()) updateSession(null)
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
  const persistent = authority.value.session?.siteRefresh === 'persistent'
  const request = ++requestEpoch
  mutation = request
  try {
    await withSiteAuthMutation(signal, async () => {
      if (request !== requestEpoch || signal?.aborted) return
      updateSession(null)
      const hasRefresh = persistent || await hasSiteRefreshCookie(signal)
      if (request !== requestEpoch || signal?.aborted) return
      if (hasRefresh) await signOutSiteRefresh(signal)
      else await api.signOut(signal)
      announceSiteAuthChange()
    })
  } finally {
    if (mutation === request) mutation = undefined
  }
}
