import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { PUBLIC_SITE_IDENTITY_DEFAULTS } from '@/public-renderers/publicSiteIdentityDefaults'
import {
  normalizePublicSiteDescription,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'

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

type PublicSeedSnapshotWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__?: string | null
  __FSUS_PUBLIC_HYDRATION_RAW__?: string | null
}

type LoaderSiteIdentity = Readonly<{
  siteTitle: string
  siteDescription: string
}>

function readSeedTextById(id: string): string | null {
  const text = document.getElementById(id)?.textContent?.trim()
  return text || null
}

function readWindowSeedText(key: keyof PublicSeedSnapshotWindow): string | null {
  const raw = (window as PublicSeedSnapshotWindow)[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

function readSeedSiteIdentity(rawPayload: string | null): LoaderSiteIdentity | null {
  if (!rawPayload) {
    return null
  }

  try {
    const parsed = decodePublicAotPayload<Record<string, unknown>>(rawPayload)
    return {
      siteTitle: normalizePublicSiteTitle(parsed?.siteTitle ?? parsed?.title),
      siteDescription: normalizePublicSiteDescription(parsed?.siteDescription)
    }
  } catch {
    return null
  }
}

function readLoaderSiteIdentity(): LoaderSiteIdentity | null {
  const candidates = [
    readSeedTextById('fsus-aot-hydration-props'),
    readWindowSeedText('__FSUS_PUBLIC_HYDRATION_RAW__'),
    readSeedTextById('fsus-aot-bootstrap'),
    readWindowSeedText('__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__')
  ]

  for (const rawPayload of candidates) {
    const identity = readSeedSiteIdentity(rawPayload)
    if (identity) {
      return identity
    }
  }

  return null
}

function createDefaultLoaderIdentity(): LoaderSiteIdentity {
  return {
    siteTitle: PUBLIC_SITE_IDENTITY_DEFAULTS.siteTitle,
    siteDescription: PUBLIC_SITE_IDENTITY_DEFAULTS.siteDescription
  }
}

function syncLoaderDocumentHead(identity: LoaderSiteIdentity): void {
  document.title = identity.siteTitle

  let descriptionMeta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!descriptionMeta) {
    descriptionMeta = document.createElement('meta')
    descriptionMeta.setAttribute('name', 'description')
    document.head.appendChild(descriptionMeta)
  }
  descriptionMeta.setAttribute('content', identity.siteDescription)
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

  const identity = readLoaderSiteIdentity() ?? createDefaultLoaderIdentity()
  const title = identity.siteTitle
  syncLoaderDocumentHead(identity)

  const titleEl = loader.querySelector<HTMLElement>('[data-fsus-loader-title], .loader-title')
  if (titleEl) {
    titleEl.textContent = title
  }

  const statusEl = loader.querySelector<HTMLElement>('[data-fsus-loader-status], .loader-text')
  if (statusEl) {
    statusEl.textContent = `正在加载 ${title}`
  }

  loader.hidden = false
}
