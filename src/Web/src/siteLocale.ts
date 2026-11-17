import { computed, readonly, ref } from 'vue'
import messages from '../../Contracts/site-locales.json' with { type: 'json' }

export type SiteLocale = keyof typeof messages
export type MessageKey = keyof typeof messages.en
const cookieName = 'fsus_locale'
const fallback = 'zh-CN'

function isSiteLocale(value: unknown): value is SiteLocale {
  return value === 'en' || value === 'zh-CN'
}

function savedLocale(): SiteLocale | undefined {
  const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
  return isSiteLocale(value) ? value : undefined
}

function browserLocale(): SiteLocale {
  for (const language of navigator.languages) {
    const base = language.toLowerCase().split('-')[0]
    if (base === 'en') return 'en'
    if (base === 'zh') return 'zh-CN'
  }
  return fallback
}

// Match the delivered first paint; browser preferences are a fallback for SPA-only pages.
const initial = document.querySelector<HTMLMetaElement>('meta[name="fsus-locale"]')?.content
const activeLocale = ref<SiteLocale>(isSiteLocale(initial) ? initial : savedLocale() ?? browserLocale())
export const siteLocale = readonly(activeLocale)

export function selectSiteLocale(value: string): void {
  if (!isSiteLocale(value)) return
  activeLocale.value = value
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  try { document.cookie = `${cookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}` }
  catch { /* Keep the current page usable if cookies are disabled. */ }
}

window.addEventListener('pageshow', event => {
  if (!event.persisted) return
  const saved = savedLocale()
  if (saved) activeLocale.value = saved
})

export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const text = messages[activeLocale.value][key]
  return params ? text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : token) : text
}

export const themeLabels = computed(() => {
  const light = t('theme.light'), dark = t('theme.dark'), system = t('theme.system')
  return { light, dark, system, lightShort: light, darkShort: dark, systemShort: system }
})
