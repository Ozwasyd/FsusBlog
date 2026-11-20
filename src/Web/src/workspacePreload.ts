import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'
import { readAdminAuthority, type AdminAuthority } from '../../Contracts/admin-identity'
import type { CanvasGraphHeader } from '../../Contracts/canvas-graph'
import { passkeyAvailable } from '../../Contracts/passkey'
import type { listMedia } from '../../Contracts/private-media'
import { readerRegistrationAvailable } from '../../Contracts/reader-registration'
import { siteRecoveryAvailable } from '../../Contracts/recovery-key'
import { siteRefreshAvailable } from '../../Contracts/site-refresh'
import {
  currentSession as currentAuthorSession,
  hasAdminSessionHint,
  markAdminSessionHint,
  refreshSession as refreshAuthorSession,
} from './authorSession'
import {
  currentSession as currentReaderSession,
  refreshSession as refreshReaderSession,
} from './session'

export type InitialLoginState = Readonly<{
  adminActive: boolean
  hasPasskeys: boolean
  canRegister: boolean
  hasPersistentPasskeys: boolean
  recoveryAvailable: boolean
}>

export type InitialRegisterState = Readonly<{
  available: boolean
}>

export type InitialAdminEntry = Readonly<{
  authority: AdminAuthority
  unifiedLogin: boolean
}>

export type WorkspacePreloadOutcome = Readonly<{
  redirect?: RouteLocationRaw
}>

export type InitialPrivateMediaPage = Awaited<ReturnType<typeof listMedia>>

let loginState: InitialLoginState | undefined
let registerState: InitialRegisterState | undefined
let adminEntry: InitialAdminEntry | undefined
let canvasDocuments: readonly CanvasGraphHeader[] | undefined
let privateMediaPage: InitialPrivateMediaPage | undefined
let authoringSessionReady = false

function isSplitAdminHost(): boolean {
  const configuredPublicOrigin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
  return Boolean(configuredPublicOrigin && configuredPublicOrigin !== globalThis.location?.origin)
}

function isAuthoringRoute(route: Pick<RouteLocationNormalized, 'name'>): boolean {
  return route.name === 'write' ||
    route.name === 'article-workspace' ||
    route.name === 'edit' ||
    route.name === 'canvas' ||
    route.name === 'canvas-document' ||
    route.name === 'private-media'
}

function isUserRoute(route: Pick<RouteLocationNormalized, 'path'>): boolean {
  return route.path === '/user' || route.path.startsWith('/user/')
}

function isAdminPath(route: Pick<RouteLocationNormalized, 'path' | 'meta'>): boolean {
  return route.meta.adminSection !== undefined || route.path === '/admin' || route.path.startsWith('/admin/')
}

export function clearWorkspacePreload(): void {
  loginState = undefined
  registerState = undefined
  adminEntry = undefined
  canvasDocuments = undefined
  privateMediaPage = undefined
  authoringSessionReady = false
}

export async function preloadWorkspaceRoute(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  signal: AbortSignal,
): Promise<WorkspacePreloadOutcome> {
  clearWorkspacePreload()
  try {
    if (to.name === 'login') {
      const [adminAuthority, hasPasskeys] = await Promise.all([
        readAdminAuthority(signal).catch(() => null),
        passkeyAvailable(signal).catch(() => false),
      ])
      if (signal.aborted) return {}
      const adminActive = adminAuthority?.status === 'active'
      if (adminAuthority) markAdminSessionHint(adminActive)
      let canRegister = false
      let hasPersistentPasskeys = false
      let recoveryAvailable = false
      if (hasPasskeys) {
        ;[canRegister, hasPersistentPasskeys, recoveryAvailable] = await Promise.all([
          readerRegistrationAvailable(signal).catch(() => false),
          siteRefreshAvailable(signal).catch(() => false),
          siteRecoveryAvailable(signal).catch(() => false),
        ])
        if (signal.aborted) return {}
      }
      loginState = { adminActive, hasPasskeys, canRegister, hasPersistentPasskeys, recoveryAvailable }
      return {}
    }

    if (to.name === 'register') {
      const available = await readerRegistrationAvailable(signal)
      if (!signal.aborted) registerState = { available }
      return {}
    }

    if (to.meta.adminSection !== undefined && from.meta.adminSection === undefined) {
      const splitAdminHost = isSplitAdminHost()
      const [authority, canUseUnifiedLogin] = await Promise.all([
        readAdminAuthority(signal),
        splitAdminHost ? Promise.resolve(false) : passkeyAvailable(signal).catch(() => false),
      ])
      if (signal.aborted) return {}
      if (authority.status === 'signed-out' && !splitAdminHost && canUseUnifiedLogin) {
        markAdminSessionHint(false)
        return { redirect: { name: 'login', query: { redirect: to.fullPath }, replace: true } }
      }
      adminEntry = { authority, unifiedLogin: canUseUnifiedLogin }
      return {}
    }

    if (isAuthoringRoute(to)) {
      await refreshAuthorSession(signal)
      if (signal.aborted) return {}
      authoringSessionReady = true
      if (currentAuthorSession.value?.canAuthor) {
        if (to.name === 'canvas') {
          const { canvasGraph } = await import('../../Contracts/canvas-graph')
          const list = await canvasGraph.list(signal).catch(() => undefined)
          if (!signal.aborted && list) canvasDocuments = list
        } else if (to.name === 'private-media') {
          const { listMedia: fetchMedia } = await import('../../Contracts/private-media')
          const page = await fetchMedia(undefined, signal).catch(() => undefined)
          if (!signal.aborted && page) privateMediaPage = page
        }
      }
      return {}
    }

    if (isUserRoute(to)) {
      if (!currentReaderSession.value) await refreshReaderSession(signal).catch(() => {})
      return {}
    }

    if (isAdminPath(from) && hasAdminSessionHint() && !currentAuthorSession.value) {
      await refreshAuthorSession(signal).catch(() => {})
    }
  } catch {
    // Each view owns retry, empty, and error states after takeover.
  }
  return {}
}

export function readInitialLoginState(): InitialLoginState | undefined {
  const value = loginState
  loginState = undefined
  return value
}

export function readInitialRegisterState(): InitialRegisterState | undefined {
  const value = registerState
  registerState = undefined
  return value
}

export function readInitialAdminEntry(): InitialAdminEntry | undefined {
  const value = adminEntry
  adminEntry = undefined
  return value
}

export function consumeAuthoringSessionPreload(): boolean {
  const value = authoringSessionReady
  authoringSessionReady = false
  return value
}

export function readInitialCanvasDocuments(): readonly CanvasGraphHeader[] | undefined {
  const value = canvasDocuments
  canvasDocuments = undefined
  return value
}

export function readInitialPrivateMediaPage(): InitialPrivateMediaPage | undefined {
  const value = privateMediaPage
  privateMediaPage = undefined
  return value
}
