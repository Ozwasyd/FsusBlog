import { computed, ref } from 'vue'
import type { SiteSeo } from '../../Contracts/site-config.ts'

export interface SiteBrandState {
  title: string
  author: string
  siteLogoUrl: string
  siteLogoDarkUrl: string
  siteWordmarkUrl: string
}

const assetSegmentPattern = /^[A-Za-z0-9._-]+$/
const initialTitle = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-site-title"]')?.content || "Fsu's Blog"
const initialAuthor = document.head.querySelector<HTMLMetaElement>('meta[name="author"]')?.content || ''

export const siteBrand = ref<SiteBrandState>({
  title: initialTitle,
  author: initialAuthor,
  siteLogoUrl: '',
  siteLogoDarkUrl: '',
  siteWordmarkUrl: '',
})

export const siteTitle = computed(() => siteBrand.value.title)
export const siteConfigEpoch = ref(0)

export function safeBrandAssetUrl(raw: string): string {
  const value = raw.trim()
  if (!value || /\s|\\/.test(value)) return ''
  if (value.startsWith('/assets/')) {
    const rest = value.slice('/assets/'.length)
    return rest.length > 0 && rest.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..' && assetSegmentPattern.test(seg))
      ? value
      : ''
  }
  if (/[@?#]/.test(value)) return ''
  const parsed = URL.parse(value)
  return parsed?.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password ? parsed.href : ''
}

export function applySiteBrand(seo: Pick<SiteSeo, 'title' | 'author' | 'siteLogoUrl' | 'siteLogoDarkUrl' | 'siteWordmarkUrl'>): void {
  const title = seo.title.trim() || initialTitle
  siteBrand.value = {
    title,
    author: seo.author.trim(),
    siteLogoUrl: safeBrandAssetUrl(seo.siteLogoUrl),
    siteLogoDarkUrl: safeBrandAssetUrl(seo.siteLogoDarkUrl),
    siteWordmarkUrl: safeBrandAssetUrl(seo.siteWordmarkUrl),
  }
  const meta = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-site-title"]')
  if (meta) meta.content = title
}

export function bumpSiteConfigEpoch(): void {
  siteConfigEpoch.value += 1
}

export function publicOriginBase(): string {
  const origin = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-origin"]')?.content ?? ''
  return origin && origin !== globalThis.location?.origin ? origin : ''
}
