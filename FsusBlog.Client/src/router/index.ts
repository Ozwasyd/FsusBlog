import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'

type ProgressModule = typeof import('nprogress')
let progressModulePromise: Promise<ProgressModule['default']> | null = null

function loadProgressBar(): Promise<ProgressModule['default']> {
  if (!progressModulePromise) {
    progressModulePromise = Promise.all([
      import('nprogress'),
      import('nprogress/nprogress.css')
    ]).then(([module]) => {
      module.default.configure({ showSpinner: false })
      return module.default
    })
  }

  return progressModulePromise
}

const routes: RouteRecordRaw[] = [
  // --- 前台公共路由 ---
  {
    path: '/',
    component: () => import('@/layouts/BlogLayout.vue'),
    children: [
      { path: '', name: 'Home', component: () => import('@/views/Home.vue'), meta: { title: '首页', seoShell: true } },
      { path: 'article/:id', name: 'ArticleDetail', component: () => import('@/views/ArticleDetail.vue'), meta: { title: '文章详情', seoShell: true } },
      { path: 'archive', name: 'Archive', component: () => import('@/views/Archive.vue'), meta: { title: '归档', seoShell: true } },
      { path: 'about', name: 'About', component: () => import('@/views/About.vue'), meta: { title: '关于我', seoShell: true } },
      { path: '/category/:id', name: 'Category', component: () => import('@/views/FilterView.vue'), meta: { requiresAuth: false, seoShell: true }},
      { path: '/tag/:id', name: 'Tag',component: () => import('@/views/FilterView.vue'), meta: { requiresAuth: false, seoShell: true }},
      { path: '/search', name: 'Search', component: () => import('@/views/FilterView.vue'), meta: { title: '搜索结果', requiresAuth: false }}
    ]
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
      { path: 'profile', name: 'UserProfile', component: () => import('@/views/user/Profile.vue'), meta: { title: '个人中心', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: { title: '我的评论', accountArea: 'self', accountContentMode: 'standard' } },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: { title: '我的消息', accountArea: 'self', accountContentMode: 'takeover' } },
      { path: 'manage', name: 'ManageDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: { title: '仪表盘', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/write', name: 'ManageWriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '写文章', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/edit/:id', name: 'ManageEditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '编辑文章', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/list', name: 'ManageArticleList', component: () => import('@/views/admin/article/List.vue'), meta: { title: '文章管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/article/trash', name: 'ManageArticleTrash', component: () => import('@/views/admin/article/Trash.vue'), meta: { title: '回收站', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/category', name: 'ManageCategory', component: () => import('@/views/admin/Category.vue'), meta: { title: '分类管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/tag', name: 'ManageTag', component: () => import('@/views/admin/Tag.vue'), meta: { title: '标签管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/settings', name: 'ManageSettings', component: () => import('@/views/admin/Settings.vue'), meta: { title: '系统设置', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } },
      { path: 'manage/users', name: 'ManageUsers', component: () => import('@/views/admin/UserManage.vue'), meta: { title: '用户管理', roles: ['admin'], accountArea: 'manage', accountContentMode: 'wide' } }
    ]
  },
  // --- 错误页 ---
  { path: '/403', name: 'Forbidden', component: () => import('@/views/error/403.vue'), meta: { title: '无权访问' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/views/error/404.vue'), meta: { title: '页面不存在' } }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

// ================= 路由守卫 =================
router.beforeEach(async (to) => {
  const progress = await loadProgressBar()
  progress.start()
  
  const sessionBootstrap = useSessionBootstrap()
  const { userStore, siteStore, appShellStore } = sessionBootstrap
  const appRoot = typeof document !== 'undefined' ? document.getElementById('app') : null
  const shouldDeferPublicBootstrap =
    Boolean(to.meta.seoShell) && hasServerAotShell(appRoot)

  // 1. 核心数据静默加载
  // 逻辑自洽：先获取用户信息，确定身份后才能进行后续的权限判断
  if (!shouldDeferPublicBootstrap && sessionBootstrap.needsBootstrap()) {
    await sessionBootstrap.ensureBootstrap()
  }

  // 2. 动态设置页面标题
  // 算法最优：优先处理标题，提升用户感知速度
  if (!shouldDeferPublicBootstrap || siteStore.isLoaded) {
    sessionBootstrap.syncDocumentTitle(to)
  }

  const { isLoggedIn, isAdmin, userInfo } = userStore
  const userRole = userInfo?.role || ''

  // 3. guestOnly 拦截 (已登录用户禁止访问登录/注册页)
  if (to.meta.guestOnly && isLoggedIn) {
    return isAdmin ? '/user/manage' : '/user/profile'
  }

  // 4. 权限与角色分流逻辑
  if (to.meta.requiresAuth) {
    if (!isLoggedIn) {
      // 安全性保障：重定向携带原始路径，确保登录后能准确回跳
      return { path: '/login', query: { redirect: to.fullPath } }
    }

    if (to.meta.roles) {
      const allowedRoles = to.meta.roles as string[]
      
      if (!allowedRoles.includes(userRole)) {
        if (userRole === 'guest' && to.path.startsWith('/user/manage')) {
          return '/user/profile' 
        }
        return '/403'
      }
    }
  }

  if (to.path === '/user') {
    return isAdmin ? '/user/manage' : '/user/profile'
  }

  return true
})

router.afterEach(() => {
  void loadProgressBar().then((progress) => {
    progress.done()
  })
})

export default router
