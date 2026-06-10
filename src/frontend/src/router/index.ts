import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw
} from 'vue-router'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'
import { isPublicSeoRouteName } from '@/public-renderers/publicPageModel'
import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import { PUBLIC_BLOG_CHILD_ROUTES } from '@/public-renderers/publicRouteRegistry'

type ProgressModule = typeof import('nprogress')
let progressModulePromise: Promise<ProgressModule> | null = null

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

const routes: RouteRecordRaw[] = [
  // --- 前台公共路由 ---
  {
    path: '/',
    component: () => import('@/layouts/BlogLayout.vue'),
    children: [...PUBLIC_BLOG_CHILD_ROUTES]
  },
  // --- 认证路由 ---
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/auth/Login.vue'),
    meta: { title: '登录', guestOnly: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/auth/Register.vue'),
    meta: { title: '注册', guestOnly: true }
  },
  // --- 统一账户中心 ---
  {
    path: '/user',
    component: () => import('@/layouts/AccountLayout.vue'),
    meta: { requiresAuth: true, roles: ['guest', 'admin'], accountArea: 'self', accountContentMode: 'standard' },
    children: [
      { path: ACCOUNT_ROUTE_PATHS.profileChild, name: 'UserProfile', component: () => import('@/views/user/Profile.vue'), meta: { title: '个人中心', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: { title: '我的评论', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: { title: '我的消息', accountArea: 'self', accountContentMode: 'takeover' } },
      { path: 'manage', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: { title: '仪表盘', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '写文章', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '编辑文章', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: { title: '文章管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: { title: '回收站', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      {
        path: 'manage/moderation',
        name: 'ManageModerationSystem',
        component: () => import('@/views/admin/moderation/ModerationLayout.vue'),
        meta: { title: '审核系统', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' },
        children: [
          { path: '', name: 'ManageModerationDashboard', component: () => import('@/views/admin/moderation/ModerationDashboard.vue'), meta: { title: '审核系统', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'comments', name: 'ManageModerationComments', component: () => import('@/views/admin/moderation/ModerationComments.vue'), meta: { title: '评论审核', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'dictionaries', name: 'ManageModerationDictionaries', component: () => import('@/views/admin/moderation/ModerationDictionaries.vue'), meta: { title: '词库管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'policies', name: 'ManageModerationPolicies', component: () => import('@/views/admin/moderation/ModerationPolicies.vue'), meta: { title: '地区策略', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'replay', name: 'ManageModerationReplay', component: () => import('@/views/admin/moderation/ModerationReplay.vue'), meta: { title: '策略回放', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'model', name: 'ManageModerationModel', component: () => import('@/views/admin/moderation/ModerationModel.vue'), meta: { title: '审核模型', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
          { path: 'audit', name: 'ManageModerationAudit', component: () => import('@/views/admin/moderation/ModerationAudit.vue'), meta: { title: '审核审计', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } }
        ]
      },
      { path: 'manage/comments', name: 'ManageCommentModeration', redirect: { name: 'ManageModerationComments' }, meta: { title: '评论审核', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/messages', name: 'ManageMessages', component: () => import('@/views/admin/MessageCenter.vue'), meta: { title: '站内信中心', roles: ['admin'], accountArea: 'manage', accountContentMode: 'takeover' } },
      { path: 'manage/category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: { title: '分类管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: { title: '标签管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/assets', name: 'ManageAssets', component: () => import('@/views/admin/Assets.vue'), meta: { title: '资产库', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/content-tools', name: 'ManageContentTools', component: () => import('@/views/admin/ContentTools.vue'), meta: { title: '备份与迁移', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/audit', name: 'ManageAuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: { title: '审计日志', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/ops', name: 'ManageOpsHealth', component: () => import('@/views/admin/OpsHealth.vue'), meta: { title: '运维健康', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/cache', name: 'ManageCacheDiagnostics', component: () => import('@/views/admin/CacheDiagnostics.vue'), meta: { title: '缓存诊断', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/integrity', name: 'ManageIntegrity', component: () => import('@/views/admin/Integrity.vue'), meta: { title: '数据巡检', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: { title: '系统设置', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: { title: '用户管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } }
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function applyRouteGuards(router: Router, options: RouterFactoryOptions = {}): void {
  router.beforeEach(async (to) => {
    if (!options.ssr) {
      void loadProgressBar().then((progress) => {
        progress.start()
      })
    }

    const sessionBootstrap = useSessionBootstrap()
    const { userStore, siteStore } = sessionBootstrap
    const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null
    const shouldDeferPublicBootstrap =
      !options.ssr
      && isPublicSeoRouteName(to.name)
      && hasServerAotShell(appRoot)

    if (!options.ssr && !shouldDeferPublicBootstrap && sessionBootstrap.needsBootstrap()) {
      await sessionBootstrap.ensureBootstrap()
    }

    if (!shouldDeferPublicBootstrap || siteStore.isLoaded) {
      sessionBootstrap.syncDocumentTitle(to)
    }

    if (!options.ssr && (to.path.startsWith('/user/manage') || Boolean(to.meta.roles))) {
      await userStore.fetchUserInfo(true)
    }

    const { isLoggedIn, isAdmin, userInfo } = userStore
    const userRole = userInfo?.role || ''

    if (to.meta.guestOnly && isLoggedIn) {
      return isAdmin ? '/user/manage' : ACCOUNT_ROUTE_PATHS.profile
    }

    if (to.meta.requiresAuth) {
      if (!isLoggedIn) {
        return { path: '/login', query: { redirect: to.fullPath } }
      }

      if (to.meta.roles) {
        const allowedRoles = to.meta.roles as string[]

        if (!allowedRoles.includes(userRole)) {
          if (userRole === 'guest' && to.path.startsWith('/user/manage')) {
            return ACCOUNT_ROUTE_PATHS.profile
          }
          return '/403'
        }
      }
    }

    if (to.path === '/user') {
      return isAdmin ? '/user/manage' : ACCOUNT_ROUTE_PATHS.profile
    }

    return true
  })

  if (options.ssr) {
    return
  }

  router.afterEach(() => {
    void loadProgressBar().then((progress) => {
      progress.done()
    })
  })
}

export function createAppRouter(options: RouterFactoryOptions = {}): Router {
  const history = options.history ?? (
    options.ssr
      ? createMemoryHistory(import.meta.env.BASE_URL)
      : createWebHistory(import.meta.env.BASE_URL)
  )

  const router = createRouter({
    history,
    routes,
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
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
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
