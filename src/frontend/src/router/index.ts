import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw
} from 'vue-router'
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'
import { getPublicRuntimeOwner } from '@/bootstrap/publicTakeoverState'
import { isPublicSearchRouteName, isPublicSeoRouteName, isPublicShellRouteName } from '@/public-renderers/publicPageModel'
import { PUBLIC_BLOG_CHILD_ROUTES, PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'
import { normalizePublicSearchQuery } from '@/public-renderers/publicSearchRoutePolicy'
import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import type { PublicRoutePrewarmPort } from '@/router/publicRoutePreload'
import {
  clearPublicSearchNoIndexHead,
  clearPublicSeoHead,
  commitPublicSearchNoIndexHead,
  commitPreparedPublicSeoHead,
  hasPreparedPublicSeoHead
} from '@/router/publicSeoHead'
import { useAdminStore } from '@/store/admin'
import {
  hideNavigationProgress,
  showNavigationProgress
} from '@/services/navigationProgress'
import {
  activateLocalFixtureSession,
  buildLocalFixtureAdminUrl,
  createLocalFixtureAccountSnapshot,
  createLocalFixtureAdminPrincipal,
  ensureLocalFixtureSessionCookies,
  hasCompleteFixtureCookies,
  isLocalFixtureAdminSessionActive,
  isLocalFixtureQueryEnabled,
  isLocalFixtureSessionActive,
  readFixtureStatus
} from '@/services/localFixtureSession'
import {
  buildPrivateLoginRedirect,
  guestQueryNeedsSanitizing,
  privateQueryNeedsSanitizing,
  sanitizeGuestRouteQuery,
  sanitizePrivateRouteQuery,
  type RouteStateClass
} from '@/security/privateNavigationPolicy'

const PROGRESS_DELAY_MS = 120
let progressTimer: ReturnType<typeof window.setTimeout> | undefined
let progressVisible = false
let progressRequestId = 0

function scheduleProgressForSlowNavigation(): void {
  if (typeof window === 'undefined') return

  const requestId = ++progressRequestId
  if (progressTimer) {
    window.clearTimeout(progressTimer)
  }

  progressTimer = window.setTimeout(() => {
    progressTimer = undefined
    if (requestId !== progressRequestId) return

    progressVisible = true
    showNavigationProgress()
  }, PROGRESS_DELAY_MS)
}

function finishProgressNavigation(): void {
  if (typeof window === 'undefined') return

  progressRequestId++
  if (progressTimer) {
    window.clearTimeout(progressTimer)
    progressTimer = undefined
  }

  if (progressVisible) {
    progressVisible = false
    hideNavigationProgress()
  }
}

const selfMeta = (
  title: string,
  accountContentMode: 'standard' | 'takeover' = 'standard',
  routeState: Exclude<RouteStateClass, 'public-shareable'> = 'private-recoverable'
) => ({
  title,
  accountArea: 'self' as const,
  accountContentMode,
  routeState,
  allowLoginRedirect: routeState === 'private-recoverable',
  requiresConfirmedIdentity: false,
  requiresAccountSession: true
})

const manageMeta = (
  title: string,
  permissions: readonly string[],
  accountContentMode: 'wide' | 'takeover' = 'wide',
  routeState: Exclude<RouteStateClass, 'public-shareable'> = 'private-recoverable'
) => ({
  title,
  accountArea: 'manage' as const,
  accountContentMode,
  routeState,
  allowLoginRedirect: routeState === 'private-recoverable',
  requiresConfirmedIdentity: false,
  requiresAdminSession: true,
  requiredAdminPermissions: permissions
})

export const APP_ROUTE_RECORDS: RouteRecordRaw[] = [
  // --- 前台公共路由 ---
  {
    path: '/',
    component: () => import('@/layouts/BlogLayout.vue'),
    children: [...PUBLIC_BLOG_CHILD_ROUTES]
  },
  // --- 认证路由 ---
  {
    path: '/',
    component: () => import('@/layouts/PublicAuthLayout.vue'),
    children: [
      {
        path: 'login',
        name: 'Login',
        component: () => import('@/views/auth/Login.vue'),
        meta: { title: '登录', guestOnly: true, routeState: 'session-sensitive' }
      },
      {
        path: 'register',
        name: 'Register',
        component: () => import('@/views/auth/Register.vue'),
        meta: { title: '注册', guestOnly: true, routeState: 'session-sensitive' }
      },
      {
        path: 'recover',
        name: 'Recover',
        component: () => import('@/views/auth/Recover.vue'),
        meta: { title: '恢复访问', guestOnly: true, routeState: 'session-sensitive' }
      }
    ]
  },
  // --- 统一账户中心 ---
  {
    path: '/user',
    component: () => import('@/layouts/AccountLayout.vue'),
    meta: {
      requiresConfirmedIdentity: true,
      accountArea: 'self',
      accountContentMode: 'standard',
      routeState: 'memory-only',
      allowLoginRedirect: false
    },
    children: [
      { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', redirect: { name: 'UserIdentityOverview' }, component: () => import('@/views/user/Profile.vue'), meta: selfMeta('身份中心') },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: selfMeta('公开评论记录') },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: selfMeta('我的消息', 'takeover') },
      { path: 'identity', name: 'UserIdentityOverview', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('身份总览') },
      { path: 'identity/passkeys', name: 'UserIdentityPasskeys', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('通行密钥', 'standard', 'session-sensitive') },
      { path: 'identity/recovery-key', name: 'UserIdentityRecoveryKey', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('Recovery Key', 'standard', 'session-sensitive') },
      { path: 'identity/anonymous', name: 'UserIdentityAnonymous', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('匿名身份') },
      { path: 'identity/public-profile', name: 'UserIdentityPublicProfile', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('公开资料') },
      { path: 'identity/sessions', name: 'UserIdentitySessions', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('设备会话', 'standard', 'session-sensitive') },
      { path: 'identity/mfa', name: 'UserIdentityMfa', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('二次验证', 'standard', 'session-sensitive') },
      { path: 'identity/comment-records', name: 'UserIdentityCommentRecords', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta('公开评论记录') },
      { path: 'manage', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: manageMeta('仪表盘', ['admin.manage']) },
      { path: 'manage/analytics', name: 'ManageAnalytics', component: () => import('@/views/admin/Analytics.vue'), meta: manageMeta('数据概览', ['admin.manage']) },
      { path: 'manage/article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta('写文章', ['article.write']) },
      { path: 'manage/article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta('编辑文章', ['article.write'], 'wide', 'memory-only') },
      { path: 'manage/article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: manageMeta('文章管理', ['article.write']) },
      { path: 'manage/article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: manageMeta('回收站', ['article.write']) },
      {
        path: 'manage/security',
        component: () => import('@/views/admin/security/SecurityLayout.vue'),
        meta: manageMeta('安全系统', ['system.config']),
        children: [
          { path: '', name: 'ManageSecurityDashboard', component: () => import('@/views/admin/security/SecurityDashboard.vue'), meta: manageMeta('安全系统', ['system.config']) },
          { path: 'risk-control', name: 'ManageSecurityRiskControl', component: () => import('@/views/admin/security/SecurityRiskControl.vue'), meta: manageMeta('风险控制', ['system.config']) },
          { path: 'simulator', name: 'ManageSecuritySimulator', component: () => import('@/views/admin/security/SecuritySimulator.vue'), meta: manageMeta('风险模拟器', ['system.config']) },
          { path: 'challenges', name: 'ManageSecurityChallenges', component: () => import('@/views/admin/security/SecurityChallenges.vue'), meta: manageMeta('验证任务', ['system.config'], 'wide', 'session-sensitive') },
          { path: 'policies', name: 'ManageSecurityPolicies', component: () => import('@/views/admin/security/SecurityPolicies.vue'), meta: manageMeta('策略版本', ['system.config']) },
          { path: 'events', name: 'ManageSecurityEvents', component: () => import('@/views/admin/security/SecurityEvents.vue'), meta: manageMeta('风险事件', ['system.config']) },
          { path: 'captcha', name: 'ManageSecurityCaptcha', component: () => import('@/views/admin/security/SecurityCaptcha.vue'), meta: manageMeta('Captcha 验证', ['system.config']) },
          { path: 'pospace', name: 'ManageSecurityPoSpace', component: () => import('@/views/admin/security/SecurityPoSpace.vue'), meta: manageMeta('PoSpace 验证', ['system.config']) },
          { path: 'perception-v2', name: 'ManageSecurityPerceptionV2', component: () => import('@/views/admin/security/SecurityPerceptionV2.vue'), meta: manageMeta('人机感知验证', ['system.config']) },
          { path: 'crawler', name: 'ManageSecurityCrawler', component: () => import('@/views/admin/security/SecurityCrawler.vue'), meta: manageMeta('反爬虫系统', ['system.config']) },
          { path: 'pow', name: 'ManageSecurityPow', component: () => import('@/views/admin/security/SecurityPow.vue'), meta: manageMeta('PoW 系统', ['system.config']) }
        ]
      },
      {
        path: 'manage/moderation',
        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
        meta: manageMeta('审核系统', ['comment.moderate']),
        children: [
          { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: manageMeta('审核系统', ['comment.moderate']) },
          { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: manageMeta('评论审核', ['comment.moderate']) },
          { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: manageMeta('词库管理', ['comment.moderate']) },
          { path: 'anonymous-policy', name: 'ManageAnonymousCommentPolicy', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名评论策略', ['anonymous.comment.configure']) },
          { path: 'anonymous-risk', name: 'ManageAnonymousRisk', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名风险', ['comment.moderate']) },
          { path: 'anonymous-credentials', name: 'ManageAnonymousCredentials', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名资格', ['anonymous.credential.revoke']) },
          { path: 'nullifiers', name: 'ManageAnonymousNullifiers', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名标识', ['anonymous.nullifier.block']) },
          { path: 'zk-anonymous', name: 'ManageZkAnonymousStatus', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('隐私证明状态', ['anonymous.comment.configure']) },
          { path: 'policies', name: 'ManageModerationPolicies', component: () => import('@/views/admin/moderation/ModerationPolicies.vue'), meta: manageMeta('地区策略', ['comment.moderate']) },
          { path: 'regions', name: 'ManageModerationRegions', component: () => import('@/views/admin/moderation/ModerationRegions.vue'), meta: manageMeta('地区管理', ['comment.moderate']) },
          { path: 'region-groups', name: 'ManageModerationRegionGroups', component: () => import('@/views/admin/moderation/ModerationRegionGroups.vue'), meta: manageMeta('大区管理', ['comment.moderate']) },
          { path: 'policy-templates', name: 'ManageModerationPolicyTemplates', component: () => import('@/views/admin/moderation/ModerationPolicyTemplates.vue'), meta: manageMeta('策略模板', ['comment.moderate']) },
          { path: 'replay', name: 'ManageModerationReplay', component: () => import('@/views/admin/moderation/ModerationReplay.vue'), meta: manageMeta('策略回放', ['comment.moderate']) },
          { path: 'model', name: 'ManageModerationModel', component: () => import('@/views/admin/moderation/ModerationModel.vue'), meta: manageMeta('审核模型', ['comment.moderate']) },
          { path: 'audit', name: 'ManageModerationAudit', component: () => import('@/views/admin/moderation/ModerationAudit.vue'), meta: manageMeta('审核审计', ['comment.moderate']) }
        ]
      },
      { path: 'manage/comments', name: 'ManageCommentModeration', redirect: { name: 'ManageModerationComments' }, meta: manageMeta('评论审核', ['comment.moderate']) },
      { path: 'manage/messages', name: 'ManageMessages', component: () => import('@/views/admin/MessageCenter.vue'), meta: manageMeta('站内信中心', ['admin.manage'], 'takeover') },
      { path: 'manage/category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: manageMeta('分类管理', ['article.write']) },
      { path: 'manage/tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: manageMeta('标签管理', ['article.write']) },
      { path: 'manage/assets', name: 'ManageAssets', component: () => import('@/views/admin/Assets.vue'), meta: manageMeta('资产库', ['article.write']) },
      { path: 'manage/content-tools', name: 'ManageContentTools', component: () => import('@/views/admin/ContentTools.vue'), meta: manageMeta('备份与迁移', ['system.config']) },
      { path: 'manage/audit', name: 'ManageAuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: manageMeta('审计日志', ['audit.read']) },
      { path: 'manage/ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: manageMeta('服务与后台状态', ['system.config']) },
      { path: 'manage/cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: manageMeta('缓存与索引', ['system.config']) },
      { path: 'manage/integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: manageMeta('内容一致性', ['system.config']) },
      { path: 'manage/integrity-proof', name: 'ManageIntegrityProof', component: () => import('@/views/admin/IntegrityProofConsole.vue'), meta: manageMeta('Integrity Proof', ['system.config'], 'wide', 'session-sensitive') },
      { path: 'manage/settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: manageMeta('系统设置', ['system.config']) },
      { path: 'manage/users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: manageMeta('用户管理', ['admin.manage']) }
    ]
  },
  // --- 错误页 ---
  { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { title: '无权访问', routeState: 'memory-only' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { title: '页面不存在', routeState: 'public-shareable' } }
]

export type RouterFactoryOptions = Readonly<{
  history?: RouterHistory
  ssr?: boolean
  prewarmPublicRoute?: PublicRoutePrewarmPort
}>

function readRouteRequiredPermissions(route: RouteLocationNormalized): string[] {
  const value = route.meta.requiredAdminPermissions
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function readAccountShellRouteKey(route: RouteLocationNormalized): string | null {
  const accountRootIndex = route.matched.findIndex((record) => record.path === '/user')
  if (accountRootIndex < 0) {
    return null
  }

  const shellRecord = route.matched[accountRootIndex + 1]
  return shellRecord?.name !== undefined ? String(shellRecord.name) : shellRecord?.path ?? null
}

function isSameAccountShellChildSwitch(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
  const toShellKey = readAccountShellRouteKey(to)
  const fromShellKey = readAccountShellRouteKey(from)
  if (!toShellKey || toShellKey !== fromShellKey) {
    return false
  }

  const toAccountRootIndex = to.matched.findIndex((record) => record.path === '/user')
  const fromAccountRootIndex = from.matched.findIndex((record) => record.path === '/user')
  return to.matched.length > toAccountRootIndex + 2
    || from.matched.length > fromAccountRootIndex + 2
}

function applyRouteGuards(router: Router, options: RouterFactoryOptions = {}): void {
  router.beforeEach(async (to, from) => {
    if (isPublicSearchRouteName(to.name)) {
      const normalized = normalizePublicSearchQuery(to.query)
      if (normalized.invalidKeyword || normalized.shouldRedirect) {
        return {
          name: PUBLIC_SEARCH_ROUTE_NAME,
          query: normalized.query,
          hash: to.hash,
          replace: true
        }
      }
    }

    const sessionBootstrap = useSessionBootstrap()
    const { userStore, siteStore } = sessionBootstrap
    const adminStore = useAdminStore()
    const accountRoute = to.meta.requiresAccountSession === true || to.meta.requiresAuth === true
    const manageRoute = to.meta.requiresAdminSession === true
    const identityRootRoute = to.path === '/user' && to.meta.requiresConfirmedIdentity === true
    const fixtureQueryEnabled = isLocalFixtureQueryEnabled(to.query.fsusLocalFixtureLogin)
    if (!options.ssr && fixtureQueryEnabled) {
      activateLocalFixtureSession()
    }
    const forceLocalFixtureSession = !options.ssr && isLocalFixtureSessionActive()
    const fixtureRouteNeedsCookies = forceLocalFixtureSession && (accountRoute || manageRoute || identityRootRoute)
    const fixtureCredentialRouteNeedsCookies = forceLocalFixtureSession && Boolean(to.meta.localFixtureCredentialBootstrap)

    if (fixtureRouteNeedsCookies || fixtureCredentialRouteNeedsCookies) {
      const status = await readFixtureStatus()
      if ((!status || !hasCompleteFixtureCookies(status)) && !await ensureLocalFixtureSessionCookies(to.fullPath)) {
        if (typeof window !== 'undefined') {
          window.location.replace(buildLocalFixtureAdminUrl(to.fullPath))
        }
        return false
      }

      userStore.markAuthenticated(createLocalFixtureAccountSnapshot())
      if (isLocalFixtureAdminSessionActive()) {
        adminStore.setAdminPrincipal(createLocalFixtureAdminPrincipal())
      } else {
        adminStore.clearAdminPrincipal('missing')
      }
      sessionBootstrap.syncAuthPhase()
    }

    const nonPublicRoute = to.meta.routeState !== 'public-shareable'
    const routeQueryNeedsSanitizing = to.meta.guestOnly === true
      ? guestQueryNeedsSanitizing(to.name, to.query, router)
      : privateQueryNeedsSanitizing(to.name, to.query)
    if (nonPublicRoute && (routeQueryNeedsSanitizing || Boolean(to.hash))) {
      return {
        name: to.name ?? undefined,
        path: to.name ? undefined : to.path,
        params: to.params,
        query: to.meta.guestOnly === true
          ? sanitizeGuestRouteQuery(to.name, to.query, router)
          : sanitizePrivateRouteQuery(to.name, to.query),
        hash: '',
        // Replace an address-bar/refresh entry, but keep the previous safe
        // entry when an in-app navigation was redirected before commit.
        replace: from.matched.length === 0
      }
    }

    const publicShellRoute = isPublicShellRouteName(to.name)
    const publicSeoRoute = isPublicSeoRouteName(to.name)
    const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null
    const shouldDeferPublicBootstrap =
      !options.ssr
      && publicSeoRoute
      && hasServerAotShell(appRoot)
    const needsInitialSpaFallbackHead =
      !options.ssr
      && options.history === undefined
      && publicSeoRoute
      && !hasServerAotShell(appRoot)
      && from.matched.length === 0
    const fullAppOwnsPublicRoute =
      getPublicRuntimeOwner() === 'spa'
      || (appRoot !== null && !hasServerAotShell(appRoot) && from.matched.length > 0)

    if (!options.ssr && publicSeoRoute &&
        (needsInitialSpaFallbackHead || (fullAppOwnsPublicRoute && to.fullPath !== from.fullPath)) &&
      !hasPreparedPublicSeoHead(to.fullPath)) {
      if (!options.prewarmPublicRoute) {
        window.location.assign(to.fullPath)
        return false
      }

      const prewarm = await options.prewarmPublicRoute(to.fullPath, { reason: 'atomic-navigation' })
      if (prewarm.status !== 'ready') {
        window.location.assign(to.fullPath)
        return false
      }
    }

    if (!options.ssr && !shouldDeferPublicBootstrap && !isSameAccountShellChildSwitch(to, from)) {
      scheduleProgressForSlowNavigation()
    }

    if (!options.ssr && !shouldDeferPublicBootstrap && publicShellRoute) {
      await sessionBootstrap.ensurePublicShell()
    } else if (!options.ssr && !shouldDeferPublicBootstrap && sessionBootstrap.needsBootstrap()) {
      await sessionBootstrap.ensureBootstrap()
    }

    if (!publicSeoRoute && (!shouldDeferPublicBootstrap || siteStore.isLoaded)) {
      sessionBootstrap.syncDocumentTitle(to)
    }

    if (publicShellRoute) {
      return true
    }

    if (to.meta.guestOnly) {
      await sessionBootstrap.ensureAccountSession({ reason: 'route' })
    } else if (manageRoute || identityRootRoute) {
      if (forceLocalFixtureSession) {
        userStore.markAuthenticated(createLocalFixtureAccountSnapshot())
        if (isLocalFixtureAdminSessionActive()) {
          adminStore.setAdminPrincipal(createLocalFixtureAdminPrincipal())
        } else {
          adminStore.clearAdminPrincipal('missing')
        }
        sessionBootstrap.syncAuthPhase()
      } else {
        await Promise.all([
          sessionBootstrap.ensureAccountSession({ reason: 'route' }),
          sessionBootstrap.ensureAdminSession({ reason: 'route' })
        ])
      }
    } else if (accountRoute) {
      await sessionBootstrap.ensureAccountSession({ reason: 'route' })
    }

    const { isLoggedIn } = userStore

    if (to.meta.guestOnly && isLoggedIn) {
      return adminStore.adminState === 'active' ? '/user/manage' : '/user/identity'
    }

    if (accountRoute && !isLoggedIn) {
      return { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } }
    }

    if (manageRoute) {
      if (adminStore.adminState !== 'active') {
        return isLoggedIn
          ? '/403'
          : { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } }
      }

      const requiredPermissions = readRouteRequiredPermissions(to)
      if (requiredPermissions.length === 0
        || !requiredPermissions.every((permission) => adminStore.hasPermission(permission))) {
        return '/403'
      }
    }

    if (identityRootRoute) {
      if (adminStore.adminState === 'active') {
        return '/user/manage'
      }
      if (isLoggedIn) {
        return '/user/identity'
      }
      return { path: '/login', query: { redirect: buildPrivateLoginRedirect(to, router) } }
    }

    return true
  })

  if (options.ssr) {
    return
  }

  router.afterEach((to, from) => {
    if (isPublicSeoRouteName(to.name)) {
      if (hasPreparedPublicSeoHead(to.fullPath)) {
        commitPreparedPublicSeoHead(to.fullPath, from.fullPath)
      }
    } else if (isPublicSearchRouteName(to.name)) {
      commitPublicSearchNoIndexHead(isPublicSeoRouteName(from.name) ? from.fullPath : undefined)
      useSessionBootstrap().syncDocumentTitle(to)
    } else if (isPublicSeoRouteName(from.name)) {
      clearPublicSeoHead(from.fullPath)
      useSessionBootstrap().syncDocumentTitle(to)
    }
    if (!isPublicSearchRouteName(to.name)) {
      clearPublicSearchNoIndexHead()
    }
    finishProgressNavigation()
  })

  router.onError(() => {
    finishProgressNavigation()
  })
}

export function createAppRouter(options: RouterFactoryOptions = {}): Router {
  const baseUrl = import.meta.env?.BASE_URL ?? '/'
  const history = options.history ?? (
    options.ssr
      ? createMemoryHistory(baseUrl)
      : createWebHistory(baseUrl)
  )

  const router = createRouter({
    history,
    routes: APP_ROUTE_RECORDS,
    scrollBehavior: (to, _from, savedPosition) => {
      if (savedPosition) {
        return savedPosition
      }

      if (to.hash === '#top') {
        return { left: 0, top: 0, behavior: 'auto' }
      }

      if (to.hash) {
        return {
          el: to.hash,
          top: 88,
          behavior: resolveMotionScrollBehavior()
        }
      }

      return { left: 0, top: 0, behavior: 'auto' }
    }
  })

  applyRouteGuards(router, options)
  return router
}
