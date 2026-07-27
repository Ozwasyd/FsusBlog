import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import type { PublicHydrationPayload } from '@/public-renderers/types'
import { createPublicHydrationRootComponent } from '@/public-renderers/publicHydrationRoot'
import { normalizePublicHydrationPayload } from '@/public-renderers/publicPayloadNormalizer'
import { registerPublicStaticRouterLink } from '@/public-renderers/publicStaticRouterLink'

export { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
export { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
export { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
export { projectPublicBrowserEnvironment } from '@/public-renderers/publicBrowserEnvironment'
export {
  buildPublicEntry,
  renderPublicAboutEntry,
  renderPublicArchiveEntry,
  renderPublicArticleDetailEntry,
  renderPublicCopyrightEntry,
  renderPublicFilterEntry,
  renderPublicGuidelinesEntry,
  renderPublicHomeEntry,
  renderPublicPrivacyEntry
} from '@/public-renderers/publicEntryRegistry'

export async function renderPublicHydrationSnapshot(payload: PublicHydrationPayload): Promise<string> {
  const normalizedPayload = normalizePublicHydrationPayload(payload)
  const app = createSSRApp(createPublicHydrationRootComponent(normalizedPayload))
  provideFsusUiAppContext(app)
  registerPublicStaticRouterLink(app)
  return await renderToString(app)
}
