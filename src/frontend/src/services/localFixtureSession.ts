import type { AdminPrincipalSnapshot } from '@/api/auth'
import type { CurrentUserSnapshot } from '@/api/auth'

const LOCAL_FIXTURE_SESSION_KEY = 'fsusblog_local_fixture_session'
const LOCAL_FIXTURE_ADMIN_SESSION_KEY = 'fsusblog_local_fixture_admin_session'
const LOCAL_FIXTURE_SECRET_HEADER = 'X-Fsus-Local-Auth-Fixture-Secret'
let fixtureCookieRefreshPromise: Promise<boolean> | null = null

interface LocalFixtureStatus {
  hasAccessToken?: boolean
  hasSessionId?: boolean
  hasAdminAccessToken?: boolean
  hasAdminSessionId?: boolean
  hasHostAccessToken?: boolean
  hasHostAdminAccessToken?: boolean
}

interface LocalFixtureAdminSensitiveProof {
  proofToken?: string
  action?: string
}

export function isLocalFixtureQueryEnabled(value: unknown): boolean {
  return value === '1'
}

function isLocalFixtureHost(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '::1'
}

function canUseLocalFixtureSession(): boolean {
  const explicitLocalFixture = isLocalFixtureHost() && hasLocalFixtureQueryFlag()
  return Boolean(
    isLocalFixtureHost()
    && (
      explicitLocalFixture
      || (
        import.meta.env.DEV
        && import.meta.env.MODE === 'development'
        && !import.meta.env.PROD
      )
    )
  )
}

export function activateLocalFixtureSession(): void {
  if (!canUseLocalFixtureSession() || typeof sessionStorage === 'undefined') {
    return
  }
  try {
    sessionStorage.setItem(LOCAL_FIXTURE_SESSION_KEY, '1')
    if (hasLocalFixtureAdminQueryFlag()) {
      sessionStorage.setItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY, '1')
    }
  } catch {
    // Storage may be unavailable in browser privacy modes; the query flag remains authoritative.
  }
}

export function clearLocalFixtureSession(): void {
  if (typeof sessionStorage === 'undefined') {
    return
  }
  try {
    sessionStorage.removeItem(LOCAL_FIXTURE_SESSION_KEY)
    sessionStorage.removeItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY)
  } catch {
    // Ignore storage failures during logout cleanup.
  }
}

function hasLocalFixtureQueryFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return new URLSearchParams(window.location.search).get('fsusLocalFixtureLogin') === '1'
}

function hasLocalFixtureAdminQueryFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return new URLSearchParams(window.location.search).get('fsusLocalFixtureAdmin') === '1'
}

export function isLocalFixtureSessionActive(): boolean {
  let storageActive = false
  try {
    storageActive = typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(LOCAL_FIXTURE_SESSION_KEY) === '1'
  } catch {
    storageActive = false
  }

  return Boolean(
    canUseLocalFixtureSession()
    && (
      hasLocalFixtureQueryFlag()
      || storageActive
    )
  )
}

export function isLocalFixtureAdminSessionActive(): boolean {
  if (!isLocalFixtureSessionActive()) {
    return false
  }

  let storageActive = false
  try {
    storageActive = typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY) === '1'
  } catch {
    storageActive = false
  }

  return Boolean(hasLocalFixtureAdminQueryFlag() || storageActive)
}

