import { AppErrorCode, createAppError } from '@/utils/appError'
import type { SiteSubscriptionResponse } from '@/api/subscription'
import { readFixedUtf8 } from './reader'

const SITE_SUBSCRIPTION_RESPONSE_POD_SIZE = 36

export function mapSiteSubscriptionResponseFromPayload(payload: Uint8Array): SiteSubscriptionResponse {
  if (payload.byteLength !== SITE_SUBSCRIPTION_RESPONSE_POD_SIZE) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'site_subscription_response_size_invalid')
  }

  const subscribed = payload[0] ?? 0
  const unsubscribed = payload[1] ?? 0
  if (subscribed > 1 || unsubscribed > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'site_subscription_response_flag_invalid')
  }

  return {
    subscribed: subscribed === 1,
    unsubscribed: unsubscribed === 1,
    channel: readFixedUtf8(payload, 4, 32)
  }
}
