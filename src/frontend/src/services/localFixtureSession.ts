import type { AdminPrincipalSnapshot } from '@/api/auth'
import type { CurrentUserSnapshot } from '@/api/auth'

const LOCAL_FIXTURE_SESSION_KEY = 'fsusblog_local_fixture_session'
const LOCAL_FIXTURE_ADMIN_SESSION_KEY = 'fsusblog_local_fixture_admin_session'
const LOCAL_FIXTURE_SECRET_HEADER = 'X-Fsus-Local-Auth-Fixture-Secret'
const LOCAL_FIXTURE_LOGIN_QUERY = 'fsusLocalFixtureLogin'
const LOCAL_FIXTURE_ADMIN_QUERY = 'fsusLocalFixtureAdmin'
let fixtureCookieRefreshPromise: Promise<boolean> | null = null

export interface LocalFixtureEnvironment {
  hostname: string
  dev: boolean
  prod: boolean
  mode: string
}

interface LocalFixtureActivationDependencies {
  environment?: LocalFixtureEnvironment
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  location?: Pick<Location, 'href' | 'hostname' | 'pathname' | 'search' | 'hash'>
  history?: Pick<History, 'state' | 'replaceState'>
}

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

function isLocalFixtureHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function currentLocalFixtureEnvironment(): LocalFixtureEnvironment | null {
  if (typeof window === 'undefined') return null
  return {
    hostname: window.location.hostname,
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
    mode: import.meta.env.MODE
  }
}

export function canUseLocalFixtureSessionEnvironment(environment: LocalFixtureEnvironment): boolean {
  return isLocalFixtureHost(environment.hostname)
    && environment.dev
    && !environment.prod
    && environment.mode === 'development'
}

function canUseLocalFixtureSession(environment = currentLocalFixtureEnvironment()): boolean {
  return environment !== null && canUseLocalFixtureSessionEnvironment(environment)
}

export function sanitizeLocalFixturePath(path: string, origin: string): string {
  try {
    const url = new URL(path, origin)
    if (url.origin !== origin) return '/user/manage'
    url.searchParams.delete(LOCAL_FIXTURE_LOGIN_QUERY)
    url.searchParams.delete(LOCAL_FIXTURE_ADMIN_QUERY)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/user/manage'
  }
}

export function activateLocalFixtureSession(dependencies: LocalFixtureActivationDependencies = {}): boolean {
  if (typeof window === 'undefined') return false

  const location = dependencies.location ?? window.location
  const history = dependencies.history ?? window.history
  const storage = dependencies.storage ?? sessionStorage
  const environment = dependencies.environment ?? currentLocalFixtureEnvironment()
  if (!canUseLocalFixtureSession(environment)) return false

  const query = new URLSearchParams(location.search)
  if (!isLocalFixtureQueryEnabled(query.get(LOCAL_FIXTURE_LOGIN_QUERY))) return false
  const adminEnabled = isLocalFixtureQueryEnabled(query.get(LOCAL_FIXTURE_ADMIN_QUERY))

  try {
    storage.setItem(LOCAL_FIXTURE_SESSION_KEY, '1')
    if (adminEnabled) {
      storage.setItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY, '1')
    }
    history.replaceState(
      history.state,
      '',
      sanitizeLocalFixturePath(location.href, new URL(location.href).origin)
    )
    return true
  } catch {
    try {
      storage.removeItem(LOCAL_FIXTURE_SESSION_KEY)
      storage.removeItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY)
    } catch {
      // Storage may be unavailable in browser privacy modes.
    }
    return false
  }
}

export function clearLocalFixtureSession(
  storage: Pick<Storage, 'removeItem'> | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage
): void {
  if (!storage) {
    return
  }
  try {
    storage.removeItem(LOCAL_FIXTURE_SESSION_KEY)
    storage.removeItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY)
  } catch {
    // Ignore storage failures during logout cleanup.
  }
}

export function clearLocalFixtureAdminSession(
  storage: Pick<Storage, 'removeItem'> | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage
): void {
  if (!storage) {
    return
  }
  try {
    storage.removeItem(LOCAL_FIXTURE_ADMIN_SESSION_KEY)
  } catch {
    // Ignore storage failures during admin-only logout cleanup.
  }
}

function hasLocalFixtureQueryFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return new URLSearchParams(window.location.search).get(LOCAL_FIXTURE_LOGIN_QUERY) === '1'
}

function hasLocalFixtureAdminQueryFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return new URLSearchParams(window.location.search).get(LOCAL_FIXTURE_ADMIN_QUERY) === '1'
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

  return sanitizeLocalFixturePath(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    window.location.origin
  )
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
  endpoint.searchParams.set('redirect', sanitizeLocalFixturePath(redirectPath, window.location.origin))
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
    deletedAt: null,
    accessExpiresAtUtc: new Date(Date.now() + 5 * 60 * 1000).toISOString()
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
