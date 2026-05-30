import { createCommentVNode, h } from 'vue'
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

export function createPublicHomePageAssembly(input: {
  siteTitleText: string
  siteDescriptionText: string
  view: ArticleListViewContract
}): PublicAotPageAssembly {
  return {
    component: PublicHomePageContent,
    props: {
      siteTitleText: input.siteTitleText,
      siteDescriptionText: input.siteDescriptionText,
      view: input.view,
      loading: false,
      isError: false,
      spaNavigation: false
    },
    slots: {
      featured: () => createCommentVNode('v-if', true)
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
