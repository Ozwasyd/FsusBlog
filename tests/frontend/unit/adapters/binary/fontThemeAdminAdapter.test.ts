import { describe, expect, it } from 'vitest'
import {
    mapFontActivationListFromPayload,
    mapFontRegistryDetailFromPayload,
    mapFontRegistryListFromPayload,
    mapThemeActivationFromPayload,
    mapThemeActivationHistoryFromPayload,
    mapThemeActivationListFromPayload,
    mapThemeRegistryDetailFromPayload,
    mapThemeRegistryListFromPayload
} from '@/adapters/binary/fontThemeAdminAdapter'

const installedAt = Date.UTC(2026, 8, 1, 12, 30)
const updatedAt = Date.UTC(2026, 8, 2, 13, 45, 1)
const encoder = new TextEncoder()

interface SliceRef {
    offset: number
    length: number
}

class BlobBuilder {
    private readonly chunks: Uint8Array[] = []
    private length = 0

    text(value: string): SliceRef {
        const bytes = encoder.encode(value)
        const result = { offset: this.length, length: bytes.byteLength }
        this.chunks.push(bytes)
        this.length += bytes.byteLength
        return result
    }

    bytes(): Uint8Array {
        const result = new Uint8Array(this.length)
        let cursor = 0
        for (const chunk of this.chunks) {
            result.set(chunk, cursor)
            cursor += chunk.byteLength
        }
        return result
    }
}

class RecordBuilder {
    readonly bytes: Uint8Array
    private readonly view: DataView

    constructor(size: number) {
        this.bytes = new Uint8Array(size)
        this.view = new DataView(this.bytes.buffer)
    }

    int32(offset: number, value: number): this {
        this.view.setInt32(offset, value, true)
        return this
    }

    int64(offset: number, value: number | bigint): this {
        this.view.setBigInt64(offset, BigInt(value), true)
        return this
    }

    byte(offset: number, value: number): this {
        this.bytes[offset] = value
        return this
    }

    slice(offset: number, reference: SliceRef): this {
        return this.int32(offset, reference.offset).int32(offset + 4, reference.length)
    }
}

function envelope(records: Uint8Array[], blob: Uint8Array, count = records.length): Uint8Array {
    const bodyLength = records.reduce((total, record) => total + record.byteLength, 0) + 4 + blob.byteLength
    const result = new Uint8Array(16 + bodyLength)
    const view = new DataView(result.buffer)
    view.setInt32(0, 1, true)
    view.setInt32(4, count, true)
    view.setInt32(8, bodyLength, true)
    let cursor = 16
    for (const record of records) {
        result.set(record, cursor)
        cursor += record.byteLength
    }
    view.setInt32(cursor, blob.byteLength, true)
    result.set(blob, cursor + 4)
    return result
}

function fontSummary(blob: BlobBuilder): Uint8Array {
    return new RecordBuilder(76)
        .int64(0, installedAt)
        .int64(8, updatedAt)
        .int64(16, 10)
        .int32(24, 1)
        .int32(28, 1)
        .byte(32, 1)
        .byte(34, 1)
        .slice(36, blob.text('font-a'))
        .slice(44, blob.text('Font A'))
        .slice(52, blob.text('Font Family'))
        .slice(60, blob.text('sans-serif'))
        .slice(68, blob.text('1.0.0'))
        .bytes
}

function themeSummary(blob: BlobBuilder): Uint8Array {
    return new RecordBuilder(84)
        .int64(0, installedAt)
        .int64(8, updatedAt)
        .byte(16, 1)
        .byte(17, 4)
        .slice(20, blob.text('theme-a'))
        .slice(28, blob.text('Theme A'))
        .slice(36, blob.text('1.0.0'))
        .slice(44, blob.text('FsusBlog'))
        .slice(52, blob.text('Theme description'))
        .slice(60, blob.text('visual'))
        .slice(68, blob.text('sha256:theme'))
        .slice(76, blob.text('/themes/theme-a'))
        .bytes
}

function themeActivation(blob: BlobBuilder, populated = true): Uint8Array {
    const record = new RecordBuilder(64)
        .int64(0, populated ? 9 : 0)
        .int64(8, populated ? updatedAt : 0)
        .byte(16, populated ? 1 : 0)
        .byte(17, populated ? 1 : 0)
        .byte(18, populated ? 1 : 0)
        .byte(19, populated ? 1 : 0)
        .byte(20, populated ? 1 : 0)
        .byte(21, populated ? 1 : 0)
        .slice(24, blob.text(populated ? 'public' : 'admin'))
    if (!populated) return record.bytes
    return record
        .slice(32, blob.text('theme-a'))
        .slice(40, blob.text('dark'))
        .slice(48, blob.text('01234567-89ab-cdef-0123-456789abcdef'))
        .slice(56, blob.text('asset-v1'))
        .bytes
}

