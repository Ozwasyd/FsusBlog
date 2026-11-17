export const adminWorkspacePages = [
  { section: 'overview', name: 'admin-overview', path: '/admin', label: 'admin.workspace.overview' },
  { section: 'articles', name: 'admin-articles', path: '/admin/articles', label: 'admin.workspace.articles' },
  { section: 'interaction', name: 'admin-interaction', path: '/admin/interaction', label: 'admin.workspace.interaction' },
  { section: 'site', name: 'admin-site', path: '/admin/site', label: 'admin.workspace.site' },
  { section: 'system', name: 'admin-system', path: '/admin/system', label: 'admin.workspace.system' },
  { section: 'identity', name: 'admin-identity', path: '/admin/identity', label: 'admin.workspace.account' },
] as const

export type AdminWorkspaceSection = typeof adminWorkspacePages[number]['section']
