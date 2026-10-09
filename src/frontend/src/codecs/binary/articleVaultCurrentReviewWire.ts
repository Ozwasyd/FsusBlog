/** Closed wire references only. The server must verify actual stored plans and current permission. */
export type VaultCurrentReviewOperation = Readonly<{
    schema: 'fsusblog.article-vault.operation-identity.v1';
    schemaVersion: 1;
    siteIdentity: string;
    vaultIdentity: string;
    deviceIdentity: string;
    agentIdentity: string;
    planReference: string;
    planSha256: string;
    requestSha256: string;
    idempotencySha256: string;
    deadlineUnixMs: number;
    operationIdentity: string;
    contentSha256: string;
}>;

export type VaultCurrentReviewRequest = Readonly<{
    articleId: number;
    resolutionOperationIdentity: string;
    proposalSha256: string;
    checkpoint: Readonly<{ operation: VaultCurrentReviewOperation; sequence: number; contentSha256: string }> | null;
}>;

export const VAULT_CURRENT_REVIEW_REQUEST_BYTES = 3176;
export const VAULT_CURRENT_REVIEW_REQUEST_FRAME_BYTES = 3192;
const MAGIC = 0x31524356;
const OPERATION_SCHEMA = 'fsusblog.article-vault.operation-identity.v1';
const requestKeys = ['articleId', 'resolutionOperationIdentity', 'proposalSha256', 'checkpoint'];
const operationKeys = ['schema', 'schemaVersion', 'siteIdentity', 'vaultIdentity', 'deviceIdentity', 'agentIdentity',
    'planReference', 'planSha256', 'requestSha256', 'idempotencySha256', 'deadlineUnixMs', 'operationIdentity', 'contentSha256'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(): never
{
    throw new TypeError('article_vault_current_review_request_invalid');
}

function closed(value: unknown, keys: readonly string[]): boolean
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function digest(value: unknown): value is string
{
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function identity(value: unknown): value is string
{
    if (typeof value !== 'string' || value.length < 3 || value.length > 128) return false;
    for (const rune of value)
    {
        const cp = rune.codePointAt(0)!;
        if (cp === 0 || cp === 47 || cp === 92 || cp >= 0xd800 && cp <= 0xdfff
            || cp >= 9 && cp <= 13 || cp === 32 || cp === 133 || cp === 160 || cp === 5760
            || cp >= 8192 && cp <= 8202 || cp === 8232 || cp === 8233 || cp === 8239 || cp === 8287 || cp === 12288) return false;
    }
    return encoder.encode(value).length < 512;
}

/** Rejects unknown properties and unsupported references; does not authenticate their existence. */
export function validateVaultCurrentReviewRequest(value: unknown): value is VaultCurrentReviewRequest
{
    if (!closed(value, requestKeys)) return false;
    const request = value as VaultCurrentReviewRequest;
    if (!Number.isInteger(request.articleId) || request.articleId < 1 || request.articleId > 2147483647
        || typeof request.resolutionOperationIdentity !== 'string'
        || !/^resolution-[0-9a-f]{64}$/u.test(request.resolutionOperationIdentity) || !digest(request.proposalSha256)) return false;
    if (request.checkpoint === null) return true;
    if (!closed(request.checkpoint, ['operation', 'sequence', 'contentSha256'])) return false;
    const checkpoint = request.checkpoint;
    if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 || !digest(checkpoint.contentSha256)
        || !closed(checkpoint.operation, operationKeys)) return false;
    const operation = checkpoint.operation;
    return operation.schema === OPERATION_SCHEMA && operation.schemaVersion === 1
        && [operation.siteIdentity, operation.vaultIdentity, operation.deviceIdentity, operation.agentIdentity, operation.planReference].every(identity)
        && [operation.planSha256, operation.requestSha256, operation.idempotencySha256, operation.operationIdentity, operation.contentSha256].every(digest)
        && Number.isSafeInteger(operation.deadlineUnixMs) && operation.deadlineUnixMs > 0;
}

/** Writes the fixed POD with an all-zero absent checkpoint and canonical zero padding. */
export function encodeVaultCurrentReviewRequest(request: VaultCurrentReviewRequest): Uint8Array
{
    if (!validateVaultCurrentReviewRequest(request)) return fail();
    const bytes = new Uint8Array(VAULT_CURRENT_REVIEW_REQUEST_BYTES);
    const view = new DataView(bytes.buffer);
    const put = (offset: number, text: string): void => { bytes.set(encoder.encode(text), offset); };
    view.setUint32(0, MAGIC, true);
    view.setUint16(4, 1, true);
    view.setUint16(6, request.checkpoint === null ? 0 : 1, true);
    view.setInt32(8, request.articleId, true);
    put(16, request.resolutionOperationIdentity);
    put(96, request.proposalSha256);
    if (request.checkpoint !== null)
    {
        const checkpoint = request.checkpoint;
        const operation = checkpoint.operation;
        view.setBigInt64(160, BigInt(checkpoint.sequence), true);
        put(168, checkpoint.contentSha256);
        put(232, operation.schema);
        view.setInt32(280, 1, true);
        put(288, operation.siteIdentity);
        put(800, operation.vaultIdentity);
        put(1312, operation.deviceIdentity);
        put(1824, operation.agentIdentity);
        put(2336, operation.planReference);
        put(2848, operation.planSha256);
        put(2912, operation.requestSha256);
        put(2976, operation.idempotencySha256);
        view.setBigInt64(3040, BigInt(operation.deadlineUnixMs), true);
        put(3048, operation.operationIdentity);
        put(3112, operation.contentSha256);
    }
    return bytes;
}

/** Decodes structural references only; no parser result supplies an execution or current-input grant. */
export function decodeVaultCurrentReviewRequest(bytes: Uint8Array): VaultCurrentReviewRequest
{
    if (!(bytes instanceof Uint8Array) || bytes.length !== VAULT_CURRENT_REVIEW_REQUEST_BYTES) return fail();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const get = (offset: number, size: number): string =>
    {
        const slot = bytes.subarray(offset, offset + size);
        const zero = slot.indexOf(0);
        if (zero >= 0 && slot.subarray(zero).some(byte => byte !== 0)) return fail();
        try { return decoder.decode(zero < 0 ? slot : slot.subarray(0, zero)); }
        catch { return fail(); }
    };
    if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 1
        || view.getUint16(6, true) > 1 || view.getUint32(12, true) !== 0) return fail();
    let checkpoint: VaultCurrentReviewRequest['checkpoint'] = null;
    if (view.getUint16(6, true) === 0)
    {
        if (bytes.subarray(160).some(byte => byte !== 0)) return fail();
    }
    else
    {
        if (view.getUint32(284, true) !== 0) return fail();
        checkpoint = {
            sequence: Number(view.getBigInt64(160, true)), contentSha256: get(168, 64),
            operation: {
                schema: get(232, 48) as VaultCurrentReviewOperation['schema'], schemaVersion: view.getInt32(280, true) as 1,
                siteIdentity: get(288, 512), vaultIdentity: get(800, 512), deviceIdentity: get(1312, 512),
                agentIdentity: get(1824, 512), planReference: get(2336, 512), planSha256: get(2848, 64),
                requestSha256: get(2912, 64), idempotencySha256: get(2976, 64), deadlineUnixMs: Number(view.getBigInt64(3040, true)),
                operationIdentity: get(3048, 64), contentSha256: get(3112, 64)
            }
        };
    }
    const request = { articleId: view.getInt32(8, true), resolutionOperationIdentity: get(16, 80), proposalSha256: get(96, 64), checkpoint };
    if (!validateVaultCurrentReviewRequest(request)) return fail();
    if (checkpoint !== null)
    {
        Object.freeze(checkpoint.operation);
        Object.freeze(checkpoint);
    }
    return Object.freeze(request);
}
