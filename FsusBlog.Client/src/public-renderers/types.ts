import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import type { ArticleListViewContract } from '@/view-contracts/articleList';

export type PublicHydrationPageKind = 'Home' | 'ArticleDetail' | 'About' | 'Archive' | 'Filter';

export type PublicHomeHydrationPayload = Readonly<{
  pageKind: 'Home';
  routeKey: 'home';
  rendererVersion: string;
  title: string;
  siteTitle?: string | null;
  siteDescription?: string | null;
  baseUrl?: string | null;
  currentPage: number;
  pageSize: number;
  total: number;
  view: ArticleListViewContract;
}>;

export type PublicArticleDetailHydrationPayload = Readonly<{
  pageKind: 'ArticleDetail';
  routeKey: string;
  articleId: number | string;
  rendererVersion: string;
  title: string;
  authorName?: string | null;
  siteTitle?: string | null;
  siteDescription?: string | null;
  baseUrl?: string | null;
  detailView: ArticleDetailPageViewContract;
}>;

export type PublicPassiveHydrationPayload = Readonly<{
  pageKind: 'About';
  routeKey: string;
  rendererVersion: string;
  title: string;
  siteTitle?: string | null;
  siteDescription?: string | null;
  baseUrl?: string | null;
  about?: Readonly<{
    slug?: string | null;
    content?: string | null;
  }> | null;
}>;

export type PublicArchiveHydrationPayload = Readonly<{
  pageKind: 'Archive';
  routeKey: string;
  rendererVersion: string;
  title: string;
  siteTitle?: string | null;
  siteDescription?: string | null;
  baseUrl?: string | null;
  total?: number;
  articles?: ReadonlyArray<Readonly<{
    id: number;
    title: string;
    createTime?: string | null;
  }>>;
}>;

export type PublicFilterHydrationPayload = Readonly<{
  pageKind: 'Filter';
  routeKey: string;
  rendererVersion: string;
  title: string;
  siteTitle?: string | null;
  siteDescription?: string | null;
  baseUrl?: string | null;
  filter?: Readonly<{
    pageIndex?: number;
    pageSize?: number;
    total?: number;
    articles?: ReadonlyArray<Readonly<{
      id: number;
      title: string;
      summary?: string | null;
      createTime?: string | null;
    }>>;
  }> | null;
}>;

export type PublicHydrationPayload =
  | PublicHomeHydrationPayload
  | PublicArticleDetailHydrationPayload
  | PublicPassiveHydrationPayload
  | PublicArchiveHydrationPayload
  | PublicFilterHydrationPayload;

export type PublicRenderMetadata = Readonly<{
  rendererVersion: string;
  templateHash?: string | null;
  generatedAt?: string | null;
}>;
