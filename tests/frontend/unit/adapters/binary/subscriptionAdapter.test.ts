import { describe, expect, it } from 'vitest'
import { writeFixedUtf8 } from '@/api/binaryFrame'
import { mapSiteSubscriptionResponseFromPayload } from '@/adapters/binary/subscriptionAdapter'

describe('binary subscription adapter', () => {
  it('decodes subscription response pods', () => {
    const payload = new Uint8Array(36)
    payload[0] = 1
    payload[1] = 0
    writeFixedUtf8(payload, 4, 32, 'email')

    expect(mapSiteSubscriptionResponseFromPayload(payload)).toEqual({
      subscribed: true,
      unsubscribed: false,
      channel: 'email'
    })
  })

  it('rejects invalid subscription response flags', () => {
    const payload = new Uint8Array(36)
    payload[0] = 2

    expect(() => mapSiteSubscriptionResponseFromPayload(payload)).toThrow('site_subscription_response_flag_invalid')
  })
})
