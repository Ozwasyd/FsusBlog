import { renderToString } from '@vue/server-renderer';
import { createSSRApp } from 'vue';

import { provideFsusUiAppContext } from '@/fsusui/appContext';
import {
    prepareLocaleDomains,
    provideLocaleTextContext
} from '@/locales';
import { requiredLocaleDomainsForPublicPage } from '@/locales/routeLocaleDomains';
import { createPublicHydrationRootComponent, renderPublicHydrationMarkdown } from '@/public-renderers/publicHydrationRoot';
import { normalizePublicHydrationPayload } from '@/public-renderers/publicPayloadNormalizer';
import { registerPublicStaticRouterLink } from '@/public-renderers/publicStaticRouterLink';
import type { PublicHydrationPayload } from '@/public-renderers/types';

export { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';
export { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore';
export { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog';
export { projectPublicBrowserEnvironment } from '@/public-renderers/publicBrowserEnvironment';
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
} from '@/public-renderers/publicEntryRegistry';

export async function renderPublicHydrationSnapshot(payload: PublicHydrationPayload): Promise<string>
{
    const normalizedPayload = normalizePublicHydrationPayload(payload);
    const localeSnapshot = await prepareLocaleDomains(
        normalizedPayload.renderLocale,
        requiredLocaleDomainsForPublicPage(normalizedPayload.pageKind)
    );
    const initialRender = await renderPublicHydrationMarkdown(normalizedPayload);
    const app = createSSRApp(createPublicHydrationRootComponent(normalizedPayload, initialRender));
    provideLocaleTextContext(app, localeSnapshot);
    provideFsusUiAppContext(app);
    registerPublicStaticRouterLink(app);
    return await renderToString(app);
}
