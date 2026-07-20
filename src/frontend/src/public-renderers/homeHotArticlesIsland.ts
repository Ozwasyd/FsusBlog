import { getHotArticles } from '@/api/article'
import { buildPublicArticleHref } from '@/public-renderers/publicRouteIdentity'

let mountedAsideContent: HTMLElement | null = null
let loadController: AbortController | null = null
let mountedRouteKey: string | null = null

function createAsideElement(items: Array<{ id: number; title: string; views: number }>): HTMLElement {
  const numberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })

  const section = document.createElement('section')
  section.className = 'space-y-16'
  section.dataset.dynamicIsland = 'home-hot-articles'

  const container = document.createElement('div')

  const heading = document.createElement('h2')
  heading.className = 'text-xs font-bold text-[var(--fsusblog-text-muted)] normal-case mb-8'
  heading.textContent = '热门文章'

  const list = document.createElement('ol')
  list.setAttribute('role', 'list')
  list.className = 'space-y-6'

  items.slice(0, 5).forEach((article, index) => {
    const item = document.createElement('li')
    item.className = 'group flex items-start gap-6'

    const rank = document.createElement('span')
    rank.className = 'flex-none text-sm tabular-nums font-medium text-[var(--fsusblog-text-muted)] group-hover:text-[var(--fsusblog-color-primary)] transition-fsus transition-fsus-base w-6 pt-0.5'
    rank.textContent = String(index + 1).padStart(2, '0')

    const body = document.createElement('div')
    body.className = 'flex-auto flex flex-col gap-1.5'

    const link = document.createElement('a')
    link.setAttribute('href', buildPublicArticleHref(article.id))
    link.className = 'rounded-[var(--fsusblog-radius-control)] text-sm font-medium text-[var(--fsusblog-text-primary)] group-hover:text-[var(--fsusblog-color-primary)] transition-fsus transition-fsus-base leading-relaxed line-clamp-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]'
    link.textContent = article.title

    const views = document.createElement('p')
    views.className = 'text-xs text-[var(--fsusblog-text-muted)] font-medium'
    views.textContent = `${numberFormatter.format(article.views)} 次打开`

    body.append(link, views)
    item.append(rank, body)
    list.append(item)
  })

  container.append(heading, list)
  section.append(container)

  return section
}

function removeMountedAsideContent(): void {
  mountedAsideContent?.replaceChildren()
  mountedAsideContent = null
}

export async function mountHomeHotArticlesIsland(routeKey: string): Promise<void> {
  // Hot articles are now surfaced by HomeTextFirstRecommendations in the
  // main column on the homepage, so views/Home.vue passes showAside=false
  // and HomeFeedSurface omits the fsus-home-hot-articles-slot-content
  // placeholder. The early-return below keeps this loader safe to call from
  // publicShell.ts when the slot is absent — no DOM mutation, no fetch.
  const slot = document.getElementById('fsus-home-hot-articles-slot-content')
  if (!slot) {
    return
  }

  if (mountedAsideContent && mountedRouteKey === routeKey && slot.children.length > 0) {
    return
  }

  loadController?.abort()
  const controller = new AbortController()
  loadController = controller

  try {
    const articles = await getHotArticles(5, { signal: controller.signal })
    if (controller.signal.aborted || !Array.isArray(articles) || articles.length === 0) {
      return
    }

    removeMountedAsideContent()
    const aside = createAsideElement(articles.map((article) => ({
      id: article.id,
      title: article.title,
      views: article.views
    })))

    slot.replaceChildren(aside)
    mountedAsideContent = slot
    mountedRouteKey = routeKey
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return
    }
  } finally {
    if (loadController === controller) {
      loadController = null
    }
  }
}

export function unmountHomeHotArticlesIsland(): void {
  loadController?.abort()
  loadController = null
  mountedRouteKey = null
  removeMountedAsideContent()
}
