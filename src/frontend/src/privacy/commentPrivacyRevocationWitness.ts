const REVOCATION_WITNESS_MAGIC = new TextEncoder().encode('fsus-revocation-witness-v1');
const REVOCATION_WITNESS_ALGORITHM = 'circuit-friendly-non-membership.v1';
const REVOCATION_WITNESS_DEPTH = 128;
const FIELD_BYTES = 32;
const LEAF_KEY_BYTES = 16;

export interface CommentPrivacyRevocationWitnessMaterial {
    credentialEpoch: number;
    algorithmId: string;
    pathDepth: number;
    issuerPublicKeyHash: string;
    revocationRoot: Uint8Array;
    revocationHandleHash: Uint8Array;
    leafKey: Uint8Array;
    witnessHash: Uint8Array;
    siblingHashes: Uint8Array;
}

export function encodeCommentPrivacyRevocationWitnessMaterial(
    response: CommentPrivacyRevocationWitnessMaterial
): Uint8Array<ArrayBuffer>
{
    const algorithm = new TextEncoder().encode(response.algorithmId);
    const issuer = new TextEncoder().encode(response.issuerPublicKeyHash);
    return concatBytes(
        REVOCATION_WITNESS_MAGIC,
        numberToUint64Bytes(BigInt(response.credentialEpoch)),
        numberToUint16Bytes(response.pathDepth),
        lengthPrefixed(algorithm),
        lengthPrefixed(issuer),
        lengthPrefixed(response.revocationRoot),
        lengthPrefixed(response.revocationHandleHash),
        lengthPrefixed(response.leafKey),
        lengthPrefixed(response.witnessHash),
        lengthPrefixed(response.siblingHashes)
    );
}

export function parseCommentPrivacyRevocationWitnessMaterial(
    material: Uint8Array | null | undefined
): CommentPrivacyRevocationWitnessMaterial | null
{
    if (!(material instanceof Uint8Array) || material.byteLength === 0)
    {
        return null;
    }

    try
    {
        let offset = 0;
        if (!startsWith(material, REVOCATION_WITNESS_MAGIC))
        {
            return null;
        }
        offset += REVOCATION_WITNESS_MAGIC.byteLength;

        const credentialEpoch = Number(new DataView(material.buffer, material.byteOffset + offset, 8).getBigUint64(0, true));
        offset += 8;
        const pathDepth = new DataView(material.buffer, material.byteOffset + offset, 2).getUint16(0, true);
        offset += 2;

        const algorithm = readLengthPrefixed(material, offset);
        offset = algorithm.nextOffset;
        const issuer = readLengthPrefixed(material, offset);
        offset = issuer.nextOffset;
        const revocationRoot = readLengthPrefixed(material, offset);
        offset = revocationRoot.nextOffset;
        const revocationHandleHash = readLengthPrefixed(material, offset);
        offset = revocationHandleHash.nextOffset;
        const leafKey = readLengthPrefixed(material, offset);
        offset = leafKey.nextOffset;
        const witnessHash = readLengthPrefixed(material, offset);
        offset = witnessHash.nextOffset;
        const siblingHashes = readLengthPrefixed(material, offset);
        offset = siblingHashes.nextOffset;

        const parsed: CommentPrivacyRevocationWitnessMaterial = {
            credentialEpoch,
            algorithmId: new TextDecoder().decode(algorithm.bytes),
            pathDepth,
            issuerPublicKeyHash: new TextDecoder().decode(issuer.bytes),
            revocationRoot: revocationRoot.bytes,
            revocationHandleHash: revocationHandleHash.bytes,
            leafKey: leafKey.bytes,
            witnessHash: witnessHash.bytes,
            siblingHashes: siblingHashes.bytes
        };

        return offset === material.byteLength && isValidCommentPrivacyRevocationWitnessMaterial(parsed)
            ? parsed
            : null;
    }
    catch
    {
        return null;
    }
}

export function isValidCommentPrivacyRevocationWitnessMaterial(
    material: CommentPrivacyRevocationWitnessMaterial | null | undefined
): material is CommentPrivacyRevocationWitnessMaterial
{
    return Boolean(material) &&
    material?.credentialEpoch !== undefined &&
    Number.isSafeInteger(material.credentialEpoch) &&
    material.credentialEpoch > 0 &&
    material.algorithmId === REVOCATION_WITNESS_ALGORITHM &&
    material.pathDepth === REVOCATION_WITNESS_DEPTH &&
    isNonEmptyString(material.issuerPublicKeyHash) &&
    material.revocationRoot instanceof Uint8Array &&
    material.revocationRoot.byteLength > 0 &&
    material.revocationHandleHash instanceof Uint8Array &&
    material.revocationHandleHash.byteLength === FIELD_BYTES &&
    material.leafKey instanceof Uint8Array &&
    material.leafKey.byteLength === LEAF_KEY_BYTES &&
    material.witnessHash instanceof Uint8Array &&
    material.witnessHash.byteLength === FIELD_BYTES &&
    material.siblingHashes instanceof Uint8Array &&
    material.siblingHashes.byteLength === REVOCATION_WITNESS_DEPTH * FIELD_BYTES;
}

function readLengthPrefixed(bytes: Uint8Array, offset: number): { bytes: Uint8Array; nextOffset: number; }
{
    if (offset + 4 > bytes.byteLength)
    {
        throw new Error('revocation_witness_truncated');
    }

    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    const start = offset + 4;
    const end = start + length;
    if (end > bytes.byteLength)
    {
        throw new Error('revocation_witness_truncated');
    }

    return {
        bytes: bytes.slice(start, end),
        nextOffset: end
    };
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array
{
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, bytes.byteLength, true);
    return concatBytes(prefix, bytes);
}

function numberToUint16Bytes(value: number): Uint8Array
{
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
}

function numberToUint64Bytes(value: bigint): Uint8Array
{
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer>
{
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts)
    {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean
{
    if (bytes.byteLength < prefix.byteLength)
    {
        return false;
    }

    for (let index = 0; index < prefix.byteLength; index += 1)
    {
        if (bytes[index] !== prefix[index])
        {
            return false;
        }
    }
    return true;
}

function isNonEmptyString(value: unknown): value is string
{
    return typeof value === 'string' && value.trim().length > 0;
}
