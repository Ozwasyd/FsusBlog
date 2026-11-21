import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { adminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { decodeUtf8 } from './binary.ts';
import { request } from './client.ts';
import { decodePowChallenge, encodePowProof, solveScopedPow } from './pow.ts';
import { decodeSitePage, sitePages, type SitePageSlug } from './site-pages.ts';
import { decodeAdminSitePageRevision, decodeAdminSitePages, encodeAdminSitePagePublish,
  FrameType, WireHeaders, WireLimits, WireRoutes, type AdminSitePagePublish } from './wire.generated.ts';

const slugs = ['about', 'privacy', 'guidelines', 'copyright'] as const;
const encoder = new TextEncoder();

export function readAdminSitePages(signal: AbortSignal) {
  return request(WireRoutes.AdminSitePages, FrameType.AdminSitePages, (payload, headers) => {
    const { configuredMask } = decodeAdminSitePages(payload);
    if (configuredMask < 0 || configuredMask > 15) throw new ProtocolError('Invalid site page configuration states');
    return {
      editor: headers.get(WireHeaders.AdminSitePageEditor) === '1',
      pages: slugs.map((slug, index) => ({ slug, title: sitePages[slug], configured: Boolean(configuredMask & (1 << index)) })),
    };
  }, signal);
}

export function readSitePageRevision(slug: SitePageSlug, signal: AbortSignal) {
  return request(WireRoutes.AdminSitePageRevision.replace('{slug}', slug), FrameType.AdminSitePageRevision, payload => {
    const page = decodeAdminSitePageRevision(payload);
    if (page.slug !== slug || page.revision < 0n || !/^[a-f0-9]{64}$/.test(page.digest) || !validPageMarkdown(page.markdown))
      throw new ProtocolError('Invalid administrator site page revision');
    return page;
  }, signal);
}

export function validPageMarkdown(markdown: string): boolean {
  if (markdown.length > WireLimits.PageContentChars || markdown.includes('\0')) return false;
  const bytes = encoder.encode(markdown);
  return bytes.length <= WireLimits.PageContentBytes && decodeUtf8(bytes) === markdown;
}

export async function publishAdminSitePage(intent: AdminSitePagePublish, signal: AbortSignal): Promise<void> {
  if (!validPageMarkdown(intent.markdown)) throw new ProtocolError('Invalid site page Markdown');
  const frame = encodeFrame(FrameType.AdminSitePagePublish, encodeAdminSitePagePublish(intent));
  const passkey = await proveAdminStepUp({
    begin: WireRoutes.AdminSitePageStepUpBegin,
    complete: WireRoutes.AdminSitePageStepUpComplete,
  }, frame, signal);

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  const challenge = await request(WireRoutes.AdminSitePagePow, FrameType.PowChallenge, decodePowChallenge,
    signal, 'POST', frame, { [WireHeaders.PowClientNonce]: nonce });
  const work = await solveScopedPow(challenge, nonce, signal);
  await request(WireRoutes.AdminSitePagePublish, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', frame,
    { ...adminProofHeaders(passkey), [WireHeaders.PowProof]: encodePowProof(challenge, work, nonce) });
}

export function readAdminSitePage(slug: SitePageSlug, signal: AbortSignal) {
  return request(WireRoutes.AdminSitePage.replace('{slug}', slug), FrameType.PageContent, payload => {
    const page = decodeSitePage(payload);
    if (page.slug !== slug) throw new ProtocolError('Administrator page does not match the request');
    return page;
  }, signal);
}
