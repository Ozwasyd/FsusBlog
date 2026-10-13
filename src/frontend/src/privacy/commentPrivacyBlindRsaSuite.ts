import { sha256, sha384 } from '@noble/hashes/sha2.js';

import type {
    CommentPrivacyCredentialIssuePayload,
    CommentPrivacyCredentialIssuerMetadata,
    CommentPrivacyCredentialMaterial,
    CommentPrivacyCredentialSuite
} from './commentPrivacyContracts';

export const BLIND_CREDENTIAL_SCHEME = 'rfc9474-rsabssa-sha384-pss-randomized-3072';
const MESSAGE_DOMAIN = 'fsus.anonymous.credential.v5';
const WITNESS_DOMAIN = new TextEncoder().encode('fsus.anonymous.credential.v5:witness');
const OPENING_MAGIC = new TextEncoder().encode('FSUS-RFC9474-OPENING-V1');
const MODULUS_BYTES = 384;
const HASH_BYTES = 48;
const SALT_BYTES = 48;
const RANDOMIZER_BYTES = 32;
const DEFAULT_REPUTATION_BUCKET = 'unrated';

interface BlindOpening {
    preparedMessage: Uint8Array<ArrayBuffer>;
    inverse: bigint;
}

interface ValidatedPublicKey {
    key: CryptoKey;
    modulus: bigint;
    exponent: bigint;
}

export interface BlindRsaCredentialSuiteOptions {
    crypto: Pick<Crypto, 'getRandomValues' | 'subtle'>;
}

export function createBlindRsaCredentialSuite(
    options: BlindRsaCredentialSuiteOptions
): CommentPrivacyCredentialSuite
{
    const cryptoSource = options.crypto;

    return {
        async createCredentialRequest(input): Promise<CommentPrivacyCredentialIssuePayload | null>
        {
            if (input.signal.aborted ||
        !isMetadataUsable(input.metadata) ||
        typeof cryptoSource.getRandomValues !== 'function' ||
        !cryptoSource.subtle)
            {
                return null;
            }

            let message: Uint8Array | null = null;
            let randomizer: Uint8Array | null = null;
            let preparedMessage: Uint8Array | null = null;
            let salt: Uint8Array | null = null;
            let encodedMessage: Uint8Array | null = null;
            try
            {
                const validated = await loadValidatedPublicKey(cryptoSource.subtle, input.metadata);
                if (!validated)
                {
                    return null;
                }

                message = encodeCredentialMessage(input.metadata, input.credentialSecret, input.clientNonce);
                randomizer = randomBytes(cryptoSource, RANDOMIZER_BYTES);
                preparedMessage = concatBytes(randomizer, message);
                salt = randomBytes(cryptoSource, SALT_BYTES);
                encodedMessage = emsaPssEncode(preparedMessage, salt, MODULUS_BYTES * 8 - 1);
                const messageRepresentative = os2ip(encodedMessage);
                if (messageRepresentative >= validated.modulus)
                {
                    return null;
                }

                const blind = randomInvertible(cryptoSource, validated.modulus);
                const inverse = modInverse(blind, validated.modulus);
                const blinded = mod(
                    messageRepresentative * modPow(blind, validated.exponent, validated.modulus),
                    validated.modulus);
                return {
                    credentialRequest: i2osp(blinded, MODULUS_BYTES),
                    credentialOpening: encodeOpening({ preparedMessage, inverse })
                };
            }
            catch
            {
                return null;
            }
            finally
            {
                clearBytes(message);
                clearBytes(randomizer);
                clearBytes(preparedMessage);
                clearBytes(salt);
                clearBytes(encodedMessage);
            }
        },

        async acceptIssuerResponse(input): Promise<CommentPrivacyCredentialMaterial | null>
        {
            if (input.signal.aborted ||
        !isMetadataUsable(input.metadata) ||
        input.issuerSignature.byteLength !== MODULUS_BYTES ||
        input.response.schemeId !== BLIND_CREDENTIAL_SCHEME ||
        input.response.issuerPublicKeyId !== input.metadata.issuerPublicKeyId)
            {
                return null;
            }
            let opening: BlindOpening | null = null;
            let signature: Uint8Array<ArrayBuffer> | null = null;
            let witness: Uint8Array | null = null;
            let credentialCommitment: Uint8Array | null = null;
            let revocationInput: Uint8Array | null = null;
            let revocationHandleHash: Uint8Array | null = null;
            try
            {
                opening = decodeOpening(input.credentialOpening);
                if (!opening)
                {
                    return null;
                }
                const validated = await loadValidatedPublicKey(cryptoSource.subtle, input.metadata);
                if (!validated)
                {
                    return null;
                }
                signature = i2osp(
                    mod(os2ip(input.issuerSignature) * opening.inverse, validated.modulus),
                    MODULUS_BYTES);
                const verified = await cryptoSource.subtle.verify(
                    { name: 'RSA-PSS', saltLength: SALT_BYTES },
                    validated.key,
                    signature,
                    opening.preparedMessage);
                if (!verified)
                {
                    return null;
                }

                witness = concatBytes(
                    WITNESS_DOMAIN,
                    uint16(opening.preparedMessage.byteLength),
                    opening.preparedMessage,
                    uint16(signature.byteLength),
                    signature,
                    sha256(input.metadata.subjectPublicKeyInfo));
                credentialCommitment = sha256(witness);
                revocationInput = concatBytes(
                    new TextEncoder().encode('fsus.anonymous.revocation.handle.v4'),
                    input.credentialSecret,
                    hexToBytes(input.metadata.issuerPublicKeyHash));
                revocationHandleHash = sha256(revocationInput);

                return {
                    credentialSecret: new Uint8Array(input.credentialSecret),
                    credentialCommitment: new Uint8Array(credentialCommitment),
                    issuerSignature: new Uint8Array(signature),
                    revocationWitness: new Uint8Array(witness),
                    revocationHandleHash: new Uint8Array(revocationHandleHash),
                    credentialLevel: input.response.credentialLevel,
                    reputationBucket: input.metadata.reputationBucket || DEFAULT_REPUTATION_BUCKET
                };
            }
            catch
            {
                return null;
            }
            finally
            {
                clearBytes(opening?.preparedMessage);
                clearBytes(signature);
                clearBytes(witness);
                clearBytes(credentialCommitment);
                clearBytes(revocationInput);
                clearBytes(revocationHandleHash);
            }
        }
    };
}

