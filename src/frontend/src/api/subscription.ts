import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
    SiteSubscriptionRequest,
    SiteSubscriptionRequestConfig,
    SiteSubscriptionResponse
} from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame, writeFixedUtf8 } from './binaryFrame';

export type { SiteSubscriptionRequest, SiteSubscriptionRequestConfig, SiteSubscriptionResponse } from '@/contracts/binaryApi';

export async function subscribeToSiteUpdates(
    request: SiteSubscriptionRequest,
    config: SiteSubscriptionRequestConfig = {}
): Promise<SiteSubscriptionResponse>
{
    return await sendSiteSubscriptionRequest('POST', request, config);
}

export async function unsubscribeFromSiteUpdates(
    request: SiteSubscriptionRequest,
    config: SiteSubscriptionRequestConfig = {}
): Promise<SiteSubscriptionResponse>
{
    return await sendSiteSubscriptionRequest('DELETE', request, config);
}

async function sendSiteSubscriptionRequest(
    method: 'POST' | 'DELETE',
    request: SiteSubscriptionRequest,
    config: SiteSubscriptionRequestConfig
): Promise<SiteSubscriptionResponse>
{
    return await requestBinaryOnly<SiteSubscriptionResponse>({
        binaryRoute: { operationId: method === 'POST' ? 'binary_post_subscriptions' : 'binary_delete_subscriptions' },
        frameType: FrameType.SiteSubscriptionResponse,
        signal: config.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.SiteSubscriptionRequest, encodeSiteSubscriptionRequest(request))
        }
    });
}

function encodeSiteSubscriptionRequest(request: SiteSubscriptionRequest): Uint8Array
{
    const payload = new Uint8Array(288);
    writeFixedUtf8(payload, 0, 256, request.email);
    writeFixedUtf8(payload, 256, 32, request.channel ?? 'email');
    return payload;
}
