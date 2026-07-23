import { createHmac } from 'node:crypto';

export function encodeVisualArtifact(contract, gray8, artifactSeed)
{
    const { physicalWidth: width, physicalHeight: height, noise } = contract.raster;
    if (!Buffer.isBuffer(gray8) || gray8.length !== width * height)
        throw new Error('visual source has invalid dimensions');
    const random = deterministicStream(artifactSeed);
    const biases = Array.from({ length: height / noise.cellHeightPixels }, () =>
        Array.from({ length: width / noise.cellWidthPixels }, () => random.integer(noise.levelBiasMin, noise.levelBiasMax)));
    const scanlines = Buffer.alloc(height * (1 + width / 2));
    for (let y = 0; y < height; y += 1)
    {
        const row = y * (1 + width / 2);
        for (let x = 0; x < width; x += 2)
        {
            const biasRow = biases[Math.floor(y / noise.cellHeightPixels)];
            const first = quantize(gray8[y * width + x], biasRow[Math.floor(x / noise.cellWidthPixels)]);
            const second = quantize(gray8[y * width + x + 1], biasRow[Math.floor((x + 1) / noise.cellWidthPixels)]);
            scanlines[row + 1 + x / 2] = (first << 4) | second;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([4, 0, 0, 0, 0], 8);
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
        chunk('IDAT', zlibStored(scanlines)), chunk('IEND', Buffer.alloc(0))]);
    if (png.length > contract.media.visual.maximumBytes)
        throw new Error('visual artifact exceeds canonical hard limit');
    return png;
}

export function buildAudioArtifactVector(contract)
{
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.set([1, 1], 8);
    head.writeUInt16LE(contract.media.audio.preSkip, 10);
    head.writeUInt32LE(contract.media.audio.inputSampleRate, 12);
    head.writeInt16LE(contract.media.audio.outputGainQ8, 16);
    head[18] = contract.media.audio.mappingFamily;
    const vendor = Buffer.from('FsusBlog reference vector', 'utf8');
    const tags = Buffer.alloc(16 + vendor.length);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    const packets = [Buffer.from('f8fffe', 'hex'), Buffer.from('f8fffe', 'hex')];
    return Buffer.concat([oggPage(0, 0, 2, [head]), oggPage(1, 0, 0, [tags]), oggPage(2, 1920, 4, packets)]);
}

function deterministicStream(seed)
{
    if (!Buffer.isBuffer(seed) || seed.length !== 32)
        throw new Error('artifact seed must be 32 bytes');
    let counter = 0;
    let available = Buffer.alloc(0);
    return { integer(minimum, maximum)
    {
        const span = maximum - minimum + 1;
        const limit = Math.floor(0x100000000 / span) * span;
        for (;;)
        {
            if (available.length < 4)
            {
                const block = Buffer.alloc(4);
                block.writeUInt32BE(counter++);
                available = createHmac('sha256', seed)
                    .update(Buffer.from('fsus.perception-character.raster.v3\0', 'ascii')).update(block).digest();
            }
            const candidate = available.readUInt32BE();
            available = available.subarray(4);
            if (candidate < limit)
                return minimum + (candidate % span);
        }
    } };
}

function quantize(gray8, bias)
{
    return Math.max(0, Math.min(15, Math.round(gray8 * 15 / 255) + bias));
}

function chunk(type, data)
{
    const name = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
}

function zlibStored(data)
{
    const block = Buffer.alloc(5 + data.length);
    block[0] = 1;
    block.writeUInt16LE(data.length, 1);
    block.writeUInt16LE(0xffff ^ data.length, 3);
    data.copy(block, 5);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(adler32(data));
    return Buffer.concat([Buffer.from([0x78, 0x01]), block, checksum]);
}

function adler32(data)
{
    let a = 1;
    let b = 0;
    for (const value of data)
    {
        a = (a + value) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function crc32(data)
{
    let crc = 0xffffffff;
    for (const value of data)
    {
        crc ^= value;
        for (let bit = 0; bit < 8; bit += 1)
            crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function oggPage(sequence, granule, headerType, packets)
{
    const header = Buffer.alloc(27 + packets.length);
    header.write('OggS', 0, 'ascii');
    header[5] = headerType;
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(0x46535553, 14);
    header.writeUInt32LE(sequence, 18);
    header[26] = packets.length;
    header.set(packets.map((packet) => packet.length), 27);
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(oggCrc32(page), 22);
    return page;
}

function oggCrc32(data)
{
    let crc = 0;
    for (const value of data)
    {
        crc ^= value << 24;
        for (let bit = 0; bit < 8; bit += 1)
            crc = ((crc << 1) ^ ((crc & 0x80000000) === 0 ? 0 : 0x04c11db7)) >>> 0;
    }
    return crc;
}
