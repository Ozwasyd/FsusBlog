export const adminWorkspacePages = [
  { section: 'site', name: 'admin-site', path: '/admin/site', label: 'admin.workspace.site' },
  { section: 'articles', name: 'admin-articles', path: '/admin/articles', label: 'admin.articles.articles' },
  { section: 'interaction', name: 'admin-interaction', path: '/admin/interaction', label: 'admin.workspace.interaction' },
  { section: 'identity', name: 'admin-identity', path: '/admin/identity', label: 'nav.security' },
] as const

export type AdminWorkspaceSection = typeof adminWorkspacePages[number]['section']
