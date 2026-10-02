import { createHash } from 'node:crypto';
import fs from 'node:fs';

const { decodeAedsFrame } = await import(new URL('../../../tests/frontend/support/aeds-envelope.mjs', import.meta.url));

const protocol = JSON.parse(fs.readFileSync(new URL('../../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url), 'utf8'));
const expectedFrameType = protocol.frameTypes.find((frame) => frame.name === 'ArticleRelatedReading').value;

// Recompute from retained transport bytes, not a producer-supplied valid/CRC flag.
export function relatedReadingResponseError(request)
{
    if (request.status !== 200)
    {
        return `HTTP ${request.status}; expected HTTP 200`;
    }
    if (typeof request.responseBodyBase64 !== 'string' || request.responseBodyBase64.length === 0)
    {
        return 'missing response bytes';
    }
    const body = Buffer.from(request.responseBodyBase64, 'base64');
    if (body.toString('base64') !== request.responseBodyBase64)
    {
        return 'non-canonical response base64';
    }
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if (digest !== request.payloadDigest)
    {
        return 'response bytes do not match observed payload digest';
    }
    try
    {
        const frame = decodeAedsFrame(body);
        if (body.readUInt16LE(6) !== 0)
        {
            return 'unsupported AEDS flags';
        }
        if (frame.frameType !== expectedFrameType)
        {
            return `wrong AEDS frame type ${frame.frameType}; expected ${expectedFrameType}`;
        }
    }
    catch (error)
    {
        return error.message;
    }
    return null;
}
