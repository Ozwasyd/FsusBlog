const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR = new Uint8Array([73, 72, 68, 82]);
const IDAT = new Uint8Array([73, 68, 65, 84]);
const IEND = new Uint8Array([73, 69, 78, 68]);
const OGG_CAPTURE = new Uint8Array([79, 103, 103, 83]);
const OPUS_HEAD = new Uint8Array([79, 112, 117, 115, 72, 101, 97, 100]);
const OPUS_TAGS = new Uint8Array([79, 112, 117, 115, 84, 97, 103, 115]);

const VISUAL_WIDTH = 384;
const VISUAL_HEIGHT = 144;

export function isCanonicalPerceptionCharacterV3Png(bytes: Uint8Array): boolean
{
    if (bytes.byteLength < 57 || !equalsAt(bytes, 0, PNG_SIGNATURE))
    {
        return false;
    }

    const header = readPngChunk(bytes, 8, IHDR);
    if (!header || header.data.byteLength !== 13)
    {
        return false;
    }
    const headerView = view(header.data);
    if (
        headerView.getUint32(0) !== VISUAL_WIDTH ||
    headerView.getUint32(4) !== VISUAL_HEIGHT ||
    header.data[8] !== 4 ||
    header.data[9] !== 0 ||
    header.data[10] !== 0 ||
    header.data[11] !== 0 ||
    header.data[12] !== 0
    )
    {
        return false;
    }

    const image = readPngChunk(bytes, header.nextOffset, IDAT);
    if (!image || !hasCanonicalCompressedImageEnvelope(image.data))
    {
        return false;
    }
    const end = readPngChunk(bytes, image.nextOffset, IEND);
    return Boolean(end && end.data.byteLength === 0 && end.nextOffset === bytes.byteLength);
}

export function isCanonicalPerceptionCharacterV3OpusOgg(bytes: Uint8Array): boolean
{
    let offset = 0;
    let serial: number | null = null;
    let sequence = 0;
    let previousGranule = 0n;
    let pageCount = 0;
    let sawTags = false;
    let sawAudio = false;
    let sawEos = false;

    while (offset < bytes.byteLength)
    {
        const page = readOggPage(bytes, offset, serial, sequence, previousGranule);
        if (!page)
        {
            return false;
        }
        serial ??= page.serial;
        sequence += 1;
        previousGranule = page.granule;
        offset = page.nextOffset;

        if (pageCount === 0)
        {
            if (page.headerType !== 2 || !isCanonicalOpusHead(page.body))
            {
                return false;
            }
        }
        else if (pageCount === 1)
        {
            if (page.headerType !== 0 || !isCanonicalOpusTags(page.body))
            {
                return false;
            }
            sawTags = true;
        }
        else
        {
            if ((page.headerType & ~4) !== 0 || page.body.byteLength === 0 || page.granule === 0n)
            {
                return false;
            }
            sawAudio = true;
            sawEos = (page.headerType & 4) !== 0;
            if (sawEos && offset !== bytes.byteLength)
            {
                return false;
            }
        }
        pageCount += 1;
    }

    return pageCount >= 3 && sawTags && sawAudio && sawEos;
}

function readPngChunk(
    bytes: Uint8Array,
    offset: number,
    expectedType: Uint8Array
): { data: Uint8Array; nextOffset: number; } | null
{
    if (offset < 0 || offset > bytes.byteLength - 12)
    {
        return null;
    }
    const length = view(bytes, offset, 4).getUint32(0);
    if (length > bytes.byteLength - offset - 12)
    {
        return null;
    }
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    if (!equalsAt(bytes, typeOffset, expectedType))
    {
        return null;
    }
    const data = bytes.subarray(dataOffset, crcOffset);
    const expectedCrc = view(bytes, crcOffset, 4).getUint32(0);
    if (expectedCrc !== pngCrc(bytes.subarray(typeOffset, typeOffset + 4), data))
    {
        return null;
    }
    return { data, nextOffset: crcOffset + 4 };
}

