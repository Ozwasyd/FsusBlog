import { AppErrorCode, createAppError } from '@/utils/appError'

export type PublicPageId = 'home' | 'article-detail' | 'filter' | 'archive' | 'about';

export type PublicPageDescriptor = Readonly<{
  id: PublicPageId;
  routeNames: readonly string[];
  canonicalSlug: string;
  seoEligible: boolean;
}>;

export const PUBLIC_PAGE_REGISTRY: readonly PublicPageDescriptor[] = Object.freeze([
  {
    id: 'home',
    routeNames: ['Home'],
    canonicalSlug: 'home',
    seoEligible: true
  },
  {
    id: 'article-detail',
    routeNames: ['ArticleDetail'],
    canonicalSlug: 'article',
    seoEligible: true
  },
  {
    id: 'filter',
    routeNames: ['Category', 'Tag'],
    canonicalSlug: 'filter',
    seoEligible: true
  },
  {
    id: 'archive',
    routeNames: ['Archive'],
    canonicalSlug: 'archive',
    seoEligible: true
  },
  // About is part of the server-first public SEO/AOT scope.
  {
    id: 'about',
    routeNames: ['About'],
    canonicalSlug: 'about',
    seoEligible: true
  }
]);

export function getPublicPageDescriptor(id: PublicPageId): PublicPageDescriptor {
  const descriptor = PUBLIC_PAGE_REGISTRY.find((page) => page.id === id);
  if (!descriptor) {
    throw createAppError(AppErrorCode.InvariantViolation, `Unknown public page id: ${id}`);
  }

  return descriptor;
}

export function isPublicSeoRouteName(routeName: string | null | undefined): boolean {
  if (!routeName) {
    return false;
  }

  return PUBLIC_PAGE_REGISTRY.some((page) => page.routeNames.includes(routeName));
}