function isMetadataUsable(metadata: CommentPrivacyCredentialIssuerMetadata): boolean
{
    return metadata.schemeId === BLIND_CREDENTIAL_SCHEME &&
    metadata.modulusBytes === MODULUS_BYTES &&
    Number.isSafeInteger(metadata.credentialEpoch) &&
    metadata.credentialEpoch > 0 &&
    Number.isSafeInteger(metadata.circuitNumericId) &&
    metadata.circuitNumericId > 0 &&
    Number.isSafeInteger(metadata.publicInputLayoutVersion) &&
    metadata.publicInputLayoutVersion === 6 &&
    metadata.circuitId === 'fsus.anonymous.comment.v5' &&
    /^[0-9a-f]{64}$/u.test(metadata.issuerPublicKeyHash) &&
    metadata.subjectPublicKeyInfo.byteLength > 0;
}

async function loadValidatedPublicKey(
    subtle: SubtleCrypto,
    metadata: CommentPrivacyCredentialIssuerMetadata
): Promise<ValidatedPublicKey | null>
{
    let spki: Uint8Array<ArrayBuffer> | null = null;
    let actualHash: Uint8Array | null = null;
    let expectedHash: Uint8Array | null = null;
    let modulusBytes: Uint8Array | null = null;
    let exponentBytes: Uint8Array | null = null;
    try
    {
        // Snapshot only the borrowed view range; hash and import consume the same owned bytes.
        spki = new Uint8Array(metadata.subjectPublicKeyInfo);
        actualHash = sha256(spki);
        expectedHash = hexToBytes(metadata.issuerPublicKeyHash);
        if (!bytesEqual(actualHash, expectedHash))
        {
            return null;
        }
        const key = await importPublicKey(subtle, spki);
        if (!key)
        {
            return null;
        }
        const jwk = await subtle.exportKey('jwk', key);
        modulusBytes = jwk.n ? base64UrlToBytes(jwk.n) : null;
        exponentBytes = jwk.e ? base64UrlToBytes(jwk.e) : null;
        if (!modulusBytes || modulusBytes.byteLength !== MODULUS_BYTES ||
      !exponentBytes || os2ip(exponentBytes) !== 65537n ||
      (modulusBytes[0] & 0x80) === 0)
        {
            return null;
        }
        return {
            key,
            modulus: os2ip(modulusBytes),
            exponent: 65537n
        };
    }
    finally
    {
        clearBytes(spki);
        clearBytes(actualHash);
        clearBytes(expectedHash);
        clearBytes(modulusBytes);
        clearBytes(exponentBytes);
    }
}

