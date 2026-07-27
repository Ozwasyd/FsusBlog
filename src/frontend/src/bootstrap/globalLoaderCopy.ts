import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '@/locales/localeCatalog'
import { common as deDE } from '@/locales/de-DE/common'
import { common as enUS } from '@/locales/en-US/common'
import { common as es419 } from '@/locales/es-419/common'
import { common as frFR } from '@/locales/fr-FR/common'
import { common as jaJP } from '@/locales/ja-JP/common'
import { common as koKR } from '@/locales/ko-KR/common'
import { common as ptBR } from '@/locales/pt-BR/common'
import { common as ruRU } from '@/locales/ru-RU/common'
import { common as zhCN } from '@/locales/zh-CN/common'
import { common as zhHant } from '@/locales/zh-Hant/common'

/** Semantic key used by the global loader status live region. */
export const GLOBAL_LOADER_STATUS_KEY = 'common.loading.statusWithSite' as const

const LOADING_COPY: Readonly<Record<SupportedLocale, Readonly<{ status: string, statusWithSite: string }>>> = {
  'zh-CN': zhCN.loading,
  'en-US': enUS.loading,
  'zh-Hant': zhHant.loading,
  'ja-JP': jaJP.loading,
  'ko-KR': koKR.loading,
  'es-419': es419.loading,
  'fr-FR': frFR.loading,
  'de-DE': deDE.loading,
  'pt-BR': ptBR.loading,
  'ru-RU': ruRU.loading
}

function resolveDocumentLocale(): SupportedLocale {
  if (typeof document === 'undefined') {
    return DEFAULT_LOCALE
  }
  const raw = document.documentElement.lang?.trim()
  if (raw && isSupportedLocale(raw)) {
    return raw
  }
  return DEFAULT_LOCALE
}

export function resolveGlobalLoaderStatus(siteTitle: string): string {
  const copy = LOADING_COPY[resolveDocumentLocale()] ?? LOADING_COPY[DEFAULT_LOCALE]
  return copy.statusWithSite.replace(/\{siteTitle\}/gu, siteTitle)
}