function currentRedirectPath(fallback = '/user/manage'): string {
  if (typeof window === 'undefined') {
    return fallback
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function readLocalFixtureSecret(): string | null {
  if (!canUseLocalFixtureSession()) {
    return null
  }

  const secret = import.meta.env.VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET?.trim()
  return secret ? secret : null
}

function createLocalFixtureHeaders(): Record<string, string> | null {
  const secret = readLocalFixtureSecret()
  if (!secret) {
    return null
  }

  return {
    [LOCAL_FIXTURE_SECRET_HEADER]: secret
  }
}

export function hasCompleteFixtureCookies(status: LocalFixtureStatus): boolean {
  return Boolean(
    (status.hasAccessToken || status.hasHostAccessToken)
    && status.hasSessionId
    && (status.hasAdminAccessToken || status.hasHostAdminAccessToken)
    && status.hasAdminSessionId
  )
}

export async function readFixtureStatus(): Promise<LocalFixtureStatus | null> {
  const headers = createLocalFixtureHeaders()
  if (!headers) {
    return null
  }

  const response = await fetch('/api/local/auth-fixture/status', {
    cache: 'no-store',
    credentials: 'include',
    headers
  })

  if (!response.ok) {
    return null
  }

  return await response.json() as LocalFixtureStatus
}

export function buildLocalFixtureAdminUrl(redirectPath: string): string {
  const endpoint = new URL('/api/local/auth-fixture/admin', window.location.origin)
  endpoint.searchParams.set('redirect', redirectPath)
  return endpoint.toString()
}

async function refreshLocalFixtureAdminCookies(redirectPath: string): Promise<boolean> {
  const headers = createLocalFixtureHeaders()
  if (!headers) {
    return false
  }

  const response = await fetch(buildLocalFixtureAdminUrl(redirectPath), {
    cache: 'no-store',
    credentials: 'include',
    headers
  })

  if (!response.ok) {
    return false
  }

  const status = await readFixtureStatus()
  return Boolean(status && hasCompleteFixtureCookies(status))
}

export async function ensureLocalFixtureSessionCookies(redirectPath = currentRedirectPath()): Promise<boolean> {
  if (!isLocalFixtureSessionActive() || typeof window === 'undefined') {
    return false
  }

  if (fixtureCookieRefreshPromise) {
    return fixtureCookieRefreshPromise
  }

  fixtureCookieRefreshPromise = (async () => {
    try {
      const status = await readFixtureStatus()
      if (status && hasCompleteFixtureCookies(status)) {
        return true
      }

      return await refreshLocalFixtureAdminCookies(redirectPath)
    } catch {
      return false
    } finally {
      fixtureCookieRefreshPromise = null
    }
  })()

  return fixtureCookieRefreshPromise
}

export async function mintLocalFixtureAdminSensitiveProof(): Promise<string | null> {
  if (!isLocalFixtureAdminSessionActive()) {
    return null
  }

  const headers = createLocalFixtureHeaders()
  if (!headers) {
    return null
  }

  try {
    const response = await fetch('/api/local/auth-fixture/admin-sensitive-proof', {
      cache: 'no-store',
      credentials: 'include',
      method: 'POST',
      headers
    })

    if (!response.ok) {
      return null
    }

    const body = await response.json() as LocalFixtureAdminSensitiveProof
    const token = body.proofToken?.trim()
    return body.action === 'admin-sensitive' && token ? token : null
  } catch {
    return null
  }
}

export function createLocalFixtureAccountSnapshot(): CurrentUserSnapshot {
  return {
    accountId: 2,
    identityKind: 'anonymous',
    publicHandle: 'binaryuser',
    passkeyEnabled: true,
    recoveryEnabled: true,
    totpStepUpEnabled: false,
    anonymousCredentialStatus: null,
    anonymousCredentialLevel: null,
    status: 0,
    banReason: null,
    deletedAt: null
  }
}

export function createLocalFixtureAdminPrincipal(): AdminPrincipalSnapshot {
  return {
    id: '1',
    displayName: 'binaryadmin',
    source: 'independent',
    adminSessionStatus: 'active',
    permissions: [
      'article.write',
      'article.publish',
      'comment.moderate',
      'anonymous.comment.configure',
      'anonymous.nullifier.block',
      'anonymous.credential.revoke',
      'audit.read',
      'system.config',
      'admin.manage'
    ],
    totpStepUpRequired: true
  }
}