async function importPublicKey(subtle: SubtleCrypto, spki: Uint8Array<ArrayBuffer>): Promise<CryptoKey | null>
{
    try
    {
        return await subtle.importKey(
            'spki',
            spki,
            { name: 'RSA-PSS', hash: 'SHA-384' },
            true,
            ['verify']);
    }
    catch
    {
        return null;
    }
}

function encodeCredentialMessage(
    metadata: CommentPrivacyCredentialIssuerMetadata,
    credentialSecret: Uint8Array,
    credentialNonce: Uint8Array
): Uint8Array
{
    if (credentialSecret.byteLength !== 32 || credentialNonce.byteLength !== 32)
    {
        throw new Error('blind_credential_entropy_invalid');
    }
    return concatBytes(
        lengthPrefixedUtf8(MESSAGE_DOMAIN),
        lengthPrefixedUtf8(metadata.schemeId),
        int64(metadata.credentialEpoch),
        uint32(metadata.circuitNumericId),
        uint16(metadata.publicInputLayoutVersion),
        lengthPrefixedUtf8(metadata.circuitId),
        lengthPrefixedUtf8(metadata.credentialLevel),
        lengthPrefixedUtf8(metadata.issuerPublicKeyHash),
        credentialSecret,
        credentialNonce);
}

function emsaPssEncode(message: Uint8Array, salt: Uint8Array, emBits: number): Uint8Array
{
    const emLength = Math.ceil(emBits / 8);
    const messageHash = sha384(message);
    if (emLength < HASH_BYTES + SALT_BYTES + 2 || salt.byteLength !== SALT_BYTES)
    {
        throw new Error('blind_credential_pss_encoding_invalid');
    }
    const h = sha384(concatBytes(new Uint8Array(8), messageHash, salt));
    const padding = new Uint8Array(emLength - SALT_BYTES - HASH_BYTES - 2);
    const dataBlock = concatBytes(padding, new Uint8Array([1]), salt);
    const mask = mgf1(h, dataBlock.byteLength);
    const masked = new Uint8Array(dataBlock.byteLength);
    for (let index = 0; index < masked.byteLength; index += 1)
    {
        masked[index] = dataBlock[index] ^ mask[index];
    }
    masked[0] &= 0xff >>> (8 * emLength - emBits);
    return concatBytes(masked, h, new Uint8Array([0xbc]));
}

function mgf1(seed: Uint8Array, length: number): Uint8Array
{
    const output = new Uint8Array(length);
    let offset = 0;
    for (let counter = 0; offset < length; counter += 1)
    {
        const block = sha384(concatBytes(seed, uint32BigEndian(counter)));
        const remaining = Math.min(block.byteLength, length - offset);
        output.set(block.subarray(0, remaining), offset);
        offset += remaining;
    }
    return output;
}

function randomInvertible(cryptoSource: Pick<Crypto, 'getRandomValues'>, modulus: bigint): bigint
{
    for (let attempt = 0; attempt < 128; attempt += 1)
    {
        const candidate = os2ip(randomBytes(cryptoSource, MODULUS_BYTES));
        if (candidate > 1n && candidate < modulus && gcd(candidate, modulus) === 1n)
        {
            return candidate;
        }
    }
    throw new Error('blind_credential_randomness_unavailable');
}

function encodeOpening(opening: BlindOpening): Uint8Array
{
    return concatBytes(
        OPENING_MAGIC,
        uint16(opening.preparedMessage.byteLength),
        opening.preparedMessage,
        i2osp(opening.inverse, MODULUS_BYTES));
}

