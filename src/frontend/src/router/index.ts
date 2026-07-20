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
  assertAccountLeafRouteMeta,
  type ManageMetaOptions,
  type SelfMetaOptions
} from '@/router/accountRouteMeta'
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
  sanitizePrivateRouteQuery
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

const selfMeta = ({
  title,
  pageKind: accountPageKind,
  contentMode: accountContentMode = 'standard',
  routeState = 'private-recoverable'
}: SelfMetaOptions) => ({
  title,
  accountArea: 'self' as const,
  accountPageKind,
  accountContentMode,
  routeState,
  allowLoginRedirect: routeState === 'private-recoverable',
  requiresConfirmedIdentity: false,
  requiresAccountSession: true
})

const manageMeta = ({
  title,
  permissions,
  pageKind: accountPageKind,
  contentMode: accountContentMode = 'wide',
  routeState = 'private-recoverable'
}: ManageMetaOptions) => ({
  title,
  accountArea: 'manage' as const,
  accountPageKind,
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
      {
        path: '',
        components: {
          default: () => import('@/layouts/AccountIdentityFrame.vue'),
          accountMobileAction: () => import('@/layouts/AccountFrameMobileAction.vue')
        },
        children: [
      { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', redirect: { name: 'UserIdentityOverview' }, meta: selfMeta({ title: '身份中心', pageKind: 'identity-settings' }) },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: selfMeta({ title: '公开评论记录', pageKind: 'collection' }) },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: selfMeta({ title: '我的消息', pageKind: 'inbox', contentMode: 'takeover' }) },
      { path: 'identity', name: 'UserIdentityOverview', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '身份总览', pageKind: 'identity-settings' }) },
      { path: 'identity/passkeys', name: 'UserIdentityPasskeys', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '通行密钥', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
      { path: 'identity/recovery-key', name: 'UserIdentityRecoveryKey', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: 'Recovery Key', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
      { path: 'identity/anonymous', name: 'UserIdentityAnonymous', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '匿名身份', pageKind: 'identity-settings' }) },
      { path: 'identity/public-profile', name: 'UserIdentityPublicProfile', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '公开资料', pageKind: 'identity-settings' }) },
      { path: 'identity/sessions', name: 'UserIdentitySessions', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '设备会话', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
      { path: 'identity/mfa', name: 'UserIdentityMfa', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '二次验证', pageKind: 'identity-settings', routeState: 'session-sensitive' }) },
      { path: 'identity/comment-records', name: 'UserIdentityCommentRecords', component: () => import('@/views/user/IdentityCenter.vue'), meta: selfMeta({ title: '公开评论记录', pageKind: 'identity-settings' }) },
        ]
      },
      {
        path: 'manage',
        components: {
          default: () => import('@/layouts/AdminWorkspaceFrame.vue'),
          accountMobileAction: () => import('@/layouts/AccountFrameMobileAction.vue')
        },
        children: [
      { path: '', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: manageMeta({ title: '仪表盘', permissions: ['admin.manage'], pageKind: 'dashboard' }) },
      { path: 'analytics', name: 'ManageAnalytics', component: () => import('@/views/admin/Analytics.vue'), meta: manageMeta({ title: '数据概览', permissions: ['admin.manage'], pageKind: 'collection' }) },
      { path: 'article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ title: '写文章', permissions: ['article.write'], pageKind: 'form' }) },
      { path: 'article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta({ title: '编辑文章', permissions: ['article.write'], pageKind: 'form', routeState: 'memory-only' }) },
      { path: 'article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: manageMeta({ title: '文章管理', permissions: ['article.write'], pageKind: 'collection' }) },
      { path: 'article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: manageMeta({ title: '回收站', permissions: ['article.write'], pageKind: 'collection' }) },
      {
        path: 'security',
        component: () => import('@/views/admin/security/SecurityLayout.vue'),
        meta: manageMeta({ title: '安全系统', permissions: ['system.config'], pageKind: 'console' }),
        children: [
          { path: '', name: 'ManageSecurityDashboard', component: () => import('@/views/admin/security/SecurityDashboard.vue'), meta: manageMeta({ title: '安全系统', permissions: ['system.config'], pageKind: 'collection' }) },
          { path: 'risk-control', name: 'ManageSecurityRiskControl', component: () => import('@/views/admin/security/SecurityRiskControl.vue'), meta: manageMeta({ title: '风险控制', permissions: ['system.config'], pageKind: 'console' }) },
          { path: 'simulator', name: 'ManageSecuritySimulator', component: () => import('@/views/admin/security/SecuritySimulator.vue'), meta: manageMeta({ title: '风险模拟器', permissions: ['system.config'], pageKind: 'console' }) },
          { path: 'challenges', name: 'ManageSecurityChallenges', component: () => import('@/views/admin/security/SecurityChallenges.vue'), meta: manageMeta({ title: '验证任务', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
          { path: 'policies', name: 'ManageSecurityPolicies', component: () => import('@/views/admin/security/SecurityPolicies.vue'), meta: manageMeta({ title: '策略版本', permissions: ['system.config'], pageKind: 'collection' }) },
          { path: 'events', name: 'ManageSecurityEvents', component: () => import('@/views/admin/security/SecurityEvents.vue'), meta: manageMeta({ title: '风险事件', permissions: ['system.config'], pageKind: 'collection' }) },
          { path: 'pospace', name: 'ManageSecurityPoSpace', component: () => import('@/views/admin/security/SecurityPoSpace.vue'), meta: manageMeta({ title: 'PoSpace 验证', permissions: ['system.config'], pageKind: 'console' }) },
          { path: 'perception-v2', name: 'ManageSecurityPerceptionV2', component: () => import('@/views/admin/security/SecurityPerceptionV2.vue'), meta: manageMeta({ title: '人机感知验证', permissions: ['system.config'], pageKind: 'console' }) },
          { path: 'crawler', name: 'ManageSecurityCrawler', component: () => import('@/views/admin/security/SecurityCrawler.vue'), meta: manageMeta({ title: '反爬虫系统', permissions: ['system.config'], pageKind: 'console' }) },
          { path: 'pow', name: 'ManageSecurityPow', component: () => import('@/views/admin/security/SecurityPow.vue'), meta: manageMeta({ title: 'PoW 系统', permissions: ['system.config'], pageKind: 'console' }) }
        ]
      },
      {
        path: 'moderation',
        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
        meta: manageMeta({ title: '审核系统', permissions: ['comment.moderate'], pageKind: 'collection' }),
        children: [
          { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: manageMeta({ title: '审核系统', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: manageMeta({ title: '评论审核', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: manageMeta({ title: '词库管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'anonymous-policy', name: 'ManageAnonymousCommentPolicy', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名评论策略', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
          { path: 'anonymous-risk', name: 'ManageAnonymousRisk', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名风险', permissions: ['comment.moderate'], pageKind: 'console' }) },
          { path: 'anonymous-credentials', name: 'ManageAnonymousCredentials', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名资格', permissions: ['anonymous.credential.revoke'], pageKind: 'console' }) },
          { path: 'nullifiers', name: 'ManageAnonymousNullifiers', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '匿名标识', permissions: ['anonymous.nullifier.block'], pageKind: 'console' }) },
          { path: 'zk-anonymous', name: 'ManageZkAnonymousStatus', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta({ title: '隐私证明状态', permissions: ['anonymous.comment.configure'], pageKind: 'console' }) },
          { path: 'policies', name: 'ManageModerationPolicies', component: () => import('@/views/admin/moderation/ModerationPolicies.vue'), meta: manageMeta({ title: '地区策略', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'regions', name: 'ManageModerationRegions', component: () => import('@/views/admin/moderation/ModerationRegions.vue'), meta: manageMeta({ title: '地区管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'region-groups', name: 'ManageModerationRegionGroups', component: () => import('@/views/admin/moderation/ModerationRegionGroups.vue'), meta: manageMeta({ title: '大区管理', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'policy-templates', name: 'ManageModerationPolicyTemplates', component: () => import('@/views/admin/moderation/ModerationPolicyTemplates.vue'), meta: manageMeta({ title: '策略模板', permissions: ['comment.moderate'], pageKind: 'collection' }) },
          { path: 'replay', name: 'ManageModerationReplay', component: () => import('@/views/admin/moderation/ModerationReplay.vue'), meta: manageMeta({ title: '策略回放', permissions: ['comment.moderate'], pageKind: 'console' }) },
          { path: 'model', name: 'ManageModerationModel', component: () => import('@/views/admin/moderation/ModerationModel.vue'), meta: manageMeta({ title: '审核模型', permissions: ['comment.moderate'], pageKind: 'console' }) },
          { path: 'audit', name: 'ManageModerationAudit', component: () => import('@/views/admin/moderation/ModerationAudit.vue'), meta: manageMeta({ title: '审核审计', permissions: ['comment.moderate'], pageKind: 'collection' }) }
        ]
      },
      { path: 'comments', name: 'ManageCommentModeration', redirect: { name: 'ManageModerationComments' }, meta: manageMeta({ title: '评论审核', permissions: ['comment.moderate'], pageKind: 'collection' }) },
      { path: 'messages', name: 'ManageMessages', component: () => import('@/views/admin/MessageCenter.vue'), meta: manageMeta({ title: '站内信中心', permissions: ['admin.manage'], pageKind: 'inbox', contentMode: 'takeover' }) },
      { path: 'category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: manageMeta({ title: '分类管理', permissions: ['article.write'], pageKind: 'collection' }) },
      { path: 'tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: manageMeta({ title: '标签管理', permissions: ['article.write'], pageKind: 'collection' }) },
      { path: 'assets', name: 'ManageAssets', component: () => import('@/views/admin/Assets.vue'), meta: manageMeta({ title: '资产库', permissions: ['article.write'], pageKind: 'collection' }) },
      { path: 'content-tools', name: 'ManageContentTools', component: () => import('@/views/admin/ContentTools.vue'), meta: manageMeta({ title: '备份与迁移', permissions: ['system.config'], pageKind: 'console' }) },
      { path: 'audit', name: 'ManageAuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: manageMeta({ title: '审计日志', permissions: ['audit.read'], pageKind: 'collection' }) },
      { path: 'ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: manageMeta({ title: '服务与后台状态', permissions: ['system.config'], pageKind: 'console' }) },
      { path: 'cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: manageMeta({ title: '缓存与索引', permissions: ['system.config'], pageKind: 'console' }) },
      { path: 'integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: manageMeta({ title: '内容一致性', permissions: ['system.config'], pageKind: 'console' }) },
      { path: 'integrity-proof', name: 'ManageIntegrityProof', component: () => import('@/views/admin/IntegrityProofConsole.vue'), meta: manageMeta({ title: 'Integrity Proof', permissions: ['system.config'], pageKind: 'console', routeState: 'session-sensitive' }) },
      { path: 'settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: manageMeta({ title: '系统设置', permissions: ['system.config'], pageKind: 'settings' }) },
      { path: 'users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: manageMeta({ title: '用户管理', permissions: ['admin.manage'], pageKind: 'collection' }) }
        ]
      }
    ]
  },
  // --- 错误页 ---
  { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { title: '无权访问', routeState: 'memory-only' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { title: '页面不存在', routeState: 'public-shareable' } }
]

if (import.meta.env.DEV) {
  assertAccountLeafRouteMeta(APP_ROUTE_RECORDS)
}

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

  // AccountLayout renders an area frame first; the frame renders this record.
  const shellRecord = route.matched[accountRootIndex + 2]
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
  return to.matched.length > toAccountRootIndex + 3
    || from.matched.length > fromAccountRootIndex + 3
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
