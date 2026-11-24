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
import { publicOriginBase } from './siteBrand'

export type InitialLoginState = Readonly<{
  adminActive: boolean
  hasPasskeys: boolean
  canRegister: boolean
  hasPersistentPasskeys: boolean
  recoveryAvailable: boolean
}>

export type InitialRegisterState = Readonly<{ available: boolean }>
export type InitialAdminEntry = Readonly<{ authority: AdminAuthority; unifiedLogin: boolean }>
export type WorkspacePreloadOutcome = Readonly<{ redirect?: RouteLocationRaw }>
export type InitialPrivateMediaPage = Awaited<ReturnType<typeof listMedia>>

type PreloadSlot = {
  login?: InitialLoginState
  register?: InitialRegisterState
  admin?: InitialAdminEntry
  canvas?: readonly CanvasGraphHeader[]
  privateMedia?: InitialPrivateMediaPage
  authoringReady?: boolean
}

let preloaded: PreloadSlot = {}
const authoringRoutes = new Set<unknown>(['write', 'article-workspace', 'edit', 'canvas', 'canvas-document', 'private-media'])
const isUserRoute = (route: Pick<RouteLocationNormalized, 'path'>) => route.path === '/user' || route.path.startsWith('/user/')
const isAdminPath = (route: Pick<RouteLocationNormalized, 'path' | 'meta'>) =>
  route.meta.adminSection !== undefined || route.path === '/admin' || route.path.startsWith('/admin/')

export function clearWorkspacePreload(): void { preloaded = {} }

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
      let canRegister = false, hasPersistentPasskeys = false, recoveryAvailable = false
      if (hasPasskeys) {
        ;[canRegister, hasPersistentPasskeys, recoveryAvailable] = await Promise.all([
          readerRegistrationAvailable(signal).catch(() => false),
          siteRefreshAvailable(signal).catch(() => false),
          siteRecoveryAvailable(signal).catch(() => false),
        ])
        if (signal.aborted) return {}
      }
      preloaded.login = { adminActive, hasPasskeys, canRegister, hasPersistentPasskeys, recoveryAvailable }
      return {}
    }

    if (to.name === 'register') {
      const available = await readerRegistrationAvailable(signal)
      if (!signal.aborted) preloaded.register = { available }
      return {}
    }

    if (to.meta.adminSection !== undefined && from.meta.adminSection === undefined) {
      const splitAdminHost = Boolean(publicOriginBase())
      const [authority, canUseUnifiedLogin] = await Promise.all([
        readAdminAuthority(signal),
        splitAdminHost ? Promise.resolve(false) : passkeyAvailable(signal).catch(() => false),
      ])
      if (signal.aborted) return {}
      if (authority.status === 'signed-out' && !splitAdminHost && canUseUnifiedLogin) {
        markAdminSessionHint(false)
        return { redirect: { name: 'login', query: { redirect: to.fullPath }, replace: true } }
      }
      preloaded.admin = { authority, unifiedLogin: canUseUnifiedLogin }
      return {}
    }

    if (authoringRoutes.has(to.name)) {
      await refreshAuthorSession(signal)
      if (signal.aborted) return {}
      preloaded.authoringReady = true
      if (currentAuthorSession.value?.canAuthor) {
        if (to.name === 'canvas') {
          const { canvasGraph } = await import('../../Contracts/canvas-graph')
          const list = await canvasGraph.list(signal).catch(() => undefined)
          if (!signal.aborted && list) preloaded.canvas = list
        } else if (to.name === 'private-media') {
          const { listMedia: fetchMedia } = await import('../../Contracts/private-media')
          const page = await fetchMedia(undefined, signal).catch(() => undefined)
          if (!signal.aborted && page) preloaded.privateMedia = page
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

function take<K extends keyof PreloadSlot>(key: K): PreloadSlot[K] {
  const value = preloaded[key]
  preloaded[key] = undefined
  return value
}

export const readInitialLoginState = () => take('login')
export const readInitialRegisterState = () => take('register')
export const readInitialAdminEntry = () => take('admin')
export const consumeAuthoringSessionPreload = () => take('authoringReady') ?? false
export const readInitialCanvasDocuments = () => take('canvas')
export const readInitialPrivateMediaPage = () => take('privateMedia')
