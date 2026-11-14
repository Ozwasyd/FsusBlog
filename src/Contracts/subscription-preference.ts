import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { encodeSubscriptionPreferenceRequest, FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

export type SubscriptionChannel = 'rss' | 'email';

function writePreference(path: string, email: string, channel: SubscriptionChannel, signal?: AbortSignal, headers?: HeadersInit): Promise<void> {
  if (email.length === 0 || email.length > WireLimits.SubscriptionEmailBytes || /[^!-~]/.test(email))
    throw new ProtocolError('Invalid subscription preference request');
  const channelCode = channel === 'rss' ? WireLayouts.SubscriptionRssChannel :
    channel === 'email' ? WireLayouts.SubscriptionEmailChannel : undefined;
  if (channelCode === undefined) throw new ProtocolError('Invalid subscription preference request');

  const frame = encodeFrame(FrameType.SubscriptionPreferenceRequest, encodeSubscriptionPreferenceRequest({ email, channel: channelCode }));
  return request(path, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', frame, headers, 'omit');
}

export function enrollSubscription(email: string, channel: SubscriptionChannel, signal?: AbortSignal): Promise<void> {
  return writePreference(WireRoutes.SubscriptionEnroll, email, channel, signal);
}

export function cancelSubscription(email: string, channel: SubscriptionChannel, proof: string, signal?: AbortSignal): Promise<void> {
  if (proof.length !== WireLimits.SubscriptionProofChars || /[^0-9a-f]/.test(proof))
    throw new ProtocolError('Invalid subscription proof');
  return writePreference(WireRoutes.SubscriptionCancel, email, channel, signal, { [WireHeaders.SubscriptionProof]: proof });
}
