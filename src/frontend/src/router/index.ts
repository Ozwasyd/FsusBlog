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
import { isPublicSeoRouteName } from '@/public-renderers/publicPageModel'
import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import { PUBLIC_BLOG_CHILD_ROUTES } from '@/public-renderers/publicRouteRegistry'
import { useAdminStore } from '@/store/admin'

type ProgressModule = typeof import('nprogress')
const PROGRESS_DELAY_MS = 120
let progressModulePromise: Promise<ProgressModule> | null = null
let progressTimer: ReturnType<typeof window.setTimeout> | undefined
let progressVisible = false
let progressRequestId = 0

function loadProgressBar(): Promise<ProgressModule> {
  if (!progressModulePromise) {
    progressModulePromise = Promise.all([
      import('nprogress'),
      import('nprogress/nprogress.css')
    ]).then(([module]) => {
      module.configure({ showSpinner: false })
      return module
    })
  }

  return progressModulePromise
}

function scheduleProgressForSlowNavigation(): void {
  if (typeof window === 'undefined') return

  const requestId = ++progressRequestId
  if (progressTimer) {
    window.clearTimeout(progressTimer)
  }

  progressTimer = window.setTimeout(() => {
    progressTimer = undefined
    void loadProgressBar().then((progress) => {
      if (requestId !== progressRequestId) {
        return
      }

      progressVisible = true
      progress.start()
    })
  }, PROGRESS_DELAY_MS)
}

function finishProgressNavigation(): void {
  if (typeof window === 'undefined') return

  progressRequestId++
  if (progressTimer) {
    window.clearTimeout(progressTimer)
    progressTimer = undefined
  }

  if (progressVisible && progressModulePromise) {
    progressVisible = false
    void progressModulePromise.then((progress) => {
      progress.done()
    })
  }
}

