<template>
  <!-- 760px 将中文正文行长控制在舒适阅读范围，避免宽屏下单行文字过长。 -->
  <article
    class="public-article-detail mx-auto min-h-screen max-w-[760px] px-4 pt-6 pb-10 sm:px-12 sm:pt-10 sm:pb-12"
    data-readable-region
    data-fsus-surface="reading"
    itemscope
    itemtype="https://schema.org/BlogPosting"
  >
    <meta itemprop="headline" :content="detailView.header.title" />
    <meta itemprop="datePublished" :content="detailView.header.meta.published.isoTime" />
    <meta v-if="detailView.header.meta.modified" itemprop="dateModified" :content="detailView.header.meta.modified.isoTime" />
    <meta itemprop="articleSection" :content="detailView.header.meta.categoryName" />
    <meta itemprop="description" :content="articleSummary || detailView.header.title" />
    <meta
      v-for="author in effectiveResponsibilityAuthors"
      :key="author.name"
      itemprop="author"
      :content="author.name"
    />
    <meta itemprop="license" :content="detailView.rights.licenseType" />
    <meta name="fsus:rights-snapshot-id" :content="detailView.rights.snapshotId" />
    <meta name="fsus:rights-policy-hash" :content="detailView.rights.policyHash" />
    <meta name="fsus:rights-content-hash" :content="detailView.rights.contentCanonicalHash" />
    <meta name="fsus:rights-copy-policy" :content="detailView.rights.copyPolicy" />
    <meta
      v-if="detailView.rights.copyrightHolder"
      itemprop="copyrightHolder"
      :content="detailView.rights.copyrightHolder"
    />
    <meta
      v-if="detailView.rights.copyrightYear"
      itemprop="copyrightYear"
      :content="String(detailView.rights.copyrightYear)"
    />
    <meta
      v-if="canonicalUrl"
      itemprop="mainEntityOfPage"
      :content="canonicalUrl"
    />

    <div
      v-if="detailCover"
      class="mb-12 overflow-hidden rounded-[var(--fsusblog-radius-reading-media)] border border-[var(--fsusblog-panel-border)] shadow-none sm:mb-16"
      data-fsus-motion-surface="article-cover"
      data-content-cover="article-detail"
      :data-cover-safe-area="detailCover.safeArea"
    >
      <img
        :src="detailCover.url"
        :alt="t('article.content.coverAlt', { title: detailView.header.title })"
        class="aspect-video w-full object-cover object-center shadow-none"
        width="1200"
        height="675"
        sizes="(min-width: 1024px) 56rem, calc(100vw - 3rem)"
        loading="eager"
        decoding="async"
        fetchpriority="high"
      />
    </div>

    <header
      :class="themeTokens.articleDetail.header"
      data-fsus-motion-surface="article-title"
    >
      <ArticleDetailHeader :view="detailView.header" :link-mode="linkMode" />
      <ArticleResponsibilityDisclosure
        :article-id="safeArticleId"
        :fallback-author="authorName"
        :initial-authors="responsibilityAuthors"
        :initial-manifest="responsibilityManifest"
      />
      <slot name="header-actions" />
    </header>

    <section itemprop="articleBody" class="mt-8 sm:mt-10">
      <ArticleDetailBody>
        <ArticleReadingNotice
          :notice="detailView.body.notice"
        />
        <div
          v-if="!hasBodyContent"
          class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-10 py-16 text-center"
          :aria-label="messages.article.content.emptyAria"
        >
          <p class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
            {{ messages.article.content.empty }}
          </p>
        </div>
        <slot v-else name="body">
          <MarkdownRenderer
            itemprop="articleBody"
            :content="bodyContent"
            :initial-html="bodyHtml"
            mode="article"
          />
        </slot>
      </ArticleDetailBody>
    </section>

    <div
      v-if="detailView.header.tags.length > 0 || rightsNoticeVisible || hasRelatedReading"
      class="fsus-appendix"
      data-article-tail-group
      data-fsus-surface="reading"
    >
      <div
        v-if="detailView.header.tags.length > 0"
        class="fsus-appendix__tags"
        :aria-label="messages.article.content.tagsAria"
      >
        <component
          :is="appendixTagComponent"
          v-for="tag in detailView.header.tags"
          :key="tag.label"
          v-bind="appendixTagLinkProps(tag)"
          class="fsus-appendix__tag"
          data-public-link="filter"
        >
          {{ appendixTagLabel(tag.label) }}
        </component>
      </div>

      <div
        v-if="rightsNoticeVisible"
        class="fsus-appendix__copyright article-rights-notice"
        data-article-rights-notice
        :data-rights-snapshot-id="detailView.rights.snapshotId"
        :data-rights-policy-hash="detailView.rights.policyHash"
        :data-rights-content-hash="detailView.rights.contentCanonicalHash"
        :aria-label="messages.article.content.rightsAria"
      >
        {{ appendixCopyrightText }}
      </div>

      <div
        v-if="hasRelatedReading"
        id="fsus-related-reading"
        data-public-related-reading="true"
        class="fsus-appendix__nav"
        aria-labelledby="fsus-related-reading-heading"
      >
        <div
          id="fsus-related-reading-heading"
          class="fsus-appendix__nav-label"
        >
          {{ messages.article.actions.related }}
        </div>

        <nav :aria-label="messages.article.content.relatedAria">
          <ul class="fsus-appendix__nav-list">
            <li
              v-if="detailView.relatedReading.previous"
              class="fsus-appendix__nav-item"
            >
              <span class="fsus-appendix__meta">
                {{ messages.article.actions.previousArticle }} · {{ detailView.relatedReading.previous.displayTime }}
              </span>
              <a
                :href="detailView.relatedReading.previous.href"
                class="fsus-appendix__link"
                data-related-role="previous"
              >
                {{ detailView.relatedReading.previous.title }}
              </a>
            </li>

            <li
              v-if="detailView.relatedReading.next"
              class="fsus-appendix__nav-item"
            >
              <span class="fsus-appendix__meta">
                {{ messages.article.actions.nextArticle }} · {{ detailView.relatedReading.next.displayTime }}
              </span>
              <a
                :href="detailView.relatedReading.next.href"
                class="fsus-appendix__link"
                data-related-role="next"
              >
                {{ detailView.relatedReading.next.title }}
              </a>
            </li>

            <li
              v-for="item in detailView.relatedReading.items"
              :key="item.id"
              class="fsus-appendix__nav-item"
            >
              <span class="fsus-appendix__meta">
                {{ messages.article.actions.related }} · {{ item.displayTime }}
              </span>
              <a
                :href="item.href"
                class="fsus-appendix__link"
                data-related-role="related"
              >
                {{ item.title }}
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </div>

    <section
      id="fsus-comments-island"
      class="mt-6 sm:mt-8"
      data-fsus-surface="reading"
      :data-article-id="String(safeArticleId)"
    >
      <h2
        id="comments"
        class="mb-6 border-b border-[var(--fsusblog-panel-border)] pb-4 text-sm font-bold normal-case text-[var(--fsusblog-text-primary)]"
      >
        {{ messages.article.comments.heading }}
      </h2>
      <div
        id="fsus-comments-island-content"
        class="min-h-0"
      >
        <slot name="comments">
          <ArticleDetailCommentsPlaceholder
            :text="detailView.comments.placeholderText"
          />
        </slot>
      </div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18nText } from '@/composables/useI18nText'
