import { nextTick, onUnmounted, ref, type MaybeRefOrGetter, toValue, watch } from 'vue'
import { scrollToArticleTarget } from '@/composables/article/useArticleReadingTarget'

export type ArticleTocItem = Readonly<{
  id: string
  text: string
  level: 2 | 3
}>

function slugifyHeading(text: string, fallback: string): string {
  const slug = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let candidate = base
  let index = 2
  while (used.has(candidate) || document.getElementById(candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }
  used.add(candidate)
  return candidate
}

export function useArticleToc(contentRoot: MaybeRefOrGetter<HTMLElement | null>) {
  const items = ref<ArticleTocItem[]>([])
  const activeId = ref<string | null>(null)
  let observer: IntersectionObserver | null = null

  const cleanupObserver = (): void => {
    observer?.disconnect()
    observer = null
  }

  const collect = async (): Promise<void> => {
    await nextTick()
    cleanupObserver()
    const root = toValue(contentRoot)
    if (!root) {
      items.value = []
      activeId.value = null
      return
    }

    const used = new Set<string>()
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h2, h3'))
      .filter((heading) => heading.textContent?.trim())

    items.value = headings.map((heading, index) => {
      if (!heading.id) {
        heading.id = ensureUniqueId(slugifyHeading(heading.textContent ?? '', `section-${index + 1}`), used)
      } else {
        used.add(heading.id)
      }
      heading.classList.add('fsus-article-heading-anchor')
      return {
        id: heading.id,
        text: heading.textContent?.trim() ?? '',
        level: heading.tagName.toLowerCase() === 'h3' ? 3 : 2
      }
    })

    activeId.value = items.value[0]?.id ?? null
    if (items.value.length === 0 || typeof IntersectionObserver === 'undefined') {
      return
    }

    observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const first = visible[0]?.target
      if (first instanceof HTMLElement) {
        activeId.value = first.id
      }
    }, {
      root: null,
      rootMargin: '-20% 0px -70% 0px',
      threshold: [0, 1]
    })

    for (const heading of headings) {
      observer.observe(heading)
    }
  }

  const navigateTo = (id: string): void => {
    const target = document.getElementById(id)
    if (!target) {
      return
    }

    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}#${encodeURIComponent(id)}`)
    scrollToArticleTarget(target)
    activeId.value = id
  }

  watch(() => toValue(contentRoot), () => {
    void collect()
  }, { flush: 'post' })

  onUnmounted(cleanupObserver)

  return {
    items,
    activeId,
    refresh: collect,
    navigateTo
  }
}