function hasCanonicalCompressedImageEnvelope(data: Uint8Array): boolean
{
    if (data.byteLength < 8 || data[0] !== 0x78 || data[1] !== 0xda)
    {
        return false;
    }
    const header = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
    return header % 31 === 0 && ((data[1] ?? 0) & 0x20) === 0;
}

function readOggPage(
    bytes: Uint8Array,
    offset: number,
    expectedSerial: number | null,
    expectedSequence: number,
    previousGranule: bigint
): {
    headerType: number;
    serial: number;
    granule: bigint;
    body: Uint8Array;
    nextOffset: number;
} | null
{
    if (
        offset < 0 ||
    offset > bytes.byteLength - 27 ||
    !equalsAt(bytes, offset, OGG_CAPTURE) ||
    bytes[offset + 4] !== 0
    )
    {
        return null;
    }
    const segmentCount = bytes[offset + 26] ?? 0;
    if (offset > bytes.byteLength - 27 - segmentCount)
    {
        return null;
    }
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1)
    {
        bodyLength += bytes[offset + 27 + index] ?? 0;
    }
    const pageLength = 27 + segmentCount + bodyLength;
    if (offset > bytes.byteLength - pageLength)
    {
        return null;
    }
    const pageBytes = bytes.subarray(offset, offset + pageLength);
    const pageView = view(pageBytes);
    const serial = pageView.getUint32(14, true);
    const sequence = pageView.getUint32(18, true);
    const granule = pageView.getBigUint64(6, true);
    const checksum = pageView.getUint32(22, true);
    if (
        (expectedSerial !== null && serial !== expectedSerial) ||
    sequence !== expectedSequence ||
    granule < previousGranule ||
    checksum !== oggCrc(pageBytes)
    )
    {
        return null;
    }
    return {
        headerType: pageBytes[5] ?? 0,
        serial,
        granule,
        body: pageBytes.subarray(27 + segmentCount),
        nextOffset: offset + pageLength
    };
}

function isCanonicalOpusHead(packet: Uint8Array): boolean
{
    if (packet.byteLength !== 19 || !equalsAt(packet, 0, OPUS_HEAD))
    {
        return false;
    }
    const packetView = view(packet);
    return packet[8] === 1 &&
    packet[9] === 1 &&
    packetView.getUint16(10, true) === 312 &&
    packetView.getUint32(12, true) === 48_000 &&
    packetView.getInt16(16, true) === 0 &&
    packet[18] === 0;
}

function isCanonicalOpusTags(packet: Uint8Array): boolean
{
    if (packet.byteLength < 16 || !equalsAt(packet, 0, OPUS_TAGS))
    {
        return false;
    }
    const packetView = view(packet);
    const vendorLength = packetView.getUint32(8, true);
    return vendorLength <= packet.byteLength - 16 &&
    packet.byteLength === 16 + vendorLength &&
    packetView.getUint32(12 + vendorLength, true) === 0;
}

function pngCrc(type: Uint8Array, data: Uint8Array): number
{
    let crc = 0xffffffff;
    for (const value of type)
    {
        crc = pngCrcByte(crc, value);
    }
    for (const value of data)
    {
        crc = pngCrcByte(crc, value);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngCrcByte(initial: number, value: number): number
{
    let crc = (initial ^ value) >>> 0;
    for (let bit = 0; bit < 8; bit += 1)
    {
        crc = ((crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320)) >>> 0;
    }
    return crc;
}

function oggCrc(page: Uint8Array): number
{
    let crc = 0;
    for (let index = 0; index < page.byteLength; index += 1)
    {
        const value = index >= 22 && index <= 25 ? 0 : (page[index] ?? 0);
        crc = (crc ^ (value << 24)) >>> 0;
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = ((crc << 1) ^ ((crc & 0x80000000) === 0 ? 0 : 0x04c11db7)) >>> 0;
        }
    }
    return crc;
}

function equalsAt(bytes: Uint8Array, offset: number, expected: Uint8Array): boolean
{
    if (offset < 0 || offset + expected.byteLength > bytes.byteLength)
    {
        return false;
    }
    return expected.every((value, index) => bytes[offset + index] === value);
}

function view(bytes: Uint8Array, offset = 0, length = bytes.byteLength - offset): DataView
{
    return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}
