import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import NProgress from 'nprogress'
import 'nprogress/nprogress.css'
import { useUserStore } from '@/store/user'
import { useSiteStore } from '@/store/site' 
import { useNotification } from '@/composables/useNotification'

NProgress.configure({ showSpinner: false })

const routes: RouteRecordRaw[] = [
  // --- 前台公共路由 ---
  {
    path: '/',
    component: () => import('@/layouts/BlogLayout.vue'),
    children: [
      { path: '', name: 'Home', component: () => import('@/views/Home.vue'), meta: { title: '首页' } },
      { path: 'article/:id', name: 'ArticleDetail', component: () => import('@/views/ArticleDetail.vue'), meta: { title: '文章详情' } },
      { path: 'archive', name: 'Archive', component: () => import('@/views/Archive.vue'), meta: { title: '归档' } },
      { path: 'about', name: 'About', component: () => import('@/views/About.vue'), meta: { title: '关于我' } },
      { path: '/category/:id', name: 'Category', component: () => import('@/views/FilterView.vue'), meta: { requiresAuth: false }},
      { path: '/tag/:id', name: 'Tag',component: () => import('@/views/FilterView.vue'), meta: { requiresAuth: false }},
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
  // --- 后台管理路由 (仅限 admin) ---
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    meta: { requiresAuth: true, roles: ['admin'] }, 
    children: [
      { path: '', name: 'AdminDashboard', component: () => import('@/views/admin/Dashboard.vue'), meta: { title: '仪表盘' } },
      { path: 'article/write', name: 'WriteArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '写文章' } },
      { path: 'article/edit/:id', name: 'EditArticle', component: () => import('@/views/admin/article/Write.vue'), meta: { title: '编辑文章' } },
      { path: 'article/list', name: 'ArticleList', component: () => import('@/views/admin/article/List.vue'), meta: { title: '文章管理' } },
      { path: 'article/trash', name: 'Trash', component: () => import('@/views/admin/article/Trash.vue'), meta: { title: '回收站' } },
      { path: 'category', name: 'CategoryManage', component: () => import('@/views/admin/Category.vue'), meta: { title: '分类管理' } },
      { path: 'tag', name: 'TagManage', component: () => import('@/views/admin/Tag.vue'), meta: { title: '标签管理' } },
      { path: 'settings', name: 'SystemSettings', component: () => import('@/views/admin/Settings.vue'), meta: { title: '系统设置' } },
      { path: 'users', name: 'UserManager', component: () => import('@/views/admin/UserManage.vue'), meta: { title: '用户管理' } },
      { path: 'message', name: 'MessageManager', component: () => import('@/views/admin/MessageManage.vue'), meta: { title: '消息管理' } }
    ]
  },
  // --- 普通用户中心 (仅限 guest) ---
  {
    path: '/user',
    component: () => import('@/layouts/UserLayout.vue'),
    meta: { requiresAuth: true, roles: ['guest'] },
    children: [
      { path: 'profile', name: 'UserProfile', component: () => import('@/views/user/Profile.vue'), meta: { title: '个人中心' } },
      { path: 'comments', name: 'UserComments', component: () => import('@/views/user/Comments.vue'), meta: { title: '我的评论' } },
      { path: 'messagebox', name: 'UserMessage', component: () => import('@/views/user/Messages.vue'), meta: { title: '我的消息' } }
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
  NProgress.start()
  
  const userStore = useUserStore()
  const siteStore = useSiteStore()
  const { initNotification } = useNotification()

  // 1. 核心数据静默加载
  // 逻辑自洽：先获取用户信息，确定身份后才能进行后续的权限判断和通知初始化
  if (!userStore.isAuthChecked || siteStore.siteInfo.title === 'Loading...') {
    await Promise.all([
      userStore.fetchUserInfo(),
      siteStore.fetchSiteInfo()
    ])
  }

  // 2. --- SignalR 激活逻辑 ---
  // 性能最大化：无论登录还是游客，都尝试启动通知服务。
  // initNotification 内部会判断 currentMode，如果模式未变则不会重新连接。
  // 修正 TS 错误：传入 boolean 类型的登录状态。
  initNotification(userStore.isLoggedIn);

  // 3. 动态设置页面标题
  const baseTitle = siteStore.siteInfo.title
  if (to.meta.title) {
    document.title = `${to.meta.title} - ${baseTitle}`
  } else {
    document.title = baseTitle
  }

  const { isLoggedIn, isAdmin, userInfo } = userStore
  const userRole = userInfo?.role || ''

  // 4. guestOnly 拦截 (已登录用户禁止访问登录/注册页)
  if (to.meta.guestOnly && isLoggedIn) {
    return isAdmin ? '/admin' : '/user/profile'
  }

  // 5. 权限与角色分流逻辑
  if (to.meta.requiresAuth) {
    if (!isLoggedIn) {
      return { path: '/login', query: { redirect: to.fullPath } }
    }

    if (to.meta.roles) {
      const allowedRoles = to.meta.roles as string[]
      
      if (!allowedRoles.includes(userRole)) {
        // 如果是普通用户试图进入管理端，自动重定向到个人中心
        if (userRole === 'guest' && to.path.startsWith('/admin')) {
          return '/user/profile' 
        }
        return '/403'
      }
    }
  }

  return true
})

router.afterEach(() => { NProgress.done() })

export default router