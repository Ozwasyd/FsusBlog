const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer>
{
    return UTF8_ENCODER.encode(value);
}

export function decodeUtf8(bytes: BufferSource): string
{
    if (bytes instanceof ArrayBuffer)
    {
        return UTF8_DECODER.decode(new Uint8Array(bytes));
    }

    return UTF8_DECODER.decode(bytes);
}
