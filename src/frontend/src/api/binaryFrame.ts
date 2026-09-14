import type { FrameType } from '@wasm/protocol/frame';
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION } from '@wasm/protocol/frame';

const textEncoder = new TextEncoder();
const crc16Table = createCrc16Table();

export interface AedsEncodeCostMetrics {
    frameBytes: number;
    payloadBytes: number;
    crcMs: number;
    totalMs: number;
    copiedPayloadBytes: number;
}

export function encodeAedsFrame(frameType: FrameType, payload: Uint8Array): ArrayBuffer
{
    return encodeAedsFrameWithMetrics(frameType, payload).buffer;
}

export function encodeAedsFrameWithMetrics(frameType: FrameType, payload: Uint8Array): { buffer: ArrayBuffer; metrics: AedsEncodeCostMetrics; }
{
    const started = now();
    const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength);
    const view = new DataView(frame.buffer);
    const crcStarted = now();
    const crc = crc16(payload);
    const crcMs = now() - crcStarted;
    view.setUint32(0, AEDS_MAGIC, true);
    view.setUint8(4, AEDS_VERSION);
    view.setUint8(5, AEDS_HEADER_LENGTH);
    view.setUint16(6, 0, true);
    view.setUint16(8, frameType, true);
    view.setUint32(10, payload.byteLength, true);
    view.setUint16(14, crc, true);
    frame.set(payload, AEDS_HEADER_LENGTH);
    return {
        buffer: frame.buffer,
        metrics: {
            frameBytes: frame.byteLength,
            payloadBytes: payload.byteLength,
            crcMs,
            totalMs: now() - started,
            copiedPayloadBytes: payload.byteLength
        }
    };
}

export function encodeNameMutationRequest(name: string): Uint8Array
{
    const bytes = new Uint8Array(128);
    writeFixedUtf8(bytes, 0, 128, name);
    return bytes;
}

export interface TaxonomyMetadataMutationRequest {
    name: string;
    description: string | null;
}

export function encodeTaxonomyMetadataMutationRequest(request: TaxonomyMetadataMutationRequest): Uint8Array
{
    const description = textEncoder.encode(request.description ?? '');
    const bytes = new Uint8Array(140 + description.byteLength);
    const view = new DataView(bytes.buffer);
    writeFixedUtf8(bytes, 0, 128, request.name);
    view.setInt32(128, 0, true);
    view.setInt32(132, description.byteLength, true);
    view.setInt32(136, description.byteLength, true);
    bytes.set(description, 140);
    return bytes;
}

export function encodeStringMutationRequest(value: string): Uint8Array
{
    const encoded = textEncoder.encode(value);
    const bytes = new Uint8Array(8 + 4 + encoded.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, encoded.byteLength, true);
    view.setInt32(8, encoded.byteLength, true);
    bytes.set(encoded, 12);
    return bytes;
}

export function encodePasskeyCredentialFriendlyNameUpdateRequest(friendlyName: string): Uint8Array
{
    const encoded = textEncoder.encode(friendlyName);
    const bytes = new Uint8Array(8 + 4 + encoded.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, encoded.byteLength, true);
    view.setInt32(8, encoded.byteLength, true);
    bytes.set(encoded, 12);
    return bytes;
}

export function encodeUserLocalePreferenceUpdateRequest(
    mode: 'auto' | 'fixed',
    fixedLocale: string | null,
    expectedRevision: number
): Uint8Array
{
    const localeWireValues: Readonly<Record<string, number>> = {
        'zh-CN': 1,
        'en-US': 2,
        'zh-Hant': 3,
        'ja-JP': 4,
        'ko-KR': 5,
        'es-419': 6,
        'fr-FR': 7,
        'de-DE': 8,
        'pt-BR': 9,
        'ru-RU': 10
    };
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(0, BigInt(expectedRevision), true);
    view.setUint8(8, mode === 'fixed' ? 2 : 1);
    view.setUint8(9, mode === 'fixed' ? 1 : 0);
    view.setUint8(10, mode === 'fixed' && fixedLocale ? (localeWireValues[fixedLocale] ?? 0) : 0);
    return bytes;
}

export function writeFixedUtf8(target: Uint8Array, offset: number, length: number, value: string): void
{
    const encoded = textEncoder.encode(value);
    target.set(encoded.subarray(0, length), offset);
}

export function crc16(bytes: Uint8Array): number
{
    let crc = 0xffff;
    for (let i = 0; i < bytes.byteLength; i += 1)
    {
        crc = (crc >>> 8) ^ crc16Table[(crc ^ (bytes[i] ?? 0)) & 0xff];
    }
    return crc & 0xffff;
}

function createCrc16Table(): Uint16Array
{
    const table = new Uint16Array(256);
    for (let i = 0; i < table.length; i += 1)
    {
        let crc = i;
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
        }
        table[i] = crc & 0xffff;
    }
    return table;
}

function now(): number
{
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
