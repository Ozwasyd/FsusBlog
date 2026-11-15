import { ApiError, ProtocolError } from './aeds.ts';
import { validSiteSessionId } from './client.ts';
import { WireHeaders } from './wire.generated.ts';

const maximumBytes = 16_384;
const plainUtf8 = /^text\/plain(?:;\s*charset\s*=\s*(?:"utf-8"|utf-8))?$/i;
const consentHeader = 'X-Fsus-Plugin-Consent';
const digestPattern = /^[a-f0-9]{64}$/;

async function pluginPreviewRequest(article: number, revision: bigint, session: string, signal: AbortSignal,
  consent?: string): Promise<Response> {
  if (!Number.isInteger(article) || article < 1 || article > 2_147_483_647 ||
      revision < 1n || revision > 9_223_372_036_854_775_807n || !validSiteSessionId(session))
    throw new ProtocolError('Invalid signed plugin preview coordinates.');
  signal.throwIfAborted();
  const result = await fetch(`/api/v2/authoring/draft/${article}/plugin-preview.md?revision=${revision}${consent ? '' : '&consent=1'}`, {
    method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
    headers: { Accept: 'text/plain', [WireHeaders.CurrentSession]: session, ...(consent ? { [consentHeader]: consent } : {}) },
  });
  if (result.status !== (consent ? 200 : 204)) {
    await result.body?.cancel().catch(() => {});
    throw new ApiError('Signed plugin preview failed.', result.status);
  }

  const cache = result.headers.get('cache-control')?.toLowerCase().split(',').map(value => value.trim());
  if (!cache?.includes('private') || !cache.includes('no-store') ||
      result.headers.get('x-content-type-options')?.trim().toLowerCase() !== 'nosniff' ||
      result.headers.get('cross-origin-resource-policy')?.trim().toLowerCase() !== 'same-origin') {
    await result.body?.cancel().catch(() => {});
    throw new ProtocolError('Expected a private plain-text plugin preview.');
  }
  return result;
}

export async function reviewArticlePlugin(article: number, revision: bigint, session: string, signal: AbortSignal) {
  const { headers } = await pluginPreviewRequest(article, revision, session, signal);
  const token = headers.get(consentHeader), plugin = headers.get('X-Fsus-Plugin-Id');
  const version = headers.get('X-Fsus-Plugin-Version'), digest = headers.get('X-Fsus-Plugin-Digest');
  if (!token || !digestPattern.test(token) || !digest || !digestPattern.test(digest) ||
      !plugin || !/^[a-z0-9.-]{1,128}$/.test(plugin) || !version || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(version))
    throw new ProtocolError('Invalid signed plugin consent.');
  return { token, plugin, version, digest };
}

export async function previewArticlePlugin(article: number, revision: bigint, session: string,
  consent: string, signal: AbortSignal): Promise<string> {
  if (!digestPattern.test(consent)) throw new ProtocolError('Invalid signed plugin consent.');
  const result = await pluginPreviewRequest(article, revision, session, signal, consent);
  if (!plainUtf8.test(result.headers.get('content-type')?.trim() ?? '') || !result.body) {
    await result.body?.cancel().catch(() => {});
    throw new ProtocolError('Expected a private plain-text plugin preview.');
  }

  const reader = result.body.getReader();
  const bytes = new Uint8Array(maximumBytes);
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > maximumBytes - count)
        throw new ProtocolError('The signed plugin preview exceeds its byte limit.');
      bytes.set(value, count);
      count += value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof TypeError) throw new ProtocolError('The signed plugin preview is not valid UTF-8.');
    throw error;
  } finally {
    reader.releaseLock();
  }
}
