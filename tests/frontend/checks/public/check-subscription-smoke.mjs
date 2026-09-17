#!/usr/bin/env node

const baseUrl = process.env.FSUSBLOG_API_BASE_URL || process.env.PLAYWRIGHT_API_BASE_URL || 'http://127.0.0.1:7568';
const email = `reader-${Date.now()}@example.invalid`;
const AEDS_MAGIC = 0x53444541;
const AEDS_VERSION = 2;
const AEDS_HEADER_LENGTH = 16;
const SITE_SUBSCRIPTION_REQUEST_FRAME = 157;
const SITE_SUBSCRIPTION_RESPONSE_FRAME = 158;
const API_ERROR_FRAME = 251;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function crc16(bytes)
{
    let crc = 0xffff;
    for (let i = 0; i < bytes.byteLength; i += 1)
    {
        crc ^= bytes[i] ?? 0;
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
        }
    }
    return crc & 0xffff;
}

function encodeFrame(frameType, payload)
{
    const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, AEDS_MAGIC, true);
    view.setUint8(4, AEDS_VERSION);
    view.setUint8(5, AEDS_HEADER_LENGTH);
    view.setUint16(8, frameType, true);
    view.setUint32(10, payload.byteLength, true);
    view.setUint16(14, crc16(payload), true);
    frame.set(payload, AEDS_HEADER_LENGTH);
    return frame;
}

function decodeFrame(buffer)
{
    const view = new DataView(buffer);
    assert(view.getUint32(0, true) === AEDS_MAGIC, 'AEDS magic mismatch');
    assert(view.getUint8(4) === AEDS_VERSION, 'AEDS version mismatch');
    assert(view.getUint8(5) === AEDS_HEADER_LENGTH, 'AEDS header length mismatch');
    const frameType = view.getUint16(8, true);
    const payloadLength = view.getUint32(10, true);
    const payload = new Uint8Array(buffer, AEDS_HEADER_LENGTH, payloadLength);
    assert(AEDS_HEADER_LENGTH + payloadLength === buffer.byteLength, 'AEDS payload length mismatch');
    assert(view.getUint16(14, true) === crc16(payload), 'AEDS payload crc mismatch');
    return { frameType, payload };
}

function writeFixedUtf8(payload, offset, length, value)
{
    const bytes = encoder.encode(value ?? '');
    payload.set(bytes.subarray(0, length), offset);
}

function readFixedUtf8(payload, offset, length)
{
    let end = offset;
    const limit = offset + length;
    while (end < limit && payload[end] !== 0)
    {
        end += 1;
    }
    return decoder.decode(payload.subarray(offset, end));
}

function encodeSubscriptionRequest(value)
{
    const payload = new Uint8Array(288);
    writeFixedUtf8(payload, 0, 256, value.email);
    writeFixedUtf8(payload, 256, 32, value.channel);
    return encodeFrame(SITE_SUBSCRIPTION_REQUEST_FRAME, payload);
}

function decodeSubscriptionResponse(buffer)
{
    const frame = decodeFrame(buffer);
    assert(frame.frameType === SITE_SUBSCRIPTION_RESPONSE_FRAME, `expected subscription frame, got ${frame.frameType}`);
    assert(frame.payload.byteLength === 36, `subscription payload size invalid: ${frame.payload.byteLength}`);
    return {
        subscribed: frame.payload[0] === 1,
        unsubscribed: frame.payload[1] === 1,
        channel: readFixedUtf8(frame.payload, 4, 32)
    };
}

async function request(path, init)
{
    const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            'Accept': 'application/octet-stream',
            'Content-Type': 'application/octet-stream',
            ...(init.headers || {})
        }
    });
    const buffer = await response.arrayBuffer();
    return { response, buffer, frame: buffer.byteLength > 0 ? decodeFrame(buffer) : null };
}

async function main()
{
    const subscribe = await request('/api/binary/subscriptions', {
        method: 'POST',
        body: encodeSubscriptionRequest({ email, channel: 'email' })
    });
    assert(subscribe.response.ok, `subscribe failed: ${subscribe.response.status}`);
    const subscribePayload = decodeSubscriptionResponse(subscribe.buffer);
    assert(subscribePayload.subscribed === true, 'subscribe response must confirm subscribed=true');
    assert(subscribePayload.channel === 'email', 'subscribe response must preserve requested email channel');
    assert(!Buffer.from(subscribe.buffer).toString('utf8').includes(email), 'subscribe response must not echo raw email');

    const unsubscribe = await request('/api/binary/subscriptions', {
        method: 'DELETE',
        body: encodeSubscriptionRequest({ email, channel: 'email' })
    });
    assert(unsubscribe.response.ok, `unsubscribe failed: ${unsubscribe.response.status}`);
    const unsubscribePayload = decodeSubscriptionResponse(unsubscribe.buffer);
    assert(unsubscribePayload.unsubscribed === true, 'unsubscribe response must confirm unsubscribed=true');
    assert(!Buffer.from(unsubscribe.buffer).toString('utf8').includes(email), 'unsubscribe response must not echo raw email');

    const invalid = await request('/api/binary/subscriptions', {
        method: 'POST',
        body: encodeSubscriptionRequest({ email: 'not-an-email', channel: 'email' })
    });
    assert(invalid.response.status === 400, `invalid email must be rejected with 400, got ${invalid.response.status}`);
    assert(invalid.frame?.frameType === API_ERROR_FRAME, `invalid email must return ApiError frame, got ${invalid.frame?.frameType}`);

    console.log(`[check-subscription-smoke] ok | base=${baseUrl}`);
}

main().catch((error) =>
{
    console.error('[check-subscription-smoke] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
