import { createHash, timingSafeEqual } from 'node:crypto';

export function utf8(value)
{
    const text = String(value);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text)
        throw new Error('invalid UTF-8 scalar sequence');
    return bytes;
}

export function ascii(value)
{
    const text = String(value);
    if ([...text].some((character) => character.codePointAt(0) > 0x7f))
        throw new Error('ASCII field contains a non-ASCII code point');
    return Buffer.from(text, 'ascii');
}

export function hex32(value)
{
    if (!/^[0-9a-f]{64}$/u.test(String(value)))
        throw new Error('hash field must be 32-byte lowercase hexadecimal');
    return Buffer.from(value, 'hex');
}

export function bytes32(value, label)
{
    const bytes = Buffer.from(value);
    if (bytes.length !== 32)
        throw new Error(`${label} must be 32 bytes`);
    return bytes;
}

export function int64(value)
{
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(BigInt(value));
    return bytes;
}

export function uint16(value)
{
    if (!Number.isInteger(value) || value < 0 || value > 0xffff)
        throw new Error('uint16 field is out of range');
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
}

export function requireKey(contract, value)
{
    if (!Buffer.isBuffer(value) || value.length !== contract.cryptography.keyBytes)
        throw new Error('key must be exactly 256 bits');
}

export function base64url(value)
{
    return Buffer.from(value).toString('base64url');
}

export function sha256(value)
{
    return createHash('sha256').update(value).digest();
}

export function fixedBytesEqual(left, right)
{
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function clamp(value, minimum, maximum)
{
    return Math.max(minimum, Math.min(maximum, value));
}

export function clampByte(value)
{
    return clamp(value, 0, 255);
}
