import { isSitePageSlug, sitePages, type SitePageSlug } from '../../Contracts/site-pages'

type SitePage = Readonly<{ slug: SitePageSlug; body: string; configured: boolean; bodyLanguage?: string }>

let initial: SitePage | undefined

function read(root: ParentNode, slug: SitePageSlug): SitePage | undefined {
  const article = root.querySelector('#app [data-fsus-public-content] > article[data-site-page]')
  if (!article || article.getAttribute('data-site-page') !== slug) return
  const state = article.getAttribute('data-state')
  const body = article.querySelector(':scope > [data-site-page-body]')
  if (!body || (state !== 'published' && state !== 'unconfigured')) return
  // The server owns this fragment, which is constructed from Markdown with raw HTML disabled.
  return { slug, body: body.innerHTML, configured: state === 'published', bodyLanguage: body.getAttribute('lang') ?? undefined }
}

function readFragment(html: string, slug: SitePageSlug): SitePage | undefined {
  // A detached template has inert content, including resources, until the application inserts it.
  const template = document.createElement('template')
  template.innerHTML = html
  return read(template.content, slug)
}

export function captureInitialSitePage(slug: unknown): void {
  if (isSitePageSlug(slug)) initial = read(document, slug)
}

export async function readSitePage(slug: SitePageSlug, signal: AbortSignal): Promise<SitePage> {
  if (initial?.slug === slug) {
    const cached = initial
    initial = undefined
    return cached
  }
  const response = await fetch('/' + slug, {
    signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html' },
  })
  if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/html'))
    throw new Error('Site page unavailable')
  const page = readFragment(await response.text(), slug)
  if (!page) throw new Error('Unexpected site page response')
  return page
}

export function updateSitePageRobots(indexable: boolean): void {
  const existing = document.head.querySelector('meta[name="robots"]')
  if (indexable) {
    existing?.remove()
  } else if (!existing) {
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex, follow'
    document.head.append(robots)
  }
}

export { isSitePageSlug, sitePages }
