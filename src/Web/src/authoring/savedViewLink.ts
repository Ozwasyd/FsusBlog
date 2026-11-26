import type { LocationQuery } from 'vue-router'

export const savedViewRoute = 'admin-articles'

export type SavedViewLink = { id: string } | 'invalid' | undefined

export function savedViewLink(query: LocationQuery): SavedViewLink {
  if (!Object.hasOwn(query, 'view') && !Object.hasOwn(query, 'viewSchema')) return
  const id = query.view
  if (typeof id !== 'string' || query.viewSchema !== '1' || Object.keys(query).length !== 2 ||
      id === '00000000-0000-0000-0000-000000000000' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return 'invalid'
  return { id: id.toLowerCase() }
}