describe('Font/Theme administration POD adapters', () => {
    it('decodes the Font registry list and rejects non-canonical UTF-8 slices', () => {
        const blob = new BlobBuilder()
        const payload = envelope([fontSummary(blob)], blob.bytes())

        expect(mapFontRegistryListFromPayload(payload)).toEqual([expect.objectContaining({
            fontId: 'font-a', installState: 'installed', faceCount: 1, installedAt: new Date(installedAt).toISOString()
        })])

        const invalidSlice = payload.slice()
        new DataView(invalidSlice.buffer).setInt32(16 + 36, 1, true)
        expect(() => mapFontRegistryListFromPayload(invalidSlice)).toThrow()

        const invalidUtf8 = payload.slice()
        invalidUtf8[16 + 76 + 4] = 0xff
        expect(() => mapFontRegistryListFromPayload(invalidUtf8)).toThrow()
    })

    it('decodes the Font detail and activation list closed layouts', () => {
        const detailBlob = new BlobBuilder()
        const summary = fontSummary(detailBlob)
        const detail = new Uint8Array(100)
        detail.set(summary)
        const detailRecord = new RecordBuilder(100)
        detailRecord.bytes.set(detail)
        detailRecord
            .slice(76, detailBlob.text('OFL'))
            .slice(84, detailBlob.text('{"source":"bundled"}'))
            .slice(92, detailBlob.text('{"id":"font-a"}'))
        const face = new RecordBuilder(56)
            .int64(0, 10)
            .int32(8, 400)
            .byte(12, 1)
            .slice(16, detailBlob.text('normal'))
            .slice(24, detailBlob.text('regular.woff2'))
            .slice(32, detailBlob.text('sha256:a'))
            .slice(48, detailBlob.text('swap'))
            .bytes

        const detailPayload = envelope([detailRecord.bytes, face], detailBlob.bytes(), 1)
        expect(mapFontRegistryDetailFromPayload(detailPayload)).toEqual(
            expect.objectContaining({ fontId: 'font-a', licenseText: 'OFL', faces: [expect.objectContaining({ unicodeRange: null })] })
        )

        const zeroWeight = detailPayload.slice()
        new DataView(zeroWeight.buffer).setInt32(16 + 100 + 8, 0, true)
        expect(() => mapFontRegistryDetailFromPayload(zeroWeight)).toThrow()

        const activationBlob = new BlobBuilder()
        const activation = new RecordBuilder(64)
            .int64(0, 7)
            .int64(8, updatedAt)
            .slice(16, activationBlob.text('admin'))
            .slice(24, activationBlob.text('font-a'))
            .slice(32, activationBlob.text('font-a'))
            .slice(40, activationBlob.text('font-code'))
            .slice(48, activationBlob.text('font-cjk'))
            .slice(56, activationBlob.text('font-emoji'))
            .bytes
        expect(mapFontActivationListFromPayload(envelope([activation], activationBlob.bytes()))).toEqual([
            expect.objectContaining({ scope: 'admin', configVersion: '7', emojiFontId: 'font-emoji' })
        ])
    })

    it('decodes the Theme registry list and detail closed layouts', () => {
        const listBlob = new BlobBuilder()
        expect(mapThemeRegistryListFromPayload(envelope([themeSummary(listBlob)], listBlob.bytes()))).toEqual([
            expect.objectContaining({ themeId: 'theme-a', installState: 'Enabled', enabled: true })
        ])

        const detailBlob = new BlobBuilder()
        const detail = new RecordBuilder(148)
        detail
            .int64(0, installedAt)
            .int64(8, updatedAt)
            .int64(16, 100)
            .int64(24, 200)
            .int64(32, 300)
            .int32(40, 400)
            .int32(44, 4)
            .int32(48, 5)
            .int32(52, 600)
            .byte(56, 1)
            .byte(57, 4)
            .byte(58, 1)
            .byte(59, 1)
            .byte(61, 1)
            .byte(63, 1)
            .byte(65, 1)
            .slice(68, detailBlob.text('theme-a'))
            .slice(76, detailBlob.text('Theme A'))
            .slice(84, detailBlob.text('1.0.0'))
            .slice(92, detailBlob.text('FsusBlog'))
            .slice(100, detailBlob.text('Theme description'))
            .slice(108, detailBlob.text('visual'))
            .slice(116, detailBlob.text('sha256:theme'))
            .slice(124, detailBlob.text('/themes/theme-a'))
            .slice(132, detailBlob.text('{"id":"theme-a"}'))
            .slice(140, detailBlob.text('{"type":"object"}'))
        const light = new RecordBuilder(8).slice(0, detailBlob.text('light')).bytes
        const dark = new RecordBuilder(8).slice(0, detailBlob.text('dark')).bytes

        expect(mapThemeRegistryDetailFromPayload(envelope([detail.bytes, light, dark], detailBlob.bytes(), 2))).toEqual(
            expect.objectContaining({
                themeId: 'theme-a', modes: ['light', 'dark'],
                supports: expect.objectContaining({ public: true, admin: true }),
                budgets: expect.objectContaining({ cssBytes: '100', previewBytes: '300' }),
                permissions: expect.objectContaining({ network: true })
            })
        )
    })

    it('decodes Theme activation list and singleton nullability without fallback', () => {
        const listBlob = new BlobBuilder()
        const populated = themeActivation(listBlob)
        expect(mapThemeActivationListFromPayload(envelope([populated], listBlob.bytes()))).toEqual([
            expect.objectContaining({ activeThemeId: 'theme-a', activationId: '01234567-89ab-cdef-0123-456789abcdef', configVersion: '9' })
        ])

        const singletonBlob = new BlobBuilder()
        const missing = themeActivation(singletonBlob, false)
        expect(mapThemeActivationFromPayload(envelope([missing], singletonBlob.bytes()))).toEqual({
            scope: 'admin', activeThemeId: null, mode: null, activationId: null,
            assetVersion: null, configVersion: null, updatedAtUtc: null
        })

        const invalidAbsent = envelope([missing], singletonBlob.bytes())
        new DataView(invalidAbsent.buffer).setInt32(16 + 32, 1, true)
        expect(() => mapThemeActivationFromPayload(invalidAbsent)).toThrow()
    })

    it('preserves full signed 64-bit nonnegative values as decimal strings', () => {
        const maximum = 9223372036854775807n
        const blob = new BlobBuilder()
        const payload = envelope([fontSummary(blob)], blob.bytes())
        new DataView(payload.buffer).setBigInt64(16 + 16, maximum, true)
        expect(mapFontRegistryListFromPayload(payload)[0]?.totalSizeBytes).toBe(maximum.toString())

        const activationBlob = new BlobBuilder()
        const activation = envelope([themeActivation(activationBlob)], activationBlob.bytes())
        new DataView(activation.buffer).setBigInt64(16, maximum, true)
        expect(mapThemeActivationFromPayload(activation).configVersion).toBe(maximum.toString())
        new DataView(activation.buffer).setBigInt64(16, -1n, true)
        expect(() => mapThemeActivationFromPayload(activation)).toThrow()
    })

    it.each(['version', 'count', 'reserved', 'truncated', 'trailing', 'timestamp', 'boolean', 'length'])(
        'rejects a non-canonical Font list %s', mutation => {
            const blob = new BlobBuilder()
            let payload = envelope([fontSummary(blob)], blob.bytes())
            const view = new DataView(payload.buffer)
            if (mutation === 'version') view.setInt32(0, 2, true)
            if (mutation === 'count') view.setInt32(4, 1025, true)
            if (mutation === 'reserved') view.setInt32(12, 1, true)
            if (mutation === 'timestamp') view.setBigInt64(16, 253402300800000n, true)
            if (mutation === 'boolean') payload[16 + 32] = 2
            if (mutation === 'length') view.setInt32(16 + 36 + 4, -1, true)
            if (mutation === 'truncated') payload = payload.slice(0, -1)
            if (mutation === 'trailing') payload = new Uint8Array([...payload, 0])
            expect(() => mapFontRegistryListFromPayload(payload)).toThrow()
        }
    )

    it('rejects a non-canonical GUID and nonzero absent scalar', () => {
        const blob = new BlobBuilder()
        const payload = envelope([themeActivation(blob)], blob.bytes())
        const view = new DataView(payload.buffer)
        const idOffset = view.getInt32(16 + 48, true)
        payload[16 + 64 + 4 + idOffset + 10] = 'A'.charCodeAt(0)
        expect(() => mapThemeActivationFromPayload(payload)).toThrow()

        const missingBlob = new BlobBuilder()
        const missing = envelope([themeActivation(missingBlob, false)], missingBlob.bytes())
        new DataView(missing.buffer).setBigInt64(16, 1n, true)
        expect(() => mapThemeActivationFromPayload(missing)).toThrow()
    })

    it('decodes Theme activation history and rejects unknown enum values', () => {
        const blob = new BlobBuilder()
        const history = new RecordBuilder(124)
            .int64(0, 9)
            .int64(16, installedAt)
            .int64(24, updatedAt)
            .byte(32, 1)
            .byte(34, 1)
            .byte(36, 1)
            .byte(38, 1)
            .byte(41, 1)
            .slice(44, blob.text('fedcba98-7654-3210-fedc-ba9876543210'))
            .slice(52, blob.text('public'))
            .slice(60, blob.text('theme-a'))
            .slice(76, blob.text('asset-v1'))
            .slice(92, blob.text('dark'))
            .slice(116, blob.text('admin@example.test'))
            .bytes
        const payload = envelope([history], blob.bytes())

        expect(mapThemeActivationHistoryFromPayload(payload)).toEqual([
            expect.objectContaining({ id: 'fedcba98-7654-3210-fedc-ba9876543210', status: 'Applied', previousThemeId: null })
        ])

        const unknownStatus = payload.slice()
        unknownStatus[16 + 41] = 99
        expect(() => mapThemeActivationHistoryFromPayload(unknownStatus)).toThrow()
    })
})
