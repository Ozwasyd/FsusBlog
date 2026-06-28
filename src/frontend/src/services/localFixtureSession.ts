import type { AdminPrincipalSnapshot } from '@/api/auth'
import type { CurrentUserSnapshot } from '@/api/auth'

const LOCAL_FIXTURE_SESSION_KEY = 'fsusblog_local_fixture_session'
let fixtureCookieRefreshPromise: Promise<boolean> | null = null

interface LocalFixtureStatus {
  hasAccessToken?: boolean
  hasSessionId?: boolean
  hasAdminAccessToken?: boolean
  hasAdminSessionId?: boolean
  hasHostAccessToken?: boolean
  hasHostAdminAccessToken?: boolean
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
  return Boolean(
    import.meta.env.DEV &&
    import.meta.env.MODE === 'development' &&
    !import.meta.env.PROD &&
    isLocalFixtureHost()
  )
}

export function activateLocalFixtureSession(): void {
  if (!canUseLocalFixtureSession() || typeof sessionStorage === 'undefined') {
    return
  }
  sessionStorage.setItem(LOCAL_FIXTURE_SESSION_KEY, '1')
}

export function clearLocalFixtureSession(): void {
  if (typeof sessionStorage === 'undefined') {
    return
  }
  sessionStorage.removeItem(LOCAL_FIXTURE_SESSION_KEY)
}

function hasLocalFixtureQueryFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return new URLSearchParams(window.location.search).get('fsusLocalFixtureLogin') === '1'
}

export function isLocalFixtureSessionActive(): boolean {
  return Boolean(
    canUseLocalFixtureSession()
    && (
      hasLocalFixtureQueryFlag()
      || (
        typeof sessionStorage !== 'undefined'
        && sessionStorage.getItem(LOCAL_FIXTURE_SESSION_KEY) === '1'
      )
    )
  )
}

function currentRedirectPath(fallback = '/user/manage'): string {
  if (typeof window === 'undefined') {
    return fallback
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`
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
  const response = await fetch('/api/local/auth-fixture/status', {
    cache: 'no-store',
    credentials: 'include'
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

      void redirectPath
      return false
    } catch {
      return false
    } finally {
      fixtureCookieRefreshPromise = null
    }
  })()

  return fixtureCookieRefreshPromise
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