const manageMeta = (
  title: string,
  permissions: readonly string[],
  accountContentMode: 'wide' | 'takeover' = 'wide'
) => ({
  title,
  accountArea: 'manage' as const,
  accountContentMode,
  permissions
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
        meta: { title: '登录', guestOnly: true }
      },
      {
        path: 'register',
        name: 'Register',
        component: () => import('@/views/auth/Register.vue'),
        meta: { title: '注册', guestOnly: true }
      },
      {
        path: 'recover',
        name: 'Recover',
        component: () => import('@/views/auth/Recover.vue'),
        meta: { title: '恢复访问', guestOnly: true }
      }
    ]
  },
  // --- 统一账户中心 ---
  {
    path: '/user',
    component: () => import('@/layouts/AccountLayout.vue'),
    meta: { requiresAuth: true, roles: ['guest', 'admin'], accountArea: 'self', accountContentMode: 'standard' },
    children: [
      { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', redirect: { name: 'UserIdentityOverview' }, component: () => import('@/views/user/Profile.vue'), meta: { title: '身份中心', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: { title: '可归因评论记录', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: { title: '我的消息', accountArea: 'self', accountContentMode: 'takeover' } },
      { path: 'identity', name: 'UserIdentityOverview', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '身份总览', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/passkeys', name: 'UserIdentityPasskeys', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '通行密钥', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/recovery-key', name: 'UserIdentityRecoveryKey', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: 'Recovery Key', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/anonymous', name: 'UserIdentityAnonymous', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '匿名身份', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/public-profile', name: 'UserIdentityPublicProfile', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '公开资料', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/sessions', name: 'UserIdentitySessions', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '设备会话', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/mfa', name: 'UserIdentityMfa', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '二次验证', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'identity/comment-records', name: 'UserIdentityCommentRecords', component: () => import('@/views/user/IdentityCenter.vue'), meta: { title: '可归因评论记录', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'manage', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: manageMeta('仪表盘', ['admin.manage']) },
      { path: 'manage/article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta('写文章', ['article.write']) },
      { path: 'manage/article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: manageMeta('编辑文章', ['article.write']) },
      { path: 'manage/article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: manageMeta('文章管理', ['article.write']) },
      { path: 'manage/article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: manageMeta('回收站', ['article.write']) },
      {
        path: 'manage/security',
        name: 'ManageSecuritySystem',
        component: () => import('@/views/admin/security/SecurityLayout.vue'),
        meta: manageMeta('安全系统', ['system.config']),
        children: [
          { path: '', name: 'ManageSecurityDashboard', component: () => import('@/views/admin/security/SecurityDashboard.vue'), meta: manageMeta('安全系统', ['system.config']) },
          { path: 'risk-control', name: 'ManageSecurityRiskControl', component: () => import('@/views/admin/security/SecurityRiskControl.vue'), meta: manageMeta('RiskControl 控制面', ['system.config']) },
          { path: 'simulator', name: 'ManageSecuritySimulator', component: () => import('@/views/admin/security/SecuritySimulator.vue'), meta: manageMeta('RiskControl 模拟器', ['system.config']) },
          { path: 'challenges', name: 'ManageSecurityChallenges', component: () => import('@/views/admin/security/SecurityChallenges.vue'), meta: manageMeta('挑战状态', ['system.config']) },
          { path: 'policies', name: 'ManageSecurityPolicies', component: () => import('@/views/admin/security/SecurityPolicies.vue'), meta: manageMeta('策略版本', ['system.config']) },
          { path: 'events', name: 'ManageSecurityEvents', component: () => import('@/views/admin/security/SecurityEvents.vue'), meta: manageMeta('风险事件', ['system.config']) },
          { path: 'captcha', name: 'ManageSecurityCaptcha', component: () => import('@/views/admin/security/SecurityCaptcha.vue'), meta: manageMeta('Captcha 挑战', ['system.config']) },
          { path: 'pospace', name: 'ManageSecurityPoSpace', component: () => import('@/views/admin/security/SecurityPoSpace.vue'), meta: manageMeta('PoSpace 挑战', ['system.config']) },
          { path: 'perception-v2', name: 'ManageSecurityPerceptionV2', component: () => import('@/views/admin/security/SecurityPerceptionV2.vue'), meta: manageMeta('Perception V2', ['system.config']) },
          { path: 'crawler', name: 'ManageSecurityCrawler', component: () => import('@/views/admin/security/SecurityCrawler.vue'), meta: manageMeta('反爬虫系统', ['system.config']) },
          { path: 'pow', name: 'ManageSecurityPow', component: () => import('@/views/admin/security/SecurityPow.vue'), meta: manageMeta('PoW 系统', ['system.config']) }
        ]
      },
      {
        path: 'manage/moderation',
        name: 'ManageModerationSystem',
        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
        meta: manageMeta('审核系统', ['comment.moderate']),
        children: [
          { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: manageMeta('审核系统', ['comment.moderate']) },
          { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: manageMeta('评论审核', ['comment.moderate']) },
          { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: manageMeta('词库管理', ['comment.moderate']) },
          { path: 'anonymous-policy', name: 'ManageAnonymousCommentPolicy', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名评论策略', ['anonymous.comment.configure']) },
          { path: 'anonymous-risk', name: 'ManageAnonymousRisk', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名风险', ['comment.moderate']) },
          { path: 'anonymous-credentials', name: 'ManageAnonymousCredentials', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('匿名凭证', ['anonymous.credential.revoke']) },
          { path: 'nullifiers', name: 'ManageAnonymousNullifiers', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('Nullifier 治理', ['anonymous.nullifier.block']) },
          { path: 'zk-anonymous', name: 'ManageZkAnonymousStatus', component: () => import('@/views/admin/moderation/AnonymousGovernancePage.vue'), meta: manageMeta('ZK 匿名状态', ['anonymous.comment.configure']) },
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
      { path: 'manage/ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: manageMeta('运维健康', ['system.config']) },
      { path: 'manage/cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: manageMeta('缓存诊断', ['system.config']) },
      { path: 'manage/integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: manageMeta('数据巡检', ['system.config']) },
      { path: 'manage/settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: manageMeta('系统设置', ['system.config']) },
      { path: 'manage/users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: manageMeta('用户管理', ['admin.manage']) }
    ]
  },
  // --- 错误页 ---
  { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { title: '无权访问' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { title: '页面不存在' } }
]

type RouterFactoryOptions = Readonly<{
  history?: RouterHistory
  ssr?: boolean
}>

function isManageAccountRoute(route: RouteLocationNormalized): boolean {
  return route.path.startsWith('/user/manage')
    || route.matched.some((record) => record.meta.accountArea === 'manage')
}

function readRouteRequiredPermissions(route: RouteLocationNormalized): string[] {
  const value = route.meta.permissions
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function applyRouteGuards(router: Router, options: RouterFactoryOptions = {}): void {
  router.beforeEach(async (to) => {
    const sessionBootstrap = useSessionBootstrap()
    const { userStore, siteStore } = sessionBootstrap
    const adminStore = useAdminStore()
    const manageRoute = isManageAccountRoute(to)
    const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null
    const shouldDeferPublicBootstrap =
      !options.ssr
      && isPublicSeoRouteName(to.name)
      && hasServerAotShell(appRoot)

    if (!options.ssr && !shouldDeferPublicBootstrap) {
      scheduleProgressForSlowNavigation()
    }

    if (!options.ssr && !shouldDeferPublicBootstrap && sessionBootstrap.needsBootstrap()) {
      await sessionBootstrap.ensureBootstrap()
    }

    if (!shouldDeferPublicBootstrap || siteStore.isLoaded) {
      sessionBootstrap.syncDocumentTitle(to)
    }

    if (!options.ssr && (manageRoute || Boolean(to.meta.roles))) {
      await sessionBootstrap.ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })
    }

    const { isLoggedIn } = userStore

    if (to.meta.guestOnly && isLoggedIn) {
      return adminStore.canManage ? '/user/manage' : '/user/identity'
    }

    if (to.meta.requiresAuth) {
      if (!isLoggedIn && !adminStore.canManage) {
        return { path: '/login', query: { redirect: to.fullPath } }
      }

      if (manageRoute) {
        const requiredPermissions = readRouteRequiredPermissions(to)
        const canAccessManageRoute = adminStore.canManage
          && requiredPermissions.every((permission) => adminStore.hasPermission(permission))
        if (!canAccessManageRoute) {
          return '/403'
        }
      }
    }

    if (to.path === '/user') {
      return adminStore.canManage ? '/user/manage' : '/user/identity'
    }

    return true
  })

  if (options.ssr) {
    return
  }

  router.afterEach(() => {
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

const router = typeof window === 'undefined'
  ? createAppRouter({ ssr: true })
  : createAppRouter()

export default router
