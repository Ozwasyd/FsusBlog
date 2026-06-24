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

export function activateLocalFixtureSession(): void {
  if (!import.meta.env.DEV || typeof sessionStorage === 'undefined') {
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

export function isLocalFixtureSessionActive(): boolean {
  return Boolean(
    import.meta.env.DEV
    && typeof sessionStorage !== 'undefined'
    && sessionStorage.getItem(LOCAL_FIXTURE_SESSION_KEY) === '1'
  )
}

function currentRedirectPath(fallback = '/user/manage'): string {
  if (typeof window === 'undefined') {
    return fallback
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function hasCompleteFixtureCookies(status: LocalFixtureStatus): boolean {
  return Boolean(
    (status.hasAccessToken || status.hasHostAccessToken)
    && status.hasSessionId
    && (status.hasAdminAccessToken || status.hasHostAdminAccessToken)
    && status.hasAdminSessionId
  )
}

async function readFixtureStatus(): Promise<LocalFixtureStatus | null> {
  const response = await fetch('/api/local/auth-fixture/status', {
    cache: 'no-store',
    credentials: 'include'
  })

  if (!response.ok) {
    return null
  }

  return await response.json() as LocalFixtureStatus
}

async function refreshFixtureCookies(redirectPath: string): Promise<boolean> {
  const endpoint = new URL('/api/local/auth-fixture/admin', window.location.origin)
  endpoint.searchParams.set('redirect', redirectPath)
  const response = await fetch(endpoint.toString(), {
    cache: 'no-store',
    credentials: 'include',
    redirect: 'follow'
  })
  return response.ok
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

      if (!await refreshFixtureCookies(redirectPath)) {
        return false
      }

      const refreshedStatus = await readFixtureStatus()
      return Boolean(refreshedStatus && hasCompleteFixtureCookies(refreshedStatus))
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
