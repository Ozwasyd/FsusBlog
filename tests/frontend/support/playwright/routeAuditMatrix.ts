import type { PlaywrightAuditFixtures } from './routeAuditFixtures'

export type RouteCheck = {
  name: string
  path: string
  expectedUrl: string
}

export function buildAnonymousRoutes(fixtures: PlaywrightAuditFixtures): RouteCheck[] {
  const articlePath = `/article/${fixtures.articleId}`
  const categoryPath = `/category/${fixtures.categoryId}`
  const tagPath = `/tag/${fixtures.tagId}`
  const searchPath = `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`

  return [
    { name: 'home', path: '/', expectedUrl: '/' },
    { name: 'article', path: articlePath, expectedUrl: articlePath },
    { name: 'archive', path: '/archive', expectedUrl: '/archive' },
    { name: 'about', path: '/about', expectedUrl: '/about' },
    { name: 'privacy', path: '/privacy', expectedUrl: '/privacy' },
    { name: 'guidelines', path: '/guidelines', expectedUrl: '/guidelines' },
    { name: 'copyright', path: '/copyright', expectedUrl: '/copyright' },
    { name: 'category', path: categoryPath, expectedUrl: categoryPath },
    { name: 'tag', path: tagPath, expectedUrl: tagPath },
    { name: 'search', path: searchPath, expectedUrl: searchPath },
    { name: 'login', path: '/login', expectedUrl: '/login' },
    { name: 'register', path: '/register', expectedUrl: '/register' },
    { name: 'forbidden', path: '/403', expectedUrl: '/403' },
    { name: 'not-found', path: '/route-that-does-not-exist', expectedUrl: '/route-that-does-not-exist' },
    { name: 'anon-user-redirect', path: '/user/profile', expectedUrl: '/login?redirect=/user/profile' },
    { name: 'anon-manage-redirect', path: '/user/manage', expectedUrl: '/login?redirect=/user/manage' }
  ]
}

export function buildUserRoutes(): RouteCheck[] {
  return [
    { name: 'user-profile', path: '/user/profile', expectedUrl: '/user/profile' },
    { name: 'user-comments', path: '/user/comments', expectedUrl: '/user/comments' },
    { name: 'user-messagebox', path: '/user/messagebox', expectedUrl: '/user/messagebox' },
    { name: 'user-login-redirect', path: '/login', expectedUrl: '/user/profile' },
    { name: 'user-manage-block', path: '/user/manage', expectedUrl: '/user/profile' }
  ]
}

export function buildAdminRoutes(fixtures: PlaywrightAuditFixtures): RouteCheck[] {
  const editPath = `/user/manage/article/edit/${fixtures.articleId}`

  return [
    { name: 'manage-dashboard', path: '/user/manage', expectedUrl: '/user/manage' },
    { name: 'manage-write', path: '/user/manage/article/write', expectedUrl: '/user/manage/article/write' },
    { name: 'manage-edit', path: editPath, expectedUrl: editPath },
    { name: 'manage-list', path: '/user/manage/article/list', expectedUrl: '/user/manage/article/list' },
    { name: 'manage-trash', path: '/user/manage/article/trash', expectedUrl: '/user/manage/article/trash' },
    { name: 'manage-category', path: '/user/manage/category', expectedUrl: '/user/manage/category' },
    { name: 'manage-tag', path: '/user/manage/tag', expectedUrl: '/user/manage/tag' },
    { name: 'manage-settings', path: '/user/manage/settings', expectedUrl: '/user/manage/settings' },
    { name: 'manage-users', path: '/user/manage/users', expectedUrl: '/user/manage/users' },
    { name: 'manage-message', path: '/user/manage/messages', expectedUrl: '/user/manage/messages' },
    { name: 'manage-user-profile', path: '/user/profile', expectedUrl: '/user/profile' },
    { name: 'manage-login-redirect', path: '/login', expectedUrl: '/user/manage' }
  ]
}
