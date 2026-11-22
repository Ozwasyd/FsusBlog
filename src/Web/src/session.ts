import { computed, shallowRef } from 'vue'
import { api, ApiError, type Session } from '../../Contracts/client'
import { bootstrapAdminPasskey, validAdminBootstrapToken } from '../../Contracts/admin-identity'
import { beginPasskeyProvision, completePasskeyProvision, loginWithPasskey } from '../../Contracts/passkey'
import { completeMfaLogin, type Factor } from '../../Contracts/mfa'
import { hasSiteRefreshCookie, signOutSiteRefresh } from '../../Contracts/site-refresh'
import { announceAdminAuthChange, markAdminSessionHint } from './authorSession'
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
  if (!changed && !replacedCredential && previous?.expiresAt === next?.expiresAt && (previous === null) === (next === null)) {
    return
  }
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

export type PasskeySignInResult =
  | { kind: 'reader' }
  | { kind: 'admin' }
  | { kind: 'mfa'; token: string }
  | { kind: 'aborted' }

export async function signInWithPasskey(signal?: AbortSignal, rememberMe = false): Promise<PasskeySignInResult> {
  pendingMfa = undefined
  const box: { outcome: PasskeySignInResult } = { outcome: { kind: 'aborted' } }
  const accepted = await mutateLogin(async () => {
    const result = await loginWithPasskey(signal, rememberMe)
    if (result.status === 'mfa') {
      box.outcome = { kind: 'mfa', token: result.token }
      return null
    }
    if (result.role === 'admin') {
      box.outcome = { kind: 'admin' }
      return undefined
    }
    box.outcome = { kind: 'reader' }
    return result.session
  }, signal)
  if (!accepted) return { kind: 'aborted' }
  const { outcome } = box
  if (outcome.kind === 'mfa') pendingMfa = outcome.token
  if (outcome.kind === 'admin') {
    markAdminSessionHint(true)
    announceAdminAuthChange()
  }
  return outcome
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
    let started: Awaited<ReturnType<typeof beginPasskeyProvision>>
    try {
      started = await beginPasskeyProvision(ticket, signal)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && validAdminBootstrapToken(ticket)) {
        await bootstrapAdminPasskey(ticket, signal)
        return undefined
      }
      throw error
    }
    await completePasskeyProvision(started, signal)
    return null
  }, signal)
}

async function mutateLogin(perform: () => Promise<Session | null | undefined>, signal?: AbortSignal) {
  const request = ++requestEpoch
  mutation = request
  try {
    return await withSiteAuthMutation(signal, async () => {
      if (request !== requestEpoch || signal?.aborted) return false
      const value = await perform()
      if (request !== requestEpoch || signal?.aborted) return false
      if (value !== undefined) {
        updateSession(value, true)
        if (value) announceSiteAuthChange()
      }
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
