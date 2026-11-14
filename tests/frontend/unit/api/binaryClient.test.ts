import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decode } from '@wasm/aeds'
import { AEDS_HEADER_LENGTH, FrameType } from '@wasm/protocol/frame'
import { binaryRequest } from '@/api/binaryApiClient'
import { encodeAedsFrame } from '@/api/binaryFrame'
import { getFontRegistry } from '@/api/fontAdmin'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import { privateRequestRuntime } from '@/services/privateRequestRuntime'

vi.mock('@/api/binaryApiClient', async importOriginal => ({
    ...await importOriginal<typeof import('@/api/binaryApiClient')>(),
    binaryRequest: vi.fn()
}))

const binaryRequestMock = vi.mocked(binaryRequest)

beforeEach(() => {
    privateRequestRuntime.resetForTests()
    binaryRequestMock.mockReset()
    vi.mocked(decode).mockImplementation((buffer: ArrayBuffer) => {
        const payload = new Uint8Array(buffer).subarray(AEDS_HEADER_LENGTH)
        return {
            ok: true, frameType: new DataView(buffer).getUint16(8, true) as FrameType,
            payload, payloadView: payload, textBlob: '', error: ''
        }
    })
})

afterEach(() => {
    privateRequestRuntime.resetForTests()
})

describe('typed Font administration private request generation', () => {
    it('uses an administrator lease signal and decodes the current typed response', async () => {
        const payload = new Uint8Array(20)
        const view = new DataView(payload.buffer)
        view.setInt32(0, 1, true)
        view.setInt32(8, 4, true)
        binaryRequestMock.mockResolvedValue(encodeAedsFrame(FrameType.FontRegistryList, payload))

        await expect(getFontRegistry()).resolves.toEqual([])
        expect(binaryRequestMock).toHaveBeenCalledWith('/api/binary/author/ops/fonts/registry', expect.objectContaining({
            signal: expect.any(AbortSignal)
        }))
        expect(binaryRequestMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    })

    it('aborts a deferred administrator transport and drops its stale response before POD decoding', async () => {
        let resolveResponse!: (value: ArrayBuffer) => void
        let transportSignal: RequestInit['signal']
        binaryRequestMock.mockImplementation(async (_url, options) => {
            transportSignal = options?.signal
            return await new Promise<ArrayBuffer>(resolve => { resolveResponse = resolve })
        })
        const pending = getFontRegistry()
        const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(transportSignal).toBeDefined())
        privateRequestRuntime.advance('admin')
        expect(transportSignal?.aborted).toBe(true)
        resolveResponse(new Uint8Array([0xff]).buffer)
        await refused
    })

    it('forwards a caller abort through the administrator lease signal', async () => {
        const caller = new AbortController()
        let transportSignal: RequestInit['signal']
        binaryRequestMock.mockImplementation(async (_url, options) => {
            transportSignal = options?.signal
            return await new Promise<ArrayBuffer>((_resolve, reject) => {
                transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true })
            })
        })
        const pending = requestBinaryOnly({
            binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry' },
            frameType: FrameType.FontRegistryList,
            privateScope: 'admin',
            signal: caller.signal
        })
        const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(transportSignal).toBeDefined())
        caller.abort(new DOMException('caller cancelled', 'AbortError'))
        expect(transportSignal?.aborted).toBe(true)
        await refused
    })
})