import ArticleReadingNotice from '@/components/article/ArticleReadingNotice.vue'
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleResponsibilityDisclosure from '@/components/article/ArticleResponsibilityDisclosure.vue'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import ArticleDetailCommentsPlaceholder from '@/components/public/ArticleDetailCommentsPlaceholder.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import { usePublicSiteTitle } from '@/public-renderers/publicSiteIdentityContext'
import { themeTokens } from '@/ui-tokens/themeTokens'
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'
import type { ArticleResponsibilityPublicView } from '@/view-contracts/articleResponsibility'
import { resolvePublicCoverPresentation } from '@/view-contracts/coverArt'

const props = withDefaults(defineProps<{
  detailView: ArticleDetailPageViewContract
  articleId: number | string | null | undefined
  authorName: string
  responsibilityAuthors?: readonly Readonly<{ name: string; profileUrl: string | null }>[]
  responsibilityManifest?: ArticleResponsibilityPublicView | null
  articleSummary: string
  canonicalUrl?: string | null
  hasBodyContent: boolean
  bodyContent?: string
  bodyHtml?: string
  linkMode?: 'anchor' | 'router'
}>(), {
  canonicalUrl: null,
  bodyContent: '',
  bodyHtml: '',
  linkMode: 'anchor'
})

const { messages, t } = useI18nText()

const siteTitle = usePublicSiteTitle()
const effectiveResponsibilityAuthors = computed(() => (
  props.responsibilityAuthors?.length
    ? props.responsibilityAuthors
    : [{ name: props.authorName.trim() || 'Fsu', profileUrl: null }]
))