function decodeOpening(bytes: Uint8Array): BlindOpening | null
{
    if (bytes.byteLength < OPENING_MAGIC.byteLength + 2 + MODULUS_BYTES ||
    !bytesEqual(bytes.subarray(0, OPENING_MAGIC.byteLength), OPENING_MAGIC))
    {
        return null;
    }
    const lengthOffset = OPENING_MAGIC.byteLength;
    const preparedLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
    const preparedStart = lengthOffset + 2;
    const inverseStart = preparedStart + preparedLength;
    if (preparedLength <= RANDOMIZER_BYTES ||
    inverseStart + MODULUS_BYTES !== bytes.byteLength)
    {
        return null;
    }
    const inverse = os2ip(bytes.subarray(inverseStart));
    return inverse > 0n
        ? { preparedMessage: bytes.slice(preparedStart, inverseStart), inverse }
        : null;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint
{
    let value = mod(base, modulus);
    let power = exponent;
    let result = 1n;
    while (power > 0n)
    {
        if ((power & 1n) === 1n)
        {
            result = mod(result * value, modulus);
        }
        value = mod(value * value, modulus);
        power >>= 1n;
    }
    return result;
}

function modInverse(value: bigint, modulus: bigint): bigint
{
    let oldR = value;
    let r = modulus;
    let oldS = 1n;
    let s = 0n;
    while (r !== 0n)
    {
        const quotient = oldR / r
    ;[oldR, r] = [r, oldR - quotient * r]
        ;[oldS, s] = [s, oldS - quotient * s];
    }
    if (oldR !== 1n)
    {
        throw new Error('blind_credential_inverse_invalid');
    }
    return mod(oldS, modulus);
}

function gcd(left: bigint, right: bigint): bigint
{
    let a = left;
    let b = right;
    while (b !== 0n)
    {
        ;[a, b] = [b, a % b];
    }
    return a;
}

function mod(value: bigint, modulus: bigint): bigint
{
    const result = value % modulus;
    return result >= 0n ? result : result + modulus;
}

function os2ip(bytes: Uint8Array): bigint
{
    let value = 0n;
    for (const byte of bytes)
    {
        value = (value << 8n) | BigInt(byte);
    }
    return value;
}

function i2osp(value: bigint, length: number): Uint8Array<ArrayBuffer>
{
    if (value < 0n)
    {
        throw new Error('blind_credential_integer_invalid');
    }
    const output = new Uint8Array(length);
    let current = value;
    for (let index = length - 1; index >= 0; index -= 1)
    {
        output[index] = Number(current & 0xffn);
        current >>= 8n;
    }
    if (current !== 0n)
    {
        throw new Error('blind_credential_integer_oversized');
    }
    return output;
}

function randomBytes(cryptoSource: Pick<Crypto, 'getRandomValues'>, length: number): Uint8Array
{
    const bytes = new Uint8Array(length);
    cryptoSource.getRandomValues(bytes);
    return bytes;
}

function lengthPrefixedUtf8(value: string): Uint8Array
{
    const encoded = new TextEncoder().encode(value);
    return concatBytes(uint16(encoded.byteLength), encoded);
}

function uint16(value: number): Uint8Array
{
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff)
    {
        throw new Error('blind_credential_uint16_invalid');
    }
    return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function uint32(value: number): Uint8Array
{
    const output = new Uint8Array(4);
    new DataView(output.buffer).setUint32(0, value, true);
    return output;
}

function uint32BigEndian(value: number): Uint8Array
{
    const output = new Uint8Array(4);
    new DataView(output.buffer).setUint32(0, value, false);
    return output;
}

function int64(value: number): Uint8Array
{
    const output = new Uint8Array(8);
    new DataView(output.buffer).setBigInt64(0, BigInt(value), true);
    return output;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array
{
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts)
    {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean
{
    if (left.byteLength !== right.byteLength)
    {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < left.byteLength; index += 1)
    {
        diff |= left[index] ^ right[index];
    }
    return diff === 0;
}

function base64UrlToBytes(value: string): Uint8Array
{
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array
{
    if (!/^[0-9a-f]{64}$/u.test(value))
    {
        return new Uint8Array();
    }
    return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function clearBytes(value: Uint8Array | null | undefined): void
{
    value?.fill(0);
}
