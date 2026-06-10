import { describe, expect, it } from 'vitest'
import { encodeSecurityJsonRequest, mapSecurityJsonFromPayload } from '@/adapters/binary/securityAdapter'

describe('security binary JSON adapter', () => {
  it('round-trips request and response JSON payloads', () => {
    const payload = encodeSecurityJsonRequest({ mode: 'observe', reason: 'test' })

    expect(mapSecurityJsonFromPayload(payload)).toEqual({ mode: 'observe', reason: 'test' })
  })

  it('reports malformed JSON payloads as protocol failures', () => {
    expect(() => mapSecurityJsonFromPayload(new Uint8Array([0xff]))).toThrow('security_json_payload_invalid')
  })
})
