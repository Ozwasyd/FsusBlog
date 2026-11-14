import { ProtocolError, decodeUtf8 } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

export const sitePages = {
  about: '关于',
  privacy: '隐私政策',
  guidelines: '用户守则',
  copyright: '版权声明',
} as const;

export type SitePageSlug = keyof typeof sitePages;

export function isSitePageSlug(slug: unknown): slug is SitePageSlug {
  return typeof slug === 'string' && Object.hasOwn(sitePages, slug);
}

export function decodeSitePage(payload: Uint8Array): { slug: SitePageSlug; markdown: string } {
  const start = WireLayouts.PageContentBlobOffset;
  const fixed = WireLayouts.PageContentSlugBytes;
  if (payload.byteLength < start || payload.byteLength > start + WireLimits.PageContentBytes)
    throw new ProtocolError('Invalid site page payload size');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const length = view.getUint32(fixed + 8, true);
  if (view.getUint32(fixed, true) !== 0 || view.getUint32(fixed + 4, true) !== length ||
      length !== payload.byteLength - start)
    throw new ProtocolError('Invalid site page Markdown slice');
  const slugField = payload.subarray(0, fixed);
  const terminator = slugField.indexOf(0);
  if (terminator < 0 || slugField.subarray(terminator).some(byte => byte !== 0))
    throw new ProtocolError('Invalid site page slug field');
  const slug = decodeUtf8(slugField.subarray(0, terminator));
  const markdown = decodeUtf8(payload.subarray(start));
  if (!isSitePageSlug(slug) || markdown.length > WireLimits.PageContentChars || markdown.includes('\0'))
    throw new ProtocolError('Invalid site page content');
  return { slug, markdown };
}

export function getSitePage(slug: SitePageSlug, signal?: AbortSignal) {
  return request(WireRoutes.PublicSitePage.replace('{slug}', slug), FrameType.PageContent, payload => {
    const page = decodeSitePage(payload);
    if (page.slug !== slug) throw new ProtocolError('Site page does not match the request');
    return page;
  }, signal);
}
