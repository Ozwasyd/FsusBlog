const PUBLIC_SEO_PATH_PATTERNS = [
  /^\/$/,
  /^\/archive\/?$/,
  /^\/about\/?$/,
  /^\/privacy\/?$/,
  /^\/guidelines\/?$/,
  /^\/copyright\/?$/,
  /^\/article\/\d+\/?$/,
  /^\/category\/\d+\/?$/,
  /^\/tag\/\d+\/?$/,
  /^\/tag\/[^/]+\/?$/
]

export function isPublicSeoPath(pathname: string): boolean {
  return PUBLIC_SEO_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
}

export function hasServerAotShell(root: Element | null): boolean {
  if (!(root instanceof HTMLElement)) {
    return false
  }

  return root.querySelector('#fsus-aot-shell') instanceof HTMLElement
}

function readLoaderSiteTitle(): string | null {
  try {
    const script = document.getElementById('fsus-aot-bootstrap')
    const text = script?.textContent?.trim()
    if (!text) return null
    const parsed = decodePublicAotPayload<Record<string, unknown>>(text)
    const title = parsed?.siteTitle
    return typeof title === 'string' && title.trim() ? title.trim() : null
  } catch {
    return null
  }
}

export function removeGlobalLoader(): void {
  const loader = document.getElementById('global-loader')
  if (!loader) {
    return
  }

  loader.hidden = true
}

export function showGlobalLoader(): void {
  const loader = document.getElementById('global-loader')
  if (!loader) {
    return
  }

  const title = readLoaderSiteTitle()
  if (title) {
    const titleEl = loader.querySelector<HTMLElement>('.loader-title')
    if (titleEl) {
      titleEl.textContent = title
    }
  }

  loader.hidden = false
}
import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
