import { createCommentVNode, h } from 'vue'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
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
import type { ArticleResponsibilityPublicView } from '@/view-contracts/articleResponsibility'
import type { ArticleListViewContract } from '@/view-contracts/articleList'
import type { FilterPageViewContract } from '@/view-contracts/filterView'
import { createHomeEditorialPageState } from '@/view-contracts/homeSpotlight'

export function createPublicHomePageAssembly(input: {
  view: ArticleListViewContract
  featuredArticles: readonly FeaturedArticleItem[]
  hotArticles: readonly PopularArticleSummaryResponse[]
  showAside?: boolean
}): PublicAotPageAssembly {
  const editorialState = createHomeEditorialPageState({
    view: input.view,
    featuredArticles: input.featuredArticles,
    hotArticles: input.hotArticles
  })
  const editorialComposition = editorialState.composition
  // Public AOT, hydration, and the SPA route all use the same editorial
  // selector. The right-side aside remains absent so no independent hot list
  // can reintroduce duplicate article IDs.
  const showAside = false

  return {
    component: PublicHomePageContent,
    props: {
      view: editorialState.view,
      loading: false,
      isError: false,
      spaNavigation: false,
      showAside,
      hasRecommendations: editorialState.hasRecommendations,
      showArticleCta: false
    },
    slots: {
      featured: () => {
        const lead = editorialComposition.leadArticle
          ? h(FeaturedArticlesSection, {
              article: editorialComposition.leadArticle,
              loading: false
            })
          : null
        const secondary = editorialComposition.secondaryArticles.length > 0
          ? h(HomeTextFirstRecommendations, {
              articles: editorialComposition.secondaryArticles
            })
          : null

        if (!lead && !secondary) {
          return createCommentVNode('v-if', true)
        }

        return [lead, secondary]
      },
      aside: () => createCommentVNode('v-if', true)
    }
  }
}

export function createPublicArticleDetailPageAssembly(input: {
  detailView: ArticleDetailPageViewContract
  articleId: number
  authorName: string
  responsibilityAuthors: readonly Readonly<{ name: string; profileUrl: string | null }>[]
  responsibilityManifest: ArticleResponsibilityPublicView | null
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
      responsibilityAuthors: input.responsibilityAuthors,
      responsibilityManifest: input.responsibilityManifest,
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
