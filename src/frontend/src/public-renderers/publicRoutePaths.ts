import { PUBLIC_ROUTE_IDENTITY_TOKENS } from '@/public-renderers/generated/publicPageManifest'
import { buildPublicFixedPath as buildSharedPublicFixedPath, PUBLIC_FIXED_PATHS, type PublicFixedPageKind } from '@/public-renderers/publicFixedPageSemantics'

export { PUBLIC_FIXED_PATHS }

export function buildPublicFixedPath(kind: PublicFixedPageKind): string {
  return buildSharedPublicFixedPath(kind)
}

function trimLeadingSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value
}

function toChildRoutePath(path: string): string {
  return path === '/' ? '' : trimLeadingSlash(path)
}

function toNestedRoutePath(path: string, basePath: string): string {
  return path.startsWith(basePath)
    ? trimLeadingSlash(path.slice(basePath.length))
    : trimLeadingSlash(path)
}

export const PUBLIC_ROUTE_PATHS = Object.freeze({
  ...PUBLIC_FIXED_PATHS,
  search: PUBLIC_ROUTE_IDENTITY_TOKENS.searchPath
} as const)

export const ACCOUNT_ROUTE_PATHS = Object.freeze({
  profile: PUBLIC_ROUTE_IDENTITY_TOKENS.accountPath,
  profileChild: toNestedRoutePath(PUBLIC_ROUTE_IDENTITY_TOKENS.accountPath, '/user')
} as const)

export const PUBLIC_ROUTE_PATH_PATTERNS = Object.freeze({
  home: toChildRoutePath(PUBLIC_FIXED_PATHS.home),
  articleDetail: `${trimLeadingSlash(PUBLIC_ROUTE_IDENTITY_TOKENS.articlePathPrefix)}:id`,
  archive: toChildRoutePath(PUBLIC_FIXED_PATHS.archive),
  about: toChildRoutePath(PUBLIC_FIXED_PATHS.about),
  category: `${trimLeadingSlash(PUBLIC_ROUTE_IDENTITY_TOKENS.categoryPathPrefix)}:id(\\d+)`,
  tagById: `${trimLeadingSlash(PUBLIC_ROUTE_IDENTITY_TOKENS.tagPathPrefix)}:id(\\d+)`,
  tag: `${trimLeadingSlash(PUBLIC_ROUTE_IDENTITY_TOKENS.tagPathPrefix)}:id`,
  search: toChildRoutePath(PUBLIC_ROUTE_PATHS.search)
} as const)
