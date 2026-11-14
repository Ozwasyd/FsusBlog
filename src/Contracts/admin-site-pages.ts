import { ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { decodeSitePage, sitePages, type SitePageSlug } from './site-pages.ts';
import { decodeAdminSitePages, FrameType, WireRoutes } from './wire.generated.ts';

const slugs = ['about', 'privacy', 'guidelines', 'copyright'] as const;

export function readAdminSitePages(signal: AbortSignal) {
  return request(WireRoutes.AdminSitePages, FrameType.AdminSitePages, payload => {
    const { configuredMask } = decodeAdminSitePages(payload);
    if (configuredMask < 0 || configuredMask > 15) throw new ProtocolError('Invalid site page configuration states');
    return slugs.map((slug, index) => ({ slug, title: sitePages[slug], configured: Boolean(configuredMask & (1 << index)) }));
  }, signal);
}

export function readAdminSitePage(slug: SitePageSlug, signal: AbortSignal) {
  return request(WireRoutes.AdminSitePage.replace('{slug}', slug), FrameType.PageContent, payload => {
    const page = decodeSitePage(payload);
    if (page.slug !== slug) throw new ProtocolError('Administrator page does not match the request');
    return page;
  }, signal);
}