const safeArticleId = computed(() => {
  const normalized = Number(props.articleId)
  return Number.isFinite(normalized) && normalized > 0 ? Math.trunc(normalized) : 0
})

const detailCover = computed(() => resolvePublicCoverPresentation(props.detailView.header.coverImageUrl))

const hasRelatedReading = computed(() => (
  props.detailView.relatedReading.previous !== null
  || props.detailView.relatedReading.next !== null
  || props.detailView.relatedReading.items.length > 0
))

const rightsNoticeVisible = computed(() => props.detailView.rights.enabled && props.detailView.rights.showPublicBadge)

type AppendixTag = ArticleDetailPageViewContract['header']['tags'][number]

const appendixTagComponent = computed(() => (
  props.linkMode === 'anchor'
    ? 'a'
    : 'RouterLink'
))

const appendixTagHref = (tag: AppendixTag): string => (
  tag.href?.trim() ?? ''
)

const appendixTagLinkProps = (tag: AppendixTag): Record<string, string> => (
  props.linkMode === 'anchor'
    ? { href: appendixTagHref(tag) }
    : { to: appendixTagHref(tag) }
)

const appendixTagLabel = (label: string): string => label.toLocaleLowerCase('en-US')

const rightsLicenseText = computed(() => {
  const licenseType = props.detailView.rights.licenseType
  if (licenseType === 'all-rights-reserved') return '保留所有权利'
  return licenseType
})

const appendixCopyrightText = computed(() => {
  const rights = props.detailView.rights
  const holder = rights.copyrightHolder?.trim() || siteTitle.value
  const copyrightPrefix = rights.copyrightYear
    ? `© ${rights.copyrightYear} ${holder}.`
    : `© ${holder}.`
  const allowedUses = [
    rights.allowCodeCopy ? '代码块复制' : '',
    rights.maxExcerptChars > 0 ? `最多 ${rights.maxExcerptChars} 字符摘录` : ''
  ].filter(Boolean)
  const permissionText = allowedUses.length > 0
    ? `允许${allowedUses.join('及')}`
    : '未开放复制'
  const attributionText = rights.copyPolicy === 'append-attribution' ? '，需追加署名' : ''
  const rightsVersion = rights.contentCanonicalHash.split(':')[0]?.trim()
  const versionText = rightsVersion ? ` (${rightsVersion})` : ''

  return `${copyrightPrefix} ${rightsLicenseText.value}。${permissionText}${attributionText}${versionText}。`
})
</script>

<style scoped>
.public-article-detail {
  overflow-anchor: none;
}

.fsus-appendix {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--fsusblog-panel-border);
  text-align: left;
  background: transparent;
  box-shadow: none;
  color: var(--fsusblog-text-quiet);
  font-size: 14px;
  font-weight: 400;
  font-family: 'Google Sans', 'Noto Sans CJK', sans-serif;
}

.fsus-appendix__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  color: var(--fsusblog-text-quiet);
  font-size: 14px;
  font-weight: 400;
}

.fsus-appendix__tag {
  display: inline-flex;
  min-height: 44px;
  box-sizing: border-box;
  align-items: center;
  color: var(--fsusblog-text-quiet) !important;
  font-size: 14px;
  font-weight: 400;
  letter-spacing: normal;
  text-decoration: none;
  text-transform: none;
}

.fsus-appendix__copyright {
  color: var(--fsusblog-text-quiet);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.6;
}

.fsus-appendix__nav-label {
  margin-bottom: 10px;
  color: var(--fsusblog-text-quiet);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 1px;
}

.fsus-appendix__nav-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.fsus-appendix__nav-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.fsus-appendix__meta {
  color: var(--fsusblog-text-quiet);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
}

.fsus-appendix__link {
  display: inline-flex;
  min-height: 44px;
  box-sizing: border-box;
  align-items: center;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
  text-decoration: none;
  transition: color var(--blog-motion-control) var(--blog-motion-ease);
}

.fsus-appendix__tag:visited {
  color: var(--fsusblog-text-quiet) !important;
}

.fsus-appendix__link:visited {
  color: var(--fsusblog-text-primary);
}

.fsus-appendix__link:hover {
  background: transparent;
  color: var(--fsusblog-color-primary);
  text-decoration: none;
}

.fsus-appendix__link:focus-visible,
.fsus-appendix__tag:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  outline: none;
}

@media (max-width: 639px) {
  .public-article-detail {
    width: calc(100% + 2rem);
    margin-right: -1rem;
    margin-left: -1rem;
  }
}
</style>
