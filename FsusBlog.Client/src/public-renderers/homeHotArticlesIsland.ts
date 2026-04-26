import { getHotArticles } from '@/api/article'

let mountedAsideContent: HTMLElement | null = null
let loadController: AbortController | null = null
let mountedRouteKey: string | null = null

function createAsideHtml(items: Array<{ id: number; title: string; views: number }>): string {
  const numberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })
  const list = items
    .slice(0, 5)
    .map((article, index) => `
      <li class="group flex items-start gap-6">
        <span class="flex-none text-sm font-mono font-medium text-[#D4D4D8] group-hover:text-[#2A599C] dark:group-hover:text-[#F4F4F5] transition-colors duration-300 w-6 pt-0.5">
          ${String(index + 1).padStart(2, '0')}
        </span>
        <div class="flex-auto flex flex-col gap-1.5">
          <a href="/article/${article.id}" class="rounded-[8px] text-sm font-medium text-[#0F0F11] dark:text-[#F4F4F5] group-hover:text-[#2A599C] dark:group-hover:text-[#A1A1AA] transition-colors duration-300 leading-relaxed line-clamp-2 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
            ${article.title}
          </a>
          <p class="text-xs text-[#A1A1AA] font-medium">
            ${numberFormatter.format(article.views)} Views
          </p>
        </div>
      </li>
    `)
    .join('')

  return `
    <section class="space-y-16" data-dynamic-island="home-hot-articles">
      <div>
        <h2 class="text-xs font-bold text-[#A1A1AA] uppercase mb-8">热门文章</h2>
        <ol role="list" class="space-y-6">${list}</ol>
      </div>
    </section>
  `
}

function removeMountedAsideContent(): void {
  mountedAsideContent?.replaceChildren()
  mountedAsideContent = null
}

export async function mountHomeHotArticlesIsland(routeKey: string): Promise<void> {
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
    const wrapper = document.createElement('div')
    wrapper.innerHTML = createAsideHtml(articles.map((article) => ({
      id: article.id,
      title: article.title,
      views: article.views
    }))).trim()

    const aside = wrapper.firstElementChild
    if (!(aside instanceof HTMLElement)) {
      return
    }

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
