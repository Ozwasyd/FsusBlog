import { encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import {
  decodeSiteDisplayNameState,
  encodeSiteDisplayNameCommand,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
} from './wire.generated.ts';

const encoder = new TextEncoder();
const controlChars = /[\u0000-\u001F\u007F-\u009F]/;

export function validSiteDisplayName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || controlChars.test(trimmed)) return false;
  if (Array.from(trimmed).length > WireLimits.SiteDisplayNameChars) return false;
  return encoder.encode(trimmed).byteLength <= WireLimits.PublicCommentHandleBytes;
}

export function readSiteDisplayName(currentSessionId: string, signal?: AbortSignal): Promise<string> {
  return request(WireRoutes.SiteDisplayName, FrameType.SiteDisplayNameState, payload => {
    const state = decodeSiteDisplayNameState(payload);
    if (state.displayName.length > 0 && !validSiteDisplayName(state.displayName))
      throw new ProtocolError('Invalid site display name state.');
    return state.displayName;
  }, signal, 'GET', undefined, { [WireHeaders.CurrentSession]: currentSessionId });
}

export async function updateSiteDisplayName(currentSessionId: string, displayName: string, signal?: AbortSignal): Promise<string> {
  const trimmed = displayName.trim();
  if (!validSiteDisplayName(trimmed)) throw new ProtocolError('Invalid site display name.');
  const body = encodeFrame(FrameType.SiteDisplayNameCommand, encodeSiteDisplayNameCommand({ displayName: trimmed }));
  return request(WireRoutes.SiteDisplayName, FrameType.SiteDisplayNameState, payload => {
    const state = decodeSiteDisplayNameState(payload);
    if (state.displayName !== trimmed) throw new ProtocolError('Unexpected site display name response.');
    return state.displayName;
  }, signal, 'POST', body, { [WireHeaders.CurrentSession]: currentSessionId });
}
