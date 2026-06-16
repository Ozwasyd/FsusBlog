import { createCommentVNode, h } from 'vue'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
import HomeHotArticlesAside from '@/components/home/HomeHotArticlesAside.vue'
import HomeTextFirstRecommendations from '@/components/home/HomeTextFirstRecommendations.vue'
import PublicAboutPageContent from '@/components/public/pages/PublicAboutPageContent.vue'
import PublicArchivePageContent from '@/components/public/pages/PublicArchivePageContent.vue'
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue'
import PublicFilterPageContent from '@/components/public/pages/PublicFilterPageContent.vue'
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import type { PublicAotPageAssembly } from '@/public-renderers/scaffold'
import type { AboutPageViewContract } from '@/view-contracts/aboutPage'
import type { ArchivePageViewContract } from '@/view-contracts/archive'
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'
import type { ArticleListViewContract } from '@/view-contracts/articleList'
import type { FilterPageViewContract } from '@/view-contracts/filterView'
import { selectHomeSpotlightCandidates } from '@/view-contracts/homeSpotlight'

export function createPublicHomePageAssembly(input: {
  siteTitleText: string
  siteDescriptionText: string
  view: ArticleListViewContract
  featuredArticles: readonly FeaturedArticleItem[]
  hotArticles: readonly PopularArticleSummaryResponse[]
  showAside?: boolean
}): PublicAotPageAssembly {
  const featuredArticles = [...input.featuredArticles]
  const hotArticles = [...input.hotArticles]
  const spotlightArticles = selectHomeSpotlightCandidates(featuredArticles)
  const showAside = input.showAside ?? (spotlightArticles.length > 0 && hotArticles.length > 0)

  return {
    component: PublicHomePageContent,
    props: {
      siteTitleText: input.siteTitleText,
      siteDescriptionText: input.siteDescriptionText,
      view: input.view,
      loading: false,
      isError: false,
      spaNavigation: false,
      showAside
    },
    slots: {
      featured: () => {
        if (spotlightArticles.length > 0) {
          return h(FeaturedArticlesSection, {
            articles: spotlightArticles,
            loading: false
          })
        }

        if (hotArticles.length > 0) {
          return h(HomeTextFirstRecommendations, {
            articles: hotArticles
          })
        }

        return createCommentVNode('v-if', true)
      },
      aside: () => {
        if (hotArticles.length > 0) {
          return h(HomeHotArticlesAside, {
            articles: hotArticles
          })
        }

        return createCommentVNode('v-if', true)
      }
    }
  }
}

export function createPublicArticleDetailPageAssembly(input: {
  detailView: ArticleDetailPageViewContract
  articleId: number
  authorName: string
  articleSummary: string
  canonicalUrl: string | null
  hasBodyContent: boolean
  bodyContent: string
  bodyHtml: string
}): PublicAotPageAssembly {
  return {
    component: PublicArticleDetailPageContent,
    props: {
      detailView: input.detailView,
      articleId: input.articleId,
      authorName: input.authorName,
      articleSummary: input.articleSummary,
      canonicalUrl: input.canonicalUrl,
      hasBodyContent: input.hasBodyContent,
      bodyContent: input.bodyContent,
      bodyHtml: input.bodyHtml,
      linkMode: 'anchor'
    }
  }
}

export function createPublicAboutPageAssembly(input: {
  view: AboutPageViewContract
  content: string
  bodyHtml: string
  baseUrl?: string | null
}): PublicAotPageAssembly {
  return {
    component: PublicAboutPageContent,
    props: {
      view: input.view,
      loading: false,
      error: false
    },
    slots: {
      body: () => h(MarkdownRenderer, {
        content: input.content,
        initialHtml: input.bodyHtml,
        mode: 'about',
        baseUrl: input.baseUrl ?? null
      })
    }
  }
}

export function createPublicArchivePageAssembly(input: {
  view: ArchivePageViewContract
}): PublicAotPageAssembly {
  return {
    component: PublicArchivePageContent,
    props: {
      view: input.view,
      loading: false,
      spaNavigation: false
    }
  }
}

export function createPublicFilterPageAssembly(input: {
  view: FilterPageViewContract
  invalidTarget: boolean
  showSearchSort: boolean
}): PublicAotPageAssembly {
  return {
    component: PublicFilterPageContent,
    props: {
      view: input.view,
      invalidTarget: input.invalidTarget,
      isLoadingState: false,
      spaNavigation: false,
      showSearchSort: input.showSearchSort
    }
  }
}
