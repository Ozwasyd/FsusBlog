import { describe, expect, it } from 'vitest'
import { encodeAuthoringJsonRequest, mapAuthoringJsonFromPayload } from '@/adapters/binary/authoringAdapter'

describe('authoring binary adapter', () => {
  it('round-trips typed authoring payload JSON bytes inside AEDS payloads', () => {
    const encoded = encodeAuthoringJsonRequest({
      title: 'Draft',
      status: 0,
      tagIds: [1, 2]
    })

    expect(mapAuthoringJsonFromPayload(encoded)).toEqual({
      title: 'Draft',
      status: 0,
      tagIds: [1, 2]
    })
  })

  it('rejects malformed payload bytes', () => {
    expect(() => mapAuthoringJsonFromPayload(new Uint8Array([0xff, 0xff]))).toThrow()
  })
})
