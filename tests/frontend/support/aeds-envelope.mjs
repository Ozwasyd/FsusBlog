/**
 * @typedef {ArrayBuffer | SharedArrayBuffer | Uint8Array | readonly number[]} AedsFrameInput
 * @typedef {string | number | bigint} WireInteger
 * @typedef {{ offset: number; length: number; }} AedsSlice
 * @typedef {null | boolean | number | string | PublicAotValue[] | { [key: string]: PublicAotValue; }} PublicAotValue
 * @typedef {{ enabled?: boolean; licenseType?: string; copyrightHolder?: string; copyrightYear?: number | null; rightsStatement?: string; attributionTemplate?: string; copyPolicy?: string; maxExcerptChars?: number; allowCodeCopy?: boolean; showPublicBadge?: boolean; proofBindingEnabled?: boolean; }} ArticleRightsRequest
 * @typedef {{ title?: string; content?: string; summary?: string; coverImageUrl?: string; categoryId?: number; tagIds?: number[]; status?: number; scheduledPublishAt?: string | number | Date | null; rightsMutation?: string | number; rights?: ArticleRightsRequest | null; baseRevisionId?: WireInteger | null; }} ArticleWriteRequest
 * @typedef {{ accountId: number; identityKind: string; publicHandle: string | null; passkeyEnabled: boolean; recoveryEnabled: boolean; totpStepUpEnabled: boolean | null; anonymousCredentialStatus: string | null; anonymousCredentialLevel: string | null; status: number; banReason: string | null; deletedAt: string | null; }} IdentityAccountSnapshot
 * @typedef {{ id?: string; rawId?: string; response?: { clientDataBytes?: string; attestationObject?: string; transports?: string[]; authenticatorData?: string; signature?: string; userHandle?: string | null; }; }} PasskeyCredentialInput
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();
const ArticleWriteRequestVersion = 5;
const ArticleRightsMutationPreserve = 0;
const ArticleRightsMutationReplace = 1;
const ArticleRightsMutationReset = 2;
const RightsFlagEnabled = 1 << 0;
const RightsFlagAllowCodeCopy = 1 << 1;
const RightsFlagShowPublicBadge = 1 << 2;
const RightsFlagProofBindingEnabled = 1 << 3;
const RightsFlagHasCopyrightYear = 1 << 4;
const PROTOCOL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/shared/Contracts/Validation/aeds-protocol.json');
const AEDS_PROTOCOL = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8'));
const AEDS_MAGIC = Number.parseInt(AEDS_PROTOCOL.header.magic, 16);
const AEDS_VERSION = AEDS_PROTOCOL.header.version;
const AEDS_HEADER_LENGTH = AEDS_PROTOCOL.header.size;
const AEDS_FRAME_TYPES = new Map(AEDS_PROTOCOL.frameTypes.map((frame) => [frame.name, frame.value]));
const FRAME_ARTICLE_LIST = frameType('ArticleList');
const FRAME_ARTICLE_DETAIL = frameType('ArticleDetail');
const FRAME_ARTICLE_HOT = frameType('ArticleHot');
const FRAME_ARTICLE_FEATURED = frameType('ArticleFeatured');
const FRAME_SEO_CONFIG = frameType('SeoConfig');
const FRAME_PAGE_CONTENT = frameType('PageContent');
const FRAME_AUTH_LOGIN_FLOW = frameType('AuthLoginFlow');
const FRAME_CURRENT_USER_SNAPSHOT = frameType('CurrentUserSnapshot');
const FRAME_IDENTITY_ACCOUNT_SNAPSHOT = frameType('IdentityAccountSnapshot');
const FRAME_ADMIN_PRINCIPAL_SNAPSHOT = frameType('AdminPrincipalSnapshot');
const FRAME_COMMENT_USER_CURSOR = frameType('CommentUserCursor');
const FRAME_UPLOAD_INIT = frameType('UploadInit');
const FRAME_UPLOAD_STATUS = frameType('UploadStatus');
const FRAME_UPLOAD_PART_ACK = frameType('UploadPartAck');
const FRAME_UPLOAD_COMPLETE = frameType('UploadComplete');
const FRAME_UPLOAD_PART_MAP = frameType('UploadPartMap');
const FRAME_AUTH_SESSION_LIST = frameType('AuthSessionList');
const FRAME_POW_CHALLENGE = frameType('PowChallenge');
const FRAME_MFA_SETUP_START = frameType('MfaSetupStart');
const FRAME_MFA_SETUP_VERIFY = frameType('MfaSetupVerify');
const FRAME_MFA_PROFILE = frameType('MfaProfile');
const FRAME_MFA_CHALLENGE_RESULT = frameType('MfaChallengeResult');
const FRAME_CONVERSATION_LIST = frameType('ConversationList');
const FRAME_CONVERSATION_DETAIL = frameType('ConversationDetail');
const FRAME_CONVERSATION_DETAIL_V2 = frameType('ConversationDetailV2');
const FRAME_CONVERSATION_DETAIL_V3 = frameType('ConversationDetailV3');
const FRAME_CONVERSATION_MESSAGE = frameType('ConversationMessage');
const FRAME_CATEGORY_LIST = frameType('CategoryList');
const FRAME_TAG_LIST = frameType('TagList');
const FRAME_PASSKEY_REGISTER_BEGIN = frameType('PasskeyRegisterBegin');
const FRAME_PASSKEY_LOGIN_BEGIN = frameType('PasskeyLoginBegin');
const FRAME_PASSKEY_CREDENTIAL_LIST = frameType('PasskeyCredentialList');
const FRAME_PASSKEY_SIGNAL_STATE = frameType('PasskeySignalState');
const FRAME_PUBLIC_AOT_BOOTSTRAP = frameType('PublicAotBootstrap');
const FRAME_EMPTY_SUCCESS = frameType('EmptySuccess');
const FRAME_MUTATION_ID = frameType('MutationId');
const FRAME_API_ERROR = frameType('ApiError');
const AUTH_LOGIN_FLOW_POD_SIZE = 168;
const CURRENT_USER_SNAPSHOT_POD_SIZE = 372;
const IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE = 72;
const USER_SESSION_SUMMARY_POD_SIZE = 500;
const MFA_SETUP_START_POD_SIZE = 36;
const MFA_SETUP_VERIFY_POD_SIZE = 8;
const MFA_RECOVERY_CODE_POD_SIZE = 64;
const MFA_PROFILE_POD_SIZE = 12;
const MFA_CHALLENGE_RESULT_POD_SIZE = 296;
const USER_COMMENT_POD_SIZE = 460;
const CONVERSATION_MESSAGE_PREVIEW_POD_SIZE = 32;
const CONVERSATION_LIST_ITEM_POD_SIZE = 76;
const CONVERSATION_MESSAGE_POD_SIZE = 48;
const CONVERSATION_DETAIL_POD_SIZE = 36;
const CONVERSATION_DETAIL_V2_POD_SIZE = 44;
const CONVERSATION_DETAIL_V3_POD_SIZE = 52;
const CONVERSATION_LIST_CURSOR_ENVELOPE_MAGIC = 0x4D534743;
const CONVERSATION_LIST_CURSOR_ENVELOPE_VERSION = 1;
const CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE = 17;
const ARTICLE_PAGE_CURSOR_ENVELOPE_MAGIC = 0x41535046;
const ARTICLE_PAGE_CURSOR_ENVELOPE_VERSION = 2;
const ARTICLE_LIST_RECORD_SIZE = 56;
const ARTICLE_LIST_RECORD_WITH_STATUS_SIZE = 76;
const ARTICLE_LIST_RECORD_WITH_PUBLICATION_SIZE = 100;
const COMPACT_TAG_RECORD_SIZE = 12;
const ARTICLE_DETAIL_V3_MAGIC = 0x41524433;
const ARTICLE_DETAIL_V3_VERSION = 3;
const ARTICLE_DETAIL_V4_MAGIC = 0x41524434;
const ARTICLE_DETAIL_V4_VERSION = 4;
const ARTICLE_DETAIL_V5_MAGIC = 0x41524435;
const ARTICLE_DETAIL_V5_VERSION = 5;
const ARTICLE_DETAIL_V3_HEADER_SIZE = 44;
const ARTICLE_DETAIL_V3_RECORD_SIZE = 84;
const ARTICLE_DETAIL_V4_RECORD_SIZE = 92;
const ARTICLE_DETAIL_V5_RECORD_SIZE = 116;
const ARTICLE_DETAIL_TAG_V3_RECORD_SIZE = 12;
const ARTICLE_DETAIL_RIGHTS_V3_RECORD_SIZE = 112;
const ARTICLE_DETAIL_RIGHTS_KNOWN_FLAGS = (1 << 11) - 1;
const ARTICLE_DETAIL_RIGHTS_FLAG_ENABLED = 1 << 0;
const ARTICLE_DETAIL_RIGHTS_FLAG_ALLOW_CODE_COPY = 1 << 1;
const ARTICLE_DETAIL_RIGHTS_FLAG_SHOW_PUBLIC_BADGE = 1 << 2;
const ARTICLE_DETAIL_RIGHTS_FLAG_PROOF_BINDING_ENABLED = 1 << 3;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_YEAR = 1 << 4;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_HOLDER = 1 << 5;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_RIGHTS_STATEMENT = 1 << 6;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_ATTRIBUTION_TEMPLATE = 1 << 7;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_CANONICAL_URL = 1 << 8;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_URL = 1 << 9;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_STATUS = 1 << 10;
const SEO_CONFIG_POD_SIZE = 5000;
const PAGE_CONTENT_POD_SIZE = 136;
const CATEGORY_POD_SIZE = 136;
const TAG_WITH_COUNT_POD_SIZE = 136;
const PASSKEY_PUBLIC_KEY_CREDENTIAL_PARAM_POD_SIZE = 8;
const PASSKEY_CREDENTIAL_DESCRIPTOR_POD_SIZE = 16;
const PASSKEY_REGISTER_BEGIN_POD_SIZE = 148;
const PASSKEY_LOGIN_BEGIN_POD_SIZE = 100;
const PASSKEY_CREDENTIAL_SUMMARY_POD_SIZE = 96;
const PASSKEY_SIGNAL_STATE_POD_SIZE = 48;
const PASSKEY_SIGNAL_CREDENTIAL_POD_SIZE = 8;
const API_ERROR_POD_SIZE = 584;
const PUBLIC_AOT_NULL_KIND = 0;
const PUBLIC_AOT_STRING_KIND = 1;
const PUBLIC_AOT_INT32_KIND = 2;
const PUBLIC_AOT_INT64_KIND = 3;
const PUBLIC_AOT_DOUBLE_KIND = 4;
const PUBLIC_AOT_BOOL_KIND = 5;
const PUBLIC_AOT_OBJECT_KIND = 6;
const PUBLIC_AOT_ARRAY_KIND = 7;
const PUBLIC_AOT_DECIMAL_KIND = 8;
const SEARCH_MANIFEST_MAGIC = 0x4d495346;
const SEARCH_MANIFEST_BINARY_VERSION = 1;
const DOTNET_EPOCH_OFFSET_MS = 62135596800000;

/**
 * @param {string} name
 * @returns {number}
 */
function frameType(name)
{
    const value = AEDS_FRAME_TYPES.get(name);
    if (!Number.isInteger(value))
    {
        throw new Error(`aeds_frame_type_missing:${name}`);
    }
    return value;
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 */
function readUInt32(view, offset)
{
    return view.getUint32(offset, true);
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 */
function readUInt16(view, offset)
{
    return view.getUint16(offset, true);
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 */
function readInt32(view, offset)
{
    return view.getInt32(offset, true);
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @returns {number}
 */
function readInt64Number(view, offset)
{
    return Number(view.getBigInt64(offset, true));
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readInt64FromBytes(bytes, offset)
{
    return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true));
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readByte(bytes, offset)
{
    return bytes[offset] ?? 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readFixedUtf8(bytes, offset, length)
{
    const slice = bytes.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return UTF8_DECODER.decode(end >= 0 ? slice.subarray(0, end) : slice);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {AedsSlice}
 */
function readSliceRef(bytes, offset)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        offset: readInt32(view, offset),
        length: readInt32(view, offset + 4)
    };
}

/**
 * @param {Uint8Array} blob
 * @param {AedsSlice} slice
 * @returns {Uint8Array}
 */
function readSliceBytes(blob, slice)
{
    if (slice.offset < 0 || slice.length < 0 || slice.offset + slice.length > blob.byteLength)
    {
        return new Uint8Array(0);
    }
    return blob.subarray(slice.offset, slice.offset + slice.length);
}

/**
 * @param {Uint8Array} blob
 * @param {AedsSlice} slice
 * @returns {string}
 */
function readSliceText(blob, slice)
{
    return UTF8_DECODER.decode(readSliceBytes(blob, slice));
}

/**
 * @param {{ arrayBuffer?: () => Promise<ArrayBuffer>; body?: () => Promise<Uint8Array>; }} response
 */
export async function readAedsResponse(response)
{
    if (typeof response.arrayBuffer === 'function')
    {
        return decodeKnownFrame(await response.arrayBuffer());
    }

    if (typeof response.body === 'function')
    {
        return decodeKnownFrame(await response.body());
    }

    throw new Error('aeds_response_body_unavailable');
}

/**
 * @param {AedsFrameInput} buffer
 * @returns {{ frameType: number; payload: Uint8Array; }}
 */
export function decodeAedsFrame(buffer)
{
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < AEDS_HEADER_LENGTH)
    {
        throw new Error('aeds_frame_too_short');
    }

    const magic = readUInt32(view, 0);
    if (magic !== AEDS_MAGIC)
    {
        throw new Error('aeds_magic_mismatch');
    }

    if (bytes[4] !== AEDS_VERSION || bytes[5] !== AEDS_HEADER_LENGTH)
    {
        throw new Error('aeds_version_mismatch');
    }

    const payloadLength = readUInt32(view, 10);
    if (payloadLength !== bytes.byteLength - AEDS_HEADER_LENGTH)
    {
        throw new Error('aeds_payload_length_mismatch');
    }
    const payload = bytes.subarray(AEDS_HEADER_LENGTH);
    if (crc16(payload) !== readUInt16(view, 14))
    {
        throw new Error('aeds_payload_crc_mismatch');
    }

    return {
        frameType: readUInt16(view, 8),
        payload
    };
}

/**
 * @param {AedsFrameInput} buffer
 */
export function decodeApiErrorFrame(buffer)
{
    const frame = decodeAedsFrame(buffer);
    if (frame.frameType !== FRAME_API_ERROR)
    {
        throw new Error(`aeds_frame_type_unsupported:${frame.frameType}`);
    }

    if (frame.payload.byteLength !== API_ERROR_POD_SIZE)
    {
        throw new Error(`api_error_payload_size_mismatch:${frame.payload.byteLength}`);
    }

    const payloadView = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    return {
        code: frame.payload[0],
        category: frame.payload[1],
        statusCode: readInt32(payloadView, 4),
        message: readFixedUtf8(frame.payload, 8, 256),
        details: readFixedUtf8(frame.payload, 264, 256),
        traceId: readFixedUtf8(frame.payload, 520, 64)
    };
}

/**
 * @param {number} frameType
 * @param {Uint8Array} payload
 * @returns {ArrayBuffer}
 */
export function encodeAedsFrame(frameType, payload)
{
    const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, AEDS_MAGIC, true);
    view.setUint8(4, AEDS_VERSION);
    view.setUint8(5, AEDS_HEADER_LENGTH);
    view.setUint16(6, 0, true);
    view.setUint16(8, frameType, true);
    view.setUint32(10, payload.byteLength, true);
    view.setUint16(14, crc16(payload), true);
    frame.set(payload, AEDS_HEADER_LENGTH);
    return frame.buffer;
}

export function encodeAuthAnonymousBootstrapRequest({ publicHandle = '', acceptedGuidelines = true } = {})
{
    const handle = new TextEncoder().encode(publicHandle.trim());
    const bytes = new Uint8Array(16 + handle.byteLength);
    const view = new DataView(bytes.buffer);
    bytes[0] = acceptedGuidelines ? 1 : 0;
    bytes[1] = handle.byteLength > 0 ? 1 : 0;
    view.setUint16(2, 0, true);
    writeSliceRef(view, 4, { offset: 0, length: handle.byteLength });
    view.setInt32(12, handle.byteLength, true);
    bytes.set(handle, 16);
    return bytes;
}

/**
 * @param {{ accountId?: number; identityKind?: string; status?: number; banReason?: string; deletedAt?: Date | null; }} [options]
 */
export function encodeCurrentUserSnapshotFrame({ accountId = 1, identityKind = 'anonymous_account', status = 0, banReason = '', deletedAt = null } = {})
{
    const bytes = new Uint8Array(CURRENT_USER_SNAPSHOT_POD_SIZE);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, accountId, true);
    view.setInt32(4, status, true);
    if (deletedAt instanceof Date)
    {
        view.setBigInt64(8, BigInt(deletedAt.getTime()), true);
        bytes[16] = 1;
    }
    bytes[17] = 1;
    writeFixedUtf8(bytes, 20, 64, identityKind);
    writeFixedUtf8(bytes, 116, 256, banReason);
    return encodeAedsFrame(FRAME_CURRENT_USER_SNAPSHOT, bytes);
}

/**
 * @param {{ accountId?: number; identityKind?: string; publicHandle?: string | null; passkeyEnabled?: boolean; recoveryEnabled?: boolean; totpStepUpEnabled?: boolean | null; anonymousCredentialStatus?: string | null; anonymousCredentialLevel?: string | null; status?: number; banReason?: string | null; deletedAt?: Date | null; }} [options]
 */
export function encodeIdentityAccountSnapshotFrame({
    accountId = 1,
    identityKind = 'anonymous_account',
    publicHandle = '',
    passkeyEnabled = false,
    recoveryEnabled = false,
    totpStepUpEnabled = null,
    anonymousCredentialStatus = '',
    anonymousCredentialLevel = '',
    status = 0,
    banReason = '',
    deletedAt = null
} = {})
{
    const hasPublicHandle = typeof publicHandle === 'string' && publicHandle.length > 0;
    const hasTotpStepUpEnabled = typeof totpStepUpEnabled === 'boolean';
    const hasAnonymousCredential = Boolean(anonymousCredentialStatus || anonymousCredentialLevel);
    const hasBanReason = typeof banReason === 'string' && banReason.length > 0;
    const hasDeletedAt = deletedAt instanceof Date;
    const encodedValues = [
    hasPublicHandle ? publicHandle : '',
    hasAnonymousCredential ? anonymousCredentialStatus : '',
    hasAnonymousCredential ? anonymousCredentialLevel : '',
    identityKind || 'anonymous_account',
    hasBanReason ? banReason : ''
    ].map((value) => UTF8_ENCODER.encode(value ?? ''));
    const blobLength = encodedValues.reduce((sum, item) => sum + item.byteLength, 0);
    const blob = new Uint8Array(blobLength);
    const refs = [];
    let blobOffset = 0;
    for (const encoded of encodedValues)
    {
        refs.push({ offset: blobOffset, length: encoded.byteLength });
        blob.set(encoded, blobOffset);
        blobOffset += encoded.byteLength;
    }
    const payload = new Uint8Array(IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE + 4 + blobLength);
    const view = new DataView(payload.buffer);
    view.setInt32(0, accountId, true);
    view.setInt32(4, 0, true);
    view.setInt32(8, status, true);
    if (hasDeletedAt)
    {
        view.setBigInt64(12, BigInt(deletedAt.getTime()), true);
    }
    payload[20] = hasPublicHandle ? 1 : 0;
    payload[21] = passkeyEnabled ? 1 : 0;
    payload[22] = recoveryEnabled ? 1 : 0;
    payload[23] = hasTotpStepUpEnabled ? 1 : 0;
    payload[24] = totpStepUpEnabled === true ? 1 : 0;
    payload[25] = hasAnonymousCredential ? 1 : 0;
    payload[26] = hasDeletedAt ? 1 : 0;
    payload[27] = hasBanReason ? 1 : 0;
    writeSliceRef(view, 32, refs[0]);
    writeSliceRef(view, 40, refs[1]);
    writeSliceRef(view, 48, refs[2]);
    writeSliceRef(view, 56, refs[3]);
    writeSliceRef(view, 64, refs[4]);
    view.setInt32(IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE, blobLength, true);
    payload.set(blob, IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE + 4);
    return encodeAedsFrame(FRAME_IDENTITY_ACCOUNT_SNAPSHOT, payload);
}

export function encodeAdminPrincipalSnapshotFrame({
    id = '9001',
    displayName = 'header-admin',
    source = 'independent',
    permissions = ['system.config'],
    adminSessionStatus = 'active',
    totpStepUpRequired = false
} = {})
{
    return encodeAedsFrame(FRAME_ADMIN_PRINCIPAL_SNAPSHOT, UTF8_ENCODER.encode(JSON.stringify({
        id,
        displayName,
        source,
        permissions,
        adminSessionStatus,
        totpStepUpRequired
    })));
}

/**
 * @param {{ fileName: string; mimeType: string; targetFormat: string; totalBytes: WireInteger; chunkSize: number; sha256?: string; }} payload
 */
export function encodeUploadInitRequest(payload)
{
    const bytes = new Uint8Array(428);
    const view = new DataView(bytes.buffer);
    writeFixedUtf8(bytes, 0, 256, payload.fileName);
    writeFixedUtf8(bytes, 256, 64, payload.mimeType);
    writeFixedUtf8(bytes, 320, 32, payload.targetFormat);
    view.setBigInt64(352, BigInt(payload.totalBytes), true);
    view.setInt32(360, payload.chunkSize, true);
    writeFixedUtf8(bytes, 364, 64, payload.sha256 ?? '');
    return bytes;
}

/**
 * @param {string | null | undefined} sha256
 */
export function encodeUploadCompleteRequest(sha256)
{
    const bytes = new Uint8Array(64);
    writeFixedUtf8(bytes, 0, 64, sha256 ?? '');
    return bytes;
}

/**
 * @param {string | null | undefined} value
 */
export function encodeStringMutationRequest(value)
{
    const encoded = UTF8_ENCODER.encode(value ?? '');
    const bytes = new Uint8Array(12 + encoded.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, encoded.byteLength, true);
    view.setInt32(8, encoded.byteLength, true);
    bytes.set(encoded, 12);
    return bytes;
}

/**
 * The legacy replyToUserId caller field is accepted but deliberately never encoded.
 * @param {{ articleId?: number; anonymousScope?: string; displayLanguage?: string; proofToken?: string; zkProof?: Uint8Array | ArrayBuffer | number[]; content?: string; parentId?: WireInteger | null; rootId?: WireInteger | null; replyToCommentId?: WireInteger | null; replyToUserId?: WireInteger | null; authorMode?: string | number; publicSendExplicitlySelected?: boolean; }} data
 */
export function encodeCommentCreateV2Request(data)
{
    const anonymousScope = UTF8_ENCODER.encode(data.anonymousScope ?? '');
    const displayLanguage = UTF8_ENCODER.encode(data.displayLanguage ?? '');
    const proofToken = UTF8_ENCODER.encode(data.proofToken ?? '');
    const zkProof = data.zkProof instanceof Uint8Array ? data.zkProof : new Uint8Array(data.zkProof ?? []);
    const content = UTF8_ENCODER.encode(data.content ?? '');
    const blobLength = anonymousScope.byteLength + displayLanguage.byteLength + proofToken.byteLength + zkProof.byteLength + content.byteLength;
    const bytes = new Uint8Array(84 + blobLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, data.articleId ?? 0, true);
    view.setInt32(4, 0, true);

    const parentId = parseOptionalBigInt(data.parentId);
    const rootId = parseOptionalBigInt(data.rootId);
    const replyToCommentId = parseOptionalBigInt(data.replyToCommentId);
    bytes[8] = parentId === null ? 0 : 1;
    bytes[9] = rootId === null ? 0 : 1;
    bytes[10] = replyToCommentId === null ? 0 : 1;
    bytes[11] = 0;
    view.setUint8(12, encodeCommentAuthorMode(data.authorMode));
    view.setUint8(13, data.publicSendExplicitlySelected ? 1 : 0);
    view.setUint16(14, 0, true);
    view.setBigInt64(16, parentId ?? 0n, true);
    view.setBigInt64(24, rootId ?? 0n, true);
    view.setBigInt64(32, replyToCommentId ?? 0n, true);

    let offset = 0;
    offset = writeBytesSlice(bytes, view, 40, 84, offset, anonymousScope);
    offset = writeBytesSlice(bytes, view, 48, 84, offset, displayLanguage);
    offset = writeBytesSlice(bytes, view, 56, 84, offset, proofToken);
    offset = writeBytesSlice(bytes, view, 64, 84, offset, zkProof);
    writeBytesSlice(bytes, view, 72, 84, offset, content);
    view.setInt32(80, blobLength, true);
    return bytes;
}

/**
 * @param {{ title?: string; description?: string; keywords?: string; author?: string; ogImage?: string; baseUrl?: string; faviconSvgUrl?: string; faviconIcoUrl?: string; faviconPngUrl?: string; appleTouchIconUrl?: string; manifestName?: string; manifestShortName?: string; pwaIcon192Url?: string; pwaIcon512Url?: string; pwaMaskableIconUrl?: string; themeColor?: string; backgroundColor?: string; siteLogoUrl?: string; siteLogoDarkUrl?: string; siteWordmarkUrl?: string; adminLogoUrl?: string; adminCollapsedIconUrl?: string; loginLogoUrl?: string; loginIconUrl?: string; }} data
 */
export function encodeSeoConfigPayload(data)
{
    const description = UTF8_ENCODER.encode(data.description ?? '');
    const bytes = new Uint8Array(SEO_CONFIG_POD_SIZE + 4 + description.byteLength);
    const view = new DataView(bytes.buffer);
    writeFixedUtf8(bytes, 0, 256, data.title ?? '');
    view.setInt32(256, 0, true);
    view.setInt32(260, description.byteLength, true);
    writeFixedUtf8(bytes, 264, 256, data.keywords ?? '');
    writeFixedUtf8(bytes, 520, 64, data.author ?? '');
    writeFixedUtf8(bytes, 584, 256, data.ogImage ?? '');
    writeFixedUtf8(bytes, 840, 256, data.baseUrl ?? '');
    writeFixedUtf8(bytes, 1096, 256, data.faviconSvgUrl ?? '');
    writeFixedUtf8(bytes, 1352, 256, data.faviconIcoUrl ?? '');
    writeFixedUtf8(bytes, 1608, 256, data.faviconPngUrl ?? '');
    writeFixedUtf8(bytes, 1864, 256, data.appleTouchIconUrl ?? '');
    writeFixedUtf8(bytes, 2120, 128, data.manifestName ?? '');
    writeFixedUtf8(bytes, 2248, 128, data.manifestShortName ?? '');
    writeFixedUtf8(bytes, 2376, 256, data.pwaIcon192Url ?? '');
    writeFixedUtf8(bytes, 2632, 256, data.pwaIcon512Url ?? '');
    writeFixedUtf8(bytes, 2888, 256, data.pwaMaskableIconUrl ?? '');
    writeFixedUtf8(bytes, 3144, 32, data.themeColor ?? '');
    writeFixedUtf8(bytes, 3176, 32, data.backgroundColor ?? '');
    writeFixedUtf8(bytes, 3208, 256, data.siteLogoUrl ?? '');
    writeFixedUtf8(bytes, 3464, 256, data.siteLogoDarkUrl ?? '');
    writeFixedUtf8(bytes, 3720, 256, data.siteWordmarkUrl ?? '');
    writeFixedUtf8(bytes, 3976, 256, data.adminLogoUrl ?? '');
    writeFixedUtf8(bytes, 4232, 256, data.adminCollapsedIconUrl ?? '');
    writeFixedUtf8(bytes, 4488, 256, data.loginLogoUrl ?? '');
    writeFixedUtf8(bytes, 4744, 256, data.loginIconUrl ?? '');
    view.setInt32(SEO_CONFIG_POD_SIZE, description.byteLength, true);
    bytes.set(description, SEO_CONFIG_POD_SIZE + 4);
    return bytes;
}

/**
 * @param {{ slug?: string; content?: string; }} data
 */
export function encodePageContentPayload(data)
{
    const content = UTF8_ENCODER.encode(data.content ?? '');
    const bytes = new Uint8Array(140 + content.byteLength);
    const view = new DataView(bytes.buffer);
    writeFixedUtf8(bytes, 0, 128, data.slug ?? '');
    view.setInt32(128, 0, true);
    view.setInt32(132, content.byteLength, true);
    view.setInt32(136, content.byteLength, true);
    bytes.set(content, 140);
    return bytes;
}

/**
 * @param {{ accountId?: number; status?: number; reason?: string; }} data
 */
export function encodeAdminChangeStatusRequest(data)
{
    const reason = UTF8_ENCODER.encode(data.reason ?? '');
    const bytes = new Uint8Array(20 + reason.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, data.accountId ?? 0, true);
    view.setInt32(4, data.status ?? 0, true);
    view.setInt32(8, 0, true);
    view.setInt32(12, reason.byteLength, true);
    view.setInt32(16, reason.byteLength, true);
    bytes.set(reason, 20);
    return bytes;
}

/**
 * @param {{ subject?: string; body?: string; }} data
 */
export function encodeConversationCreateRequest(data)
{
    const subject = UTF8_ENCODER.encode(data.subject ?? '');
    const body = UTF8_ENCODER.encode(data.body ?? '');
    const bytes = new Uint8Array(20 + subject.byteLength + body.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, subject.byteLength, true);
    view.setInt32(8, subject.byteLength, true);
    view.setInt32(12, body.byteLength, true);
    view.setInt32(16, subject.byteLength + body.byteLength, true);
    bytes.set(subject, 20);
    bytes.set(body, 20 + subject.byteLength);
    return bytes;
}

/**
 * @param {WireInteger} readThroughMessageId
 */
export function encodeConversationReadRequest(readThroughMessageId)
{
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, BigInt(readThroughMessageId), true);
    return bytes;
}

/**
 * @param {{ body?: string; readThroughMessageId: WireInteger; }} data
 */
export function encodeAccountConversationReplyRequest(data)
{
    const body = UTF8_ENCODER.encode(data.body ?? '');
    const bytes = new Uint8Array(20 + body.byteLength);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(0, BigInt(data.readThroughMessageId), true);
    view.setInt32(8, 0, true);
    view.setInt32(12, body.byteLength, true);
    view.setInt32(16, body.byteLength, true);
    bytes.set(body, 20);
    return bytes;
}

/**
 * @param {'pending' | 'closed' | 'active' | { status: string; reason?: string | null; }} input
 */
export function encodeConversationStatusRequest(input)
{
    const status = typeof input === 'object' && input !== null ? input.status : input;
    const reason = UTF8_ENCODER.encode(
        (typeof input === 'object' && input !== null ? input.reason : null) ?? 'local_status_fixture'
    );
    const bytes = new Uint8Array(16 + reason.byteLength);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, status === 'pending' ? 1 : status === 'closed' ? 2 : 0, true);
    view.setInt32(4, 0, true);
    view.setInt32(8, reason.byteLength, true);
    view.setInt32(12, reason.byteLength, true);
    bytes.set(reason, 16);
    return bytes;
}

/**
 * @param {{ subject?: string; body?: string; targetAccountId?: WireInteger | null; }} data
 */
export function encodeSystemMessageRequest(data)
{
    const subject = UTF8_ENCODER.encode(data.subject ?? '');
    const body = UTF8_ENCODER.encode(data.body ?? '');
    const bytes = new Uint8Array(36 + subject.byteLength + body.byteLength);
    const view = new DataView(bytes.buffer);
    view.setBigInt64(0, BigInt(data.targetAccountId ?? 0), true);
    view.setUint8(8, data.targetAccountId == null ? 0 : 1);
    view.setInt32(16, 0, true);
    view.setInt32(20, subject.byteLength, true);
    view.setInt32(24, subject.byteLength, true);
    view.setInt32(28, body.byteLength, true);
    view.setInt32(32, subject.byteLength + body.byteLength, true);
    bytes.set(subject, 36);
    bytes.set(body, 36 + subject.byteLength);
    return bytes;
}

/**
 * @param {string | null | undefined} value
 */
export function encodeNameMutationRequest(value)
{
    const bytes = new Uint8Array(128);
    writeFixedUtf8(bytes, 0, 128, value ?? '');
    return bytes;
}

/**
 * @param {ArticleWriteRequest} data
 */
export function encodeArticleWriteRequest(data)
{
    const textParts = [
        UTF8_ENCODER.encode(data.title ?? ''),
        UTF8_ENCODER.encode(data.content ?? ''),
        UTF8_ENCODER.encode(data.summary ?? ''),
        UTF8_ENCODER.encode(data.coverImageUrl ?? '')
    ];
    const rightsMutation = resolveArticleRightsMutation(data);
    const rights = normalizeArticleRightsRequest(data.rights);
    const rightsTextParts = [
        UTF8_ENCODER.encode(rights.licenseType),
        UTF8_ENCODER.encode(rights.copyrightHolder),
        UTF8_ENCODER.encode(rights.rightsStatement),
        UTF8_ENCODER.encode(rights.attributionTemplate),
        UTF8_ENCODER.encode(rights.copyPolicy)
    ];
    const blobLength = textParts.reduce((sum, part) => sum + part.byteLength, 0);
    const rightsBlobLength = rightsTextParts.reduce((sum, part) => sum + part.byteLength, 0);
    const tagIds = Array.isArray(data.tagIds) ? data.tagIds : [];
    const tagBytesLength = tagIds.length * 4;
    const bytes = new Uint8Array(40 + tagBytesLength + 4 + blobLength + 76 + rightsBlobLength + 8);
    const view = new DataView(bytes.buffer);

    view.setInt32(0, data.categoryId ?? 0, true);
    view.setInt32(4, tagIds.length, true);

    let blobOffset = 0;
    for (let i = 0; i < textParts.length; i += 1)
    {
        const part = textParts[i];
        const refOffset = 8 + i * 8;
        view.setInt32(refOffset, blobOffset, true);
        view.setInt32(refOffset + 4, part.byteLength, true);
        blobOffset += part.byteLength;
    }

    let cursor = 40;
    for (const tagId of tagIds)
    {
        view.setInt32(cursor, tagId, true);
        cursor += 4;
    }

    view.setInt32(cursor, blobLength, true);
    cursor += 4;
    for (const part of textParts)
    {
        bytes.set(part, cursor);
        cursor += part.byteLength;
    }

    view.setInt32(cursor, data.status ?? 2, true);
    cursor += 4;
    view.setBigInt64(cursor, BigInt(toScheduledPublishAtUnixMs(data.scheduledPublishAt)), true);
    cursor += 8;
    view.setInt32(cursor, ArticleWriteRequestVersion, true);
    cursor += 4;
    view.setInt32(cursor, rightsMutation, true);
    cursor += 4;
    view.setInt32(cursor, buildRightsFlags(rights), true);
    cursor += 4;
    view.setInt32(cursor, rights.copyrightYear ?? 0, true);
    cursor += 4;
    view.setInt32(cursor, rights.maxExcerptChars, true);
    cursor += 4;

    let rightsBlobOffset = 0;
    for (const part of rightsTextParts)
    {
        view.setInt32(cursor, rightsBlobOffset, true);
        view.setInt32(cursor + 4, part.byteLength, true);
        cursor += 8;
        rightsBlobOffset += part.byteLength;
    }

    view.setInt32(cursor, rightsBlobLength, true);
    cursor += 4;
    for (const part of rightsTextParts)
    {
        bytes.set(part, cursor);
        cursor += part.byteLength;
    }

    const baseRevisionId = data.baseRevisionId == null ? 0n : BigInt(data.baseRevisionId);
    if (baseRevisionId < 0n)
    {
        throw new Error('article_base_revision_invalid');
    }
    view.setBigInt64(cursor, baseRevisionId, true);

    return bytes;
}

function resolveArticleRightsMutation(data)
{
    if (data.resetRights === true)
    {
        if (data.rights != null)
        {
            throw new Error('article_rights_reset_payload_conflict');
        }
        return ArticleRightsMutationReset;
    }
    return data.rights == null ? ArticleRightsMutationPreserve : ArticleRightsMutationReplace;
}

function normalizeArticleRightsRequest(value)
{
    const rawCopyrightYear = value?.copyrightYear;
    const rawMaxExcerptChars = value?.maxExcerptChars;
    const copyrightYear = typeof rawCopyrightYear === 'number' && Number.isFinite(rawCopyrightYear)
        ? Math.trunc(rawCopyrightYear)
        : null;
    const maxExcerptChars = typeof rawMaxExcerptChars === 'number' && Number.isFinite(rawMaxExcerptChars)
        ? Math.max(0, Math.trunc(rawMaxExcerptChars))
        : 300;

    return {
        enabled: value?.enabled ?? true,
        licenseType: normalizeRightsToken(value?.licenseType, 'all-rights-reserved'),
        copyrightHolder: value?.copyrightHolder ?? '',
        copyrightYear,
        rightsStatement: value?.rightsStatement ?? '',
        attributionTemplate: value?.attributionTemplate ?? '',
        copyPolicy: normalizeRightsToken(value?.copyPolicy, 'append-attribution'),
        maxExcerptChars,
        allowCodeCopy: value?.allowCodeCopy ?? true,
        showPublicBadge: value?.showPublicBadge ?? true,
        proofBindingEnabled: value?.proofBindingEnabled ?? true
    };
}

function normalizeRightsToken(value, fallback)
{
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function buildRightsFlags(value)
{
    let flags = 0;
    if (value.enabled)
    {
        flags |= RightsFlagEnabled;
    }
    if (value.allowCodeCopy)
    {
        flags |= RightsFlagAllowCodeCopy;
    }
    if (value.showPublicBadge)
    {
        flags |= RightsFlagShowPublicBadge;
    }
    if (value.proofBindingEnabled)
    {
        flags |= RightsFlagProofBindingEnabled;
    }
    if (value.copyrightYear !== null)
    {
        flags |= RightsFlagHasCopyrightYear;
    }
    return flags;
}

function toScheduledPublishAtUnixMs(value)
{
    if (!value)
    {
        return 0;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseOptionalBigInt(value)
{
    if (value === null || value === undefined || value === '')
    {
        return null;
    }

    try
    {
        const parsed = BigInt(value);
        return parsed > 0n ? parsed : null;
    }
    catch
    {
        return null;
    }
}

function writeBytesSlice(bytes, view, sliceOffset, blobStart, offset, value)
{
    view.setInt32(sliceOffset, offset, true);
    view.setInt32(sliceOffset + 4, value.byteLength, true);
    bytes.set(value, blobStart + offset);
    return offset + value.byteLength;
}

function encodeCommentAuthorMode(mode)
{
    switch (String(mode ?? 'anonymous').trim().toLowerCase().replace('-', '_'))
    {
        case 'anonymous':
            return 1;
        case 'public':
            return 3;
        case 'zk_anonymous':
            return 4;
        default:
            throw new Error('comment_author_mode_invalid');
    }
}

/**
 * @param {{ generatedAtUtc: string; entries?: { pageId?: string | number; articleId?: number | null; routeKey?: string; html?: string; bootstrapPayload?: string; hydrationPropsPayload?: string; rendererVersion?: string; islandsPayload?: string; title?: string; baseUrl?: string; }[]; }} bundle
 */
export function encodeAotBundleRequest(bundle)
{
    const entries = Array.isArray(bundle.entries) ? bundle.entries : [];
    const encodedEntries = entries.map((entry) => [
        UTF8_ENCODER.encode(entry.routeKey ?? ''),
        UTF8_ENCODER.encode(entry.html ?? ''),
        UTF8_ENCODER.encode(entry.bootstrapPayload ?? ''),
        UTF8_ENCODER.encode(entry.hydrationPropsPayload ?? ''),
        UTF8_ENCODER.encode(entry.rendererVersion ?? ''),
        UTF8_ENCODER.encode(entry.islandsPayload ?? ''),
        UTF8_ENCODER.encode(entry.title ?? ''),
        UTF8_ENCODER.encode(entry.baseUrl ?? '')
    ]);
    const blobLength = encodedEntries.reduce(
        (sum, parts) => sum + parts.reduce((inner, part) => inner + part.byteLength, 0),
        0
    );
    const entrySize = 76;
    const bytes = new Uint8Array(16 + entries.length * entrySize + 4 + blobLength);
    const view = new DataView(bytes.buffer);
    const generated = Date.parse(bundle.generatedAtUtc);
    view.setBigInt64(0, BigInt(Number.isFinite(generated) ? generated : Date.now()), true);
    view.setInt32(8, entries.length, true);
    view.setInt32(12, 0, true);

    let blobOffset = 0;
    let blobCursor = 16 + entries.length * entrySize + 4;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1)
    {
        const entry = entries[entryIndex];
        const entryOffset = 16 + entryIndex * entrySize;
        view.setInt32(entryOffset, Number(entry.pageId) || 0, true);
        view.setInt32(entryOffset + 4, entry.articleId ?? 0, true);
        bytes[entryOffset + 8] = entry.articleId === null || entry.articleId === undefined ? 0 : 1;
        bytes[entryOffset + 9] = 0;
        view.setUint16(entryOffset + 10, 0, true);

        const parts = encodedEntries[entryIndex];
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1)
        {
            const refOffset = entryOffset + 12 + partIndex * 8;
            const part = parts[partIndex];
            view.setInt32(refOffset, blobOffset, true);
            view.setInt32(refOffset + 4, part.byteLength, true);
            bytes.set(part, blobCursor);
            blobOffset += part.byteLength;
            blobCursor += part.byteLength;
        }
    }

    view.setInt32(16 + entries.length * entrySize, blobLength, true);
    return bytes;
}

/**
 * @param {{ sessionKey: string; attestation?: PasskeyCredentialInput; friendlyName?: string; mfaProofToken?: string; }} data
 */
export function encodePasskeyRegisterCompleteRequest(data)
{
    const transports = Array.isArray(data.attestation?.response?.transports)
        ? data.attestation.response.transports.map(transportToInt).filter((value) => value !== null)
        : [];
    const { bytes, refs, blobLength } = encodeBinaryBlob(120 + transports.length * 4, [
        textBytes(data.attestation?.id ?? ''),
        base64UrlToBytes(data.attestation?.rawId ?? ''),
        base64UrlToBytes(data.attestation?.response?.clientDataBytes ?? ''),
        base64UrlToBytes(data.attestation?.response?.attestationObject ?? ''),
        textBytes(data.friendlyName ?? ''),
        textBytes(data.mfaProofToken ?? '')
    ]);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.friendlyName?.trim() ? 1 : 0;
    bytes[1] = data.mfaProofToken?.trim() ? 1 : 0;
    view.setUint16(2, 0, true);
    view.setInt32(4, transports.length, true);
    writeFixedUtf8(bytes, 8, 64, data.sessionKey);
    writeSliceRef(view, 72, refs[0]);
    writeSliceRef(view, 80, refs[1]);
    writeSliceRef(view, 88, refs[2]);
    writeSliceRef(view, 96, refs[3]);
    writeSliceRef(view, 104, refs[4]);
    writeSliceRef(view, 112, refs[5]);
    let cursor = 120;
    for (const transport of transports)
    {
        view.setInt32(cursor, transport, true);
        cursor += 4;
    }
    view.setInt32(cursor, blobLength, true);
    return bytes;
}

/**
 * @param {{ challengeToken: string; assertion?: PasskeyCredentialInput; rememberMe?: boolean; }} data
 */
export function encodePasskeyLoginCompleteRequest(data)
{
    const userHandle = data.assertion?.response?.userHandle;
    const { bytes, refs, blobLength } = encodeBinaryBlob(120, [
        textBytes(data.assertion?.id ?? ''),
        base64UrlToBytes(data.assertion?.rawId ?? ''),
        base64UrlToBytes(data.assertion?.response?.clientDataBytes ?? ''),
        base64UrlToBytes(data.assertion?.response?.authenticatorData ?? ''),
        base64UrlToBytes(data.assertion?.response?.signature ?? ''),
    userHandle ? base64UrlToBytes(userHandle) : new Uint8Array(0)
    ]);
    const view = new DataView(bytes.buffer);
    bytes[0] = data.rememberMe ? 1 : 0;
    bytes[1] = userHandle ? 1 : 0;
    view.setUint16(2, 0, true);
    view.setInt32(4, 0, true);
    writeFixedUtf8(bytes, 8, 64, data.challengeToken);
    writeSliceRef(view, 72, refs[0]);
    writeSliceRef(view, 80, refs[1]);
    writeSliceRef(view, 88, refs[2]);
    writeSliceRef(view, 96, refs[3]);
    writeSliceRef(view, 104, refs[4]);
    writeSliceRef(view, 112, refs[5]);
    view.setInt32(120, blobLength, true);
    return bytes;
}

/**
 * @param {{ password: string; code?: string; recoveryCode?: string; }} data
 */
export function encodeMfaPasswordProofRequest(data)
{
    const { bytes, refs, blobLength } = encodeStringBlob([data.password, data.code ?? '', data.recoveryCode ?? '']);
    const view = new DataView(bytes.buffer);
    writeSliceRef(view, 0, refs[0]);
    writeSliceRef(view, 8, refs[1]);
    writeSliceRef(view, 16, refs[2]);
    view.setInt32(24, blobLength, true);
    return bytes;
}

/**
 * @param {{ challengeToken: string; action?: string; code?: string; recoveryCode?: string; }} data
 */
export function encodeMfaChallengeVerifyRequest(data)
{
    const { bytes, refs, blobLength } = encodeStringBlob([
        data.challengeToken,
        data.action ?? '',
        data.code ?? '',
        data.recoveryCode ?? ''
    ]);
    const view = new DataView(bytes.buffer);
    writeSliceRef(view, 0, refs[0]);
    writeSliceRef(view, 8, refs[1]);
    writeSliceRef(view, 16, refs[2]);
    writeSliceRef(view, 24, refs[3]);
    view.setInt32(32, blobLength, true);
    return bytes;
}

/**
 * @param {AedsFrameInput} buffer
 */
export function decodeKnownFrame(buffer)
{
    const frame = decodeAedsFrame(buffer);
    switch (frame.frameType)
    {
        case FRAME_ARTICLE_LIST:
            return decodeArticlePage(frame.payload);
        case FRAME_ARTICLE_DETAIL:
            return decodeArticleDetail(frame.payload);
        case FRAME_ARTICLE_HOT:
            return decodeArticleHot(frame.payload);
        case FRAME_ARTICLE_FEATURED:
            return decodeArticleFeatured(frame.payload);
        case FRAME_COMMENT_USER_CURSOR:
            return decodeUserCommentCursor(frame.payload);
        case FRAME_SEO_CONFIG:
            return decodeSeoConfig(frame.payload);
        case FRAME_PAGE_CONTENT:
            return decodePageContent(frame.payload);
        case FRAME_AUTH_LOGIN_FLOW:
            return decodeAuthLoginFlow(frame.payload);
        case FRAME_CURRENT_USER_SNAPSHOT:
            return decodeCurrentUserSnapshot(frame.payload);
        case FRAME_IDENTITY_ACCOUNT_SNAPSHOT:
            return decodeIdentityAccountSnapshot(frame.payload);
        case FRAME_UPLOAD_INIT:
            return decodeUploadInit(frame.payload);
        case FRAME_UPLOAD_STATUS:
            return decodeUploadStatus(frame.payload);
        case FRAME_UPLOAD_PART_ACK:
            return decodeUploadPartAck(frame.payload);
        case FRAME_UPLOAD_COMPLETE:
            return decodeUploadComplete(frame.payload);
        case FRAME_UPLOAD_PART_MAP:
            return decodeUploadPartMap(frame.payload);
        case FRAME_AUTH_SESSION_LIST:
            return decodeUserSessions(frame.payload);
        case FRAME_POW_CHALLENGE:
            return decodePowChallengePayload(frame.payload);
        case FRAME_MFA_SETUP_START:
            return decodeMfaSetupStart(frame.payload);
        case FRAME_MFA_SETUP_VERIFY:
            return decodeMfaSetupVerify(frame.payload);
        case FRAME_MFA_PROFILE:
            return decodeMfaProfile(frame.payload);
        case FRAME_MFA_CHALLENGE_RESULT:
            return decodeMfaChallengeResult(frame.payload);
        case FRAME_CONVERSATION_LIST:
            return decodeConversationList(frame.payload);
        case FRAME_CONVERSATION_DETAIL:
            return decodeConversationDetail(frame.payload);
        case FRAME_CONVERSATION_DETAIL_V2:
            return decodeConversationDetailV2(frame.payload);
        case FRAME_CONVERSATION_DETAIL_V3:
            return decodeConversationDetailV3(frame.payload);
        case FRAME_CONVERSATION_MESSAGE:
            return decodeConversationMessageFrame(frame.payload);
        case FRAME_CATEGORY_LIST:
            return decodeTaxonomyList(frame.payload, CATEGORY_POD_SIZE);
        case FRAME_TAG_LIST:
            return decodeTaxonomyList(frame.payload, TAG_WITH_COUNT_POD_SIZE);
        case FRAME_PASSKEY_REGISTER_BEGIN:
            return decodePasskeyRegisterBegin(frame.payload);
        case FRAME_PASSKEY_LOGIN_BEGIN:
            return decodePasskeyLoginBegin(frame.payload);
        case FRAME_PASSKEY_CREDENTIAL_LIST:
            return decodePasskeyCredentialList(frame.payload);
        case FRAME_PASSKEY_SIGNAL_STATE:
            return decodePasskeySignalState(frame.payload);
        case FRAME_EMPTY_SUCCESS:
            return null;
        case FRAME_MUTATION_ID:
            return decodeMutationId(frame.payload);
        case FRAME_API_ERROR:
            return decodeApiErrorFrame(buffer);
        default:
            return { frameType: frame.frameType, payload: frame.payload };
    }
}

/**
 * @param {Uint8Array} payload
 */
function decodeMutationId(payload)
{
    if (payload.byteLength === 8)
    {
        return { id: readInt64FromBytes(payload, 0) };
    }
    assertPayloadLength(payload, 48, 'mutation_id_payload_invalid');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        id: readInt32(view, 0),
        articleId: readInt32(view, 0),
        revisionId: readInt64Number(view, 4),
        revisionNo: readInt32(view, 12),
        releaseId: readInt64Number(view, 16),
        releaseNo: readInt32(view, 24),
        status: readInt32(view, 28),
        rightsSnapshotId: readInt64Number(view, 32),
        rightsRevisionNo: readInt32(view, 40),
        idempotencyReplay: payload[44] !== 0,
        errorCode: payload[45],
        outcome: payload[46]
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeArticleHot(payload)
{
    const reader = new BinaryReader(payload);
    const count = reader.readInt32();
    if (count < 0 || count > 10_000)
    {
        throw new Error(`article_hot_count_invalid:${count}`);
    }
    const blob = reader.readBlob();
    const items = [];
    for (let index = 0; index < count; index += 1)
    {
        const pod = reader.readSpan(16);
        const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        items.push({
            id: readInt32(view, 0),
            views: readInt32(view, 4),
            title: readSliceText(blob, readSliceRef(pod, 8))
        });
    }
    if (reader.remaining() !== 0)
    {
        throw new Error(`article_hot_trailing_payload_invalid:${reader.remaining()}`);
    }
    return items;
}

/**
 * @param {Uint8Array} payload
 */
function decodeArticleFeatured(payload)
{
    const reader = new BinaryReader(payload);
    const count = reader.readInt32();
    if (count < 0 || count > 10_000)
    {
        throw new Error(`article_featured_count_invalid:${count}`);
    }
    const items = [];
    for (let index = 0; index < count; index += 1)
    {
        const pod = reader.readSpan(412);
        const blob = reader.readBlob();
        const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        items.push({
            id: readInt32(view, 0),
            views: readInt32(view, 4),
            createTime: new Date(readInt64Number(view, 8)).toISOString(),
            category: {
                id: readInt32(view, 16),
                name: readFixedUtf8(pod, 20, 128)
            },
            title: readFixedUtf8(pod, 148, 256),
            coverImageUrl: readBlobText(pod, blob, 404)
        });
    }
    if (reader.remaining() !== 0)
    {
        throw new Error(`article_featured_trailing_payload_invalid:${reader.remaining()}`);
    }
    return items;
}

/**
 * @param {Uint8Array} payload
 */
function decodeUploadInit(payload)
{
    assertPayloadLength(payload, 568, 'upload_init_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        fileName: readFixedUtf8(payload, 64, 256),
        mimeType: readFixedUtf8(payload, 320, 64),
        targetFormat: readFixedUtf8(payload, 384, 32),
        totalBytes: readInt64FromBytes(payload, 416),
        chunkSize: readInt32(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), 424),
        totalParts: readInt32(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), 428),
        expiresAt: new Date(readInt64FromBytes(payload, 432)).toISOString().replace('.000Z', 'Z'),
        uploadToken: readFixedUtf8(payload, 440, 128)
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUploadStatus(payload)
{
    assertPayloadLength(payload, 136, 'upload_status_payload_invalid');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        status: readFixedUtf8(payload, 64, 32),
        totalBytes: readInt64FromBytes(payload, 96),
        uploadedBytes: readInt64FromBytes(payload, 104),
        chunkSize: readInt32(view, 112),
        totalParts: readInt32(view, 116),
        uploadedPartCount: readInt32(view, 120),
        nextPartHint: readInt32(view, 124),
        expiresAt: new Date(readInt64FromBytes(payload, 128)).toISOString().replace('.000Z', 'Z')
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUploadPartMap(payload)
{
    if (payload.byteLength < 72)
    {
        throw new Error('upload_part_map_payload_invalid');
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = readInt32(view, 64);
    if (count < 0 || payload.byteLength !== 72 + count * 8)
    {
        throw new Error('upload_part_map_count_invalid');
    }
    const uploadedRanges = [];
    for (let i = 0; i < count; i += 1)
    {
        const offset = 72 + i * 8;
        uploadedRanges.push({ start: readInt32(view, offset), end: readInt32(view, offset + 4) });
    }
    return { uploadId: readFixedUtf8(payload, 0, 64), uploadedRanges };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUploadPartAck(payload)
{
    assertPayloadLength(payload, 92, 'upload_part_ack_payload_invalid');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        partNumber: readInt32(view, 64),
        offset: readInt64FromBytes(payload, 68),
        size: readInt32(view, 76),
        uploadedBytes: readInt64FromBytes(payload, 80),
        uploadedPartCount: readInt32(view, 88)
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUploadComplete(payload)
{
    assertPayloadLength(payload, 648, 'upload_complete_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        url: readFixedUtf8(payload, 64, 256),
        relativeUrl: readFixedUtf8(payload, 320, 256),
        mimeType: readFixedUtf8(payload, 576, 64),
        totalBytes: readInt64FromBytes(payload, 640)
    };
}

function assertPayloadLength(payload, expected, code)
{
    if (payload.byteLength !== expected)
    {
        throw new Error(`${code}:${payload.byteLength}`);
    }
}

function assertPayloadLengthAtLeast(payload, minimum, code)
{
    if (payload.byteLength < minimum)
    {
        throw new Error(`${code}:${payload.byteLength}`);
    }
}

/**
 * @param {Uint8Array} bytes
 */
export function decodeSearchManifest(bytes)
{
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    const readUint32 = () =>
    {
        if (offset + 4 > payload.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getUint32(offset, true);
        offset += 4;
        return value;
    };
    const readInt32Value = () =>
    {
        if (offset + 4 > payload.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getInt32(offset, true);
        offset += 4;
        return value;
    };
    const readInt64 = () =>
    {
        if (offset + 8 > payload.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getBigInt64(offset, true);
        offset += 8;
        return value;
    };
    const readBool = () =>
    {
        if (offset + 1 > payload.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        return payload[offset++] !== 0;
    };
    const readStringValue = () =>
    {
        const length = readInt32Value();
        if (length < 0 || length > 4096 || offset + length > payload.byteLength)
        {
            throw new Error('search_manifest_string_invalid');
        }
        const value = UTF8_DECODER.decode(payload.subarray(offset, offset + length));
        offset += length;
        return value;
    };
    const readNullableString = () => readBool() ? readStringValue() : null;
    const readStringList = () =>
    {
        const count = readInt32Value();
        if (count < 0 || count > 32)
        {
            throw new Error('search_manifest_list_invalid');
        }
        return Array.from({ length: count }, () => readStringValue());
    };

    if (readUint32() !== SEARCH_MANIFEST_MAGIC || readUint32() !== SEARCH_MANIFEST_BINARY_VERSION)
    {
        throw new Error('search_manifest_magic_invalid');
    }

    const schemaVersion = readInt32Value();
    const ticks = readInt64();
    const currentVersion = readStringValue();
    const shardCount = readInt32Value();
    if (shardCount < 0 || shardCount > 32)
    {
        throw new Error('search_manifest_shards_invalid');
    }

    const shards = [];
    for (let index = 0; index < shardCount; index += 1)
    {
        shards.push({
            role: readUint32(),
            fullUrl: readStringValue(),
            fullSha256: readStringValue(),
            patchUrl: readNullableString(),
            patchSha256: readNullableString(),
            loadPhase: readInt32Value()
        });
    }

    const manifest = {
        schemaVersion,
        currentVersion,
        generatedAt: new Date(Number(ticks / 10000n) - DOTNET_EPOCH_OFFSET_MS).toISOString(),
        shards,
        initialRoles: readStringList(),
        backgroundRoles: readStringList(),
        deepRoles: readStringList()
    };

    if (offset !== payload.byteLength)
    {
        throw new Error('search_manifest_trailing_bytes');
    }
    return manifest;
}

/**
 * @param {string} text
 * @returns {PublicAotValue[] | { [key: string]: PublicAotValue; }}
 */
export function decodePublicAotPayload(text)
{
    const bytes = new Uint8Array(Buffer.from(String(text).trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    const frame = decodeAedsFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (frame.frameType !== FRAME_PUBLIC_AOT_BOOTSTRAP)
    {
        throw new Error(`public_aot_frame_type_mismatch:${frame.frameType}`);
    }

    const reader = new PublicAotValueReader(frame.payload);
    const value = reader.readValue();
    if (reader.remaining() !== 0 || !value || typeof value !== 'object')
    {
        throw new Error('public_aot_payload_invalid');
    }
    return value;
}

/**
 * @param {Uint8Array} payload
 */
export function decodeArticlePage(payload)
{
    const reader = new BinaryReader(payload);
    if (reader.readInt32() !== ARTICLE_PAGE_CURSOR_ENVELOPE_MAGIC)
    {
        throw new Error('article_page_cursor_envelope_missing');
    }
    if (reader.readInt32() !== ARTICLE_PAGE_CURSOR_ENVELOPE_VERSION)
    {
        throw new Error('article_page_cursor_version_invalid');
    }
    const hasMoreByte = reader.readByte();
    if (hasMoreByte > 1)
    {
        throw new Error('article_page_cursor_has_more_invalid');
    }
    const hasMore = hasMoreByte === 1;
    const total = reader.readInt32();
    const cursorBytes = reader.readBlob();
    if (cursorBytes.byteLength > 512)
    {
        throw new Error('article_page_cursor_length_invalid');
    }
    let nextCursor;
    try
    {
        nextCursor = cursorBytes.byteLength === 0
            ? null
            : new TextDecoder('utf-8', { fatal: true }).decode(cursorBytes);
    }
    catch
    {
        throw new Error('article_page_cursor_utf8_invalid');
    }
    if (nextCursor && !/^[A-Za-z0-9_-]+$/.test(nextCursor))
    {
        throw new Error('article_page_cursor_format_invalid');
    }
    if (hasMore !== Boolean(nextCursor))
    {
        throw new Error('article_page_cursor_state_invalid');
    }

    const count = reader.readInt32();
    const tagRecordCount = reader.readInt32();
    if (count < 0 || tagRecordCount < 0)
    {
        throw new Error('article_page_count_invalid');
    }
    const blob = reader.readBlob();
    const itemRecordBytes = reader.remaining() - tagRecordCount * COMPACT_TAG_RECORD_SIZE;
    const itemRecordSize = count === 0 ? ARTICLE_LIST_RECORD_WITH_PUBLICATION_SIZE : itemRecordBytes / count;
    if (itemRecordBytes < 0 || (count > 0 && itemRecordBytes % count !== 0) || ![ARTICLE_LIST_RECORD_SIZE, ARTICLE_LIST_RECORD_WITH_STATUS_SIZE, ARTICLE_LIST_RECORD_WITH_PUBLICATION_SIZE].includes(itemRecordSize))
    {
        throw new Error('article_page_record_layout_invalid');
    }

    const records = [];
    for (let i = 0; i < count; i += 1)
    {
        records.push(reader.readSpan(itemRecordSize));
    }
    const tagRecords = [];
    for (let i = 0; i < tagRecordCount; i += 1)
    {
        const record = reader.readSpan(COMPACT_TAG_RECORD_SIZE);
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        tagRecords.push({
            id: readInt32(view, 0),
            name: readSliceText(blob, readSliceRef(record, 4))
        });
    }
    const items = [];
    for (const record of records)
    {
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        const tagStart = readInt32(view, 44);
        const tagCount = readInt32(view, 48);
        if (tagStart < 0 || tagCount < 0 || tagStart + tagCount > tagRecords.length)
        {
            throw new Error('article_page_tag_range_invalid');
        }
        const item = {
            id: readInt32(view, 0),
            title: readSliceText(blob, readSliceRef(record, 28)),
            summary: readSliceText(blob, readSliceRef(record, 36)),
            views: readInt32(view, 4),
            createTime: new Date(readInt64Number(view, 8)).toISOString(),
            category: {
                id: readInt32(view, 16),
                name: readSliceText(blob, readSliceRef(record, 20))
            },
            tags: tagRecords.slice(tagStart, tagStart + tagCount)
        };
        if (itemRecordSize >= ARTICLE_LIST_RECORD_WITH_STATUS_SIZE)
        {
            item.isDeleted = record[53] === 1 ? record[52] === 1 : undefined;
            item.status = readInt32(view, 56);
            item.scheduledPublishAt = unixMsToIsoOrNull(readInt64Number(view, 60));
            item.publishedAt = unixMsToIsoOrNull(readInt64Number(view, 68));
        }
        if (itemRecordSize === ARTICLE_LIST_RECORD_WITH_PUBLICATION_SIZE)
        {
            item.currentRevisionId = String(readInt64Number(view, 76));
            item.revisionNo = readInt32(view, 84);
            const currentPublicationId = readInt64Number(view, 88);
            item.currentPublicationId = currentPublicationId === 0 ? null : String(currentPublicationId);
            const publicationNo = readInt32(view, 96);
            item.publicationNo = publicationNo <= 0 ? null : publicationNo;
        }
        items.push(item);
    }
    if (reader.remaining() !== 0)
    {
        throw new Error('article_page_trailing_bytes');
    }
    return {
        items,
        total,
        nextCursor: hasMore ? nextCursor : null,
        hasMore
    };
}

/**
 * @param {Uint8Array} payload
 */
export function decodeArticleDetail(payload)
{
    if (payload.byteLength < ARTICLE_DETAIL_V3_HEADER_SIZE)
    {
        throw new Error('article_detail_payload_too_short');
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = readInt32(view, 0);
    const version = readInt32(view, 4);
    const flags = readInt32(view, 8);
    const articleRecordOffset = readInt32(view, 12);
    const articleRecordLength = readInt32(view, 16);
    const tagOffset = readInt32(view, 20);
    const tagCount = readInt32(view, 24);
    const rightsRecordOffset = readInt32(view, 28);
    const rightsRecordLength = readInt32(view, 32);
    const blobOffset = readInt32(view, 36);
    const blobLength = readInt32(view, 40);
    const isV4 = magic === ARTICLE_DETAIL_V4_MAGIC && version === ARTICLE_DETAIL_V4_VERSION;
    const isV5 = magic === ARTICLE_DETAIL_V5_MAGIC && version === ARTICLE_DETAIL_V5_VERSION;
    const isV3 = magic === ARTICLE_DETAIL_V3_MAGIC && version === ARTICLE_DETAIL_V3_VERSION;
    if (
        (!isV3 && !isV4 && !isV5) ||
    flags !== 0 ||
    tagCount < 0 ||
    articleRecordOffset !== ARTICLE_DETAIL_V3_HEADER_SIZE ||
    articleRecordLength !== (isV5 ? ARTICLE_DETAIL_V5_RECORD_SIZE : isV4 ? ARTICLE_DETAIL_V4_RECORD_SIZE : ARTICLE_DETAIL_V3_RECORD_SIZE) ||
    rightsRecordLength !== ARTICLE_DETAIL_RIGHTS_V3_RECORD_SIZE
    )
    {
        throw new Error('article_detail_v3_header_invalid');
    }

    const tagBytes = tagCount * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE;
    if (
        tagCount > Math.floor(payload.byteLength / ARTICLE_DETAIL_TAG_V3_RECORD_SIZE) ||
    tagOffset !== articleRecordOffset + articleRecordLength ||
    rightsRecordOffset !== tagOffset + tagBytes ||
    blobOffset !== rightsRecordOffset + rightsRecordLength ||
    blobOffset + blobLength !== payload.byteLength ||
    !isRangeWithin(articleRecordOffset, articleRecordLength, payload.byteLength) ||
    !isRangeWithin(tagOffset, tagBytes, payload.byteLength) ||
    !isRangeWithin(rightsRecordOffset, rightsRecordLength, payload.byteLength) ||
    !isRangeWithin(blobOffset, blobLength, payload.byteLength)
    )
    {
        throw new Error('article_detail_v3_layout_invalid');
    }

    const article = payload.subarray(articleRecordOffset, articleRecordOffset + articleRecordLength);
    const rightsRecord = payload.subarray(rightsRecordOffset, rightsRecordOffset + rightsRecordLength);
    const blob = payload.subarray(blobOffset, blobOffset + blobLength);
    const sliceOffset = isV5 ? 76 : isV4 ? 52 : 44;
    const isDeletedFlag = article[isV5 ? 72 : isV4 ? 48 : 40] ?? 0;
    if (isDeletedFlag > 1 || !validateArticleDetailRecordSlices(article, blob, sliceOffset))
    {
        throw new Error('article_detail_v3_record_invalid');
    }

    const tags = [];
    for (let i = 0; i < tagCount; i += 1)
    {
        const recordOffset = tagOffset + i * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE;
        const tag = payload.subarray(recordOffset, recordOffset + ARTICLE_DETAIL_TAG_V3_RECORD_SIZE);
        tags.push({
            id: readInt32FromBytes(tag, 0),
            name: readStrictSliceText(blob, tag, 4, 'article_detail_v3_tag_slice_invalid')
        });
    }

    return {
        id: readInt32FromBytes(article, 0),
        title: readStrictSliceText(blob, article, sliceOffset, 'article_detail_v3_title_slice_invalid'),
        content: readStrictSliceText(blob, article, sliceOffset + 8, 'article_detail_v3_content_slice_invalid'),
        summary: readStrictSliceText(blob, article, sliceOffset + 16, 'article_detail_v3_summary_slice_invalid'),
        coverImageUrl: readStrictSliceText(blob, article, sliceOffset + 24, 'article_detail_v3_cover_slice_invalid'),
        views: readInt32FromBytes(article, 4),
        createTime: new Date(readInt64FromBytes(article, 8)).toISOString(),
        category: {
            id: readInt32FromBytes(article, 16),
            name: readStrictSliceText(blob, article, sliceOffset + 32, 'article_detail_v3_category_slice_invalid')
        },
        tags,
        isDeleted: isDeletedFlag === 1,
        status: readInt32FromBytes(article, 20),
        scheduledPublishAt: unixMsToIsoOrNull(readInt64FromBytes(article, 24)),
        publishedAt: unixMsToIsoOrNull(readInt64FromBytes(article, 32)),
        updatedAt: isV4 || isV5 ? unixMsToIsoOrNull(readInt64FromBytes(article, 40)) : null,
        currentRevisionId: isV5 ? String(readInt64FromBytes(article, 48)) : '0',
        revisionNo: isV5 ? readInt32FromBytes(article, 56) : 0,
        currentPublicationId: isV5 && readInt64FromBytes(article, 60) !== 0 ? String(readInt64FromBytes(article, 60)) : null,
        publicationNo: isV5 && readInt32FromBytes(article, 68) > 0 ? readInt32FromBytes(article, 68) : null,
        rights: decodeArticleDetailRightsV3(rightsRecord, blob)
    };
}

function decodeArticleDetailRightsV3(record, blob)
{
    const rightsFlags = readInt32FromBytes(record, 20);
    const maxExcerptChars = readInt32FromBytes(record, 28);
    if ((rightsFlags & ~ARTICLE_DETAIL_RIGHTS_KNOWN_FLAGS) !== 0 || maxExcerptChars < 0 || !validateArticleRightsV3RecordSlices(record, blob))
    {
        throw new Error('article_detail_v3_rights_invalid');
    }

    const licenseType = readStrictSliceText(blob, record, 32, 'article_detail_v3_rights_license_invalid') || 'all-rights-reserved';
    const copyPolicy = readStrictSliceText(blob, record, 64, 'article_detail_v3_rights_copy_policy_invalid') || 'append-attribution';
    return {
        snapshotId: readInt64String(record, 0),
        articleRevisionId: readInt64String(record, 8),
        revisionNo: Math.max(0, readInt32FromBytes(record, 16)),
        enabled: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_ENABLED) !== 0,
        licenseType,
        copyrightHolder: readOptionalArticleDetailRightsSlice(blob, record, 40, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_HOLDER),
        copyrightYear: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_YEAR) !== 0 ? readInt32FromBytes(record, 24) : null,
        rightsStatement: readOptionalArticleDetailRightsSlice(blob, record, 48, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_RIGHTS_STATEMENT),
        attributionTemplate: readOptionalArticleDetailRightsSlice(blob, record, 56, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_ATTRIBUTION_TEMPLATE),
        copyPolicy,
        maxExcerptChars,
        allowCodeCopy: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_ALLOW_CODE_COPY) !== 0,
        showPublicBadge: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_SHOW_PUBLIC_BADGE) !== 0,
        proofBindingEnabled: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_PROOF_BINDING_ENABLED) !== 0,
        canonicalUrl: readOptionalArticleDetailRightsSlice(blob, record, 72, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_CANONICAL_URL),
        policyHash: readStrictSliceText(blob, record, 80, 'article_detail_v3_rights_policy_hash_invalid'),
        contentCanonicalHash: readStrictSliceText(blob, record, 88, 'article_detail_v3_rights_content_hash_invalid'),
        proofUrl: readOptionalArticleDetailRightsSlice(blob, record, 96, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_URL),
        proofStatus: readOptionalArticleDetailRightsSlice(blob, record, 104, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_STATUS)
    };
}

function validateArticleDetailRecordSlices(record, blob, offset)
{
    return isSliceWithinBlob(blob, record, offset) &&
    isSliceWithinBlob(blob, record, offset + 8) &&
    isSliceWithinBlob(blob, record, offset + 16) &&
    isSliceWithinBlob(blob, record, offset + 24) &&
    isSliceWithinBlob(blob, record, offset + 32);
}

function validateArticleRightsV3RecordSlices(record, blob)
{
    return isSliceWithinBlob(blob, record, 32) &&
    isSliceWithinBlob(blob, record, 40) &&
    isSliceWithinBlob(blob, record, 48) &&
    isSliceWithinBlob(blob, record, 56) &&
    isSliceWithinBlob(blob, record, 64) &&
    isSliceWithinBlob(blob, record, 72) &&
    isSliceWithinBlob(blob, record, 80) &&
    isSliceWithinBlob(blob, record, 88) &&
    isSliceWithinBlob(blob, record, 96) &&
    isSliceWithinBlob(blob, record, 104);
}

function readOptionalArticleDetailRightsSlice(blob, record, offset, flags, flag)
{
    return (flags & flag) === 0 ? null : readStrictSliceText(blob, record, offset, 'article_detail_v3_optional_rights_slice_invalid');
}

function readStrictSliceText(blob, record, offset, code)
{
    if (!isSliceWithinBlob(blob, record, offset))
    {
        throw new Error(code);
    }

    return readSliceText(blob, readSliceRef(record, offset));
}

function isSliceWithinBlob(blob, record, offset)
{
    const slice = readSliceRef(record, offset);
    return isRangeWithin(slice.offset, slice.length, blob.byteLength);
}

function isRangeWithin(offset, length, total)
{
    return offset >= 0 && length >= 0 && offset <= total && length <= total - offset;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
function readInt32FromBytes(bytes, offset)
{
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function unixMsToIsoOrNull(value)
{
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

/**
 * @param {Uint8Array} payload
 */
function decodeSeoConfig(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(SEO_CONFIG_POD_SIZE);
    const blob = reader.readBlob();
    return {
        title: readFixedUtf8(pod, 0, 256),
        description: readSliceText(blob, readSliceRef(pod, 256)),
        keywords: readFixedUtf8(pod, 264, 256),
        author: readFixedUtf8(pod, 520, 64),
        ogImage: readFixedUtf8(pod, 584, 256),
        baseUrl: readFixedUtf8(pod, 840, 256),
        faviconSvgUrl: readFixedUtf8(pod, 1096, 256),
        faviconIcoUrl: readFixedUtf8(pod, 1352, 256),
        faviconPngUrl: readFixedUtf8(pod, 1608, 256),
        appleTouchIconUrl: readFixedUtf8(pod, 1864, 256),
        manifestName: readFixedUtf8(pod, 2120, 128),
        manifestShortName: readFixedUtf8(pod, 2248, 128),
        pwaIcon192Url: readFixedUtf8(pod, 2376, 256),
        pwaIcon512Url: readFixedUtf8(pod, 2632, 256),
        pwaMaskableIconUrl: readFixedUtf8(pod, 2888, 256),
        themeColor: readFixedUtf8(pod, 3144, 32),
        backgroundColor: readFixedUtf8(pod, 3176, 32),
        siteLogoUrl: readFixedUtf8(pod, 3208, 256),
        siteLogoDarkUrl: readFixedUtf8(pod, 3464, 256),
        siteWordmarkUrl: readFixedUtf8(pod, 3720, 256),
        adminLogoUrl: readFixedUtf8(pod, 3976, 256),
        adminCollapsedIconUrl: readFixedUtf8(pod, 4232, 256),
        loginLogoUrl: readFixedUtf8(pod, 4488, 256),
        loginIconUrl: readFixedUtf8(pod, 4744, 256)
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodePageContent(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(PAGE_CONTENT_POD_SIZE);
    const blob = reader.readBlob();
    return {
        slug: readFixedUtf8(pod, 0, 128),
        content: readSliceText(blob, readSliceRef(pod, 128))
    };
}

/**
 * @param {Uint8Array} payload
 * @param {number} [itemSize]
 */
export function decodeTaxonomyList(payload, itemSize = 136)
{
    void itemSize;
    const reader = new BinaryReader(payload);
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error(`taxonomy_payload_size_mismatch:${payload.byteLength}`);
    }
    const blob = reader.readBlob();

    const items = [];
    for (let i = 0; i < count; i += 1)
    {
        const record = reader.readSpan(16);
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        items.push({
            id: readInt32(view, 0),
            name: readSliceText(blob, readSliceRef(record, 8)),
            articleCount: readInt32(view, 4)
        });
    }
    if (reader.remaining() !== 0)
    {
        throw new Error('taxonomy_trailing_bytes');
    }
    return items;
}

/**
 * @param {Uint8Array} payload
 */
function decodePasskeyRegisterBegin(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(PASSKEY_REGISTER_BEGIN_POD_SIZE);
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    const paramCount = readInt32(view, 8);
    const excludeCount = readInt32(view, 12);
    if (paramCount < 0 || excludeCount < 0)
    {
        throw new Error('passkey_register_begin_count_invalid');
    }

    const params = [];
    for (let i = 0; i < paramCount; i += 1)
    {
        const param = reader.readSpan(PASSKEY_PUBLIC_KEY_CREDENTIAL_PARAM_POD_SIZE);
        const paramView = new DataView(param.buffer, param.byteOffset, param.byteLength);
        params.push({ type: credentialTypeToText(readInt32(paramView, 0)), alg: readInt32(paramView, 4) });
    }

    const descriptors = readDescriptors(reader, excludeCount);
    const blob = reader.readBlob();
    const attachment = readByte(pod, 32) === 1 ? authenticatorAttachmentToText(readInt32(view, 28)) : undefined;
    const accountName = readSliceText(blob, readSliceRef(pod, 116));
    const accountDisplayName = readSliceText(blob, readSliceRef(pod, 124));
    const accountHandle = readBytes(blob, pod, 132);
    return {
        sessionKey: readFixedUtf8(pod, 36, 64),
        options: {
            rp: {
                id: readSliceText(blob, readSliceRef(pod, 100)),
                name: readSliceText(blob, readSliceRef(pod, 108))
            },
            user: {
                id: bytesToBase64Url(accountHandle),
                name: accountName,
                displayName: accountDisplayName
            },
            challenge: bytesToBase64Url(readBytes(blob, pod, 140)),
            pubKeyCredParams: params,
            timeout: Number(view.getBigUint64(0, true)),
            attestation: attestationToText(readInt32(view, 16)),
            authenticatorSelection: {
                ...(attachment ? { authenticatorAttachment: attachment } : {}),
                residentKey: residentKeyToText(readInt32(view, 20)),
                requireResidentKey: readByte(pod, 33) === 1,
                userVerification: userVerificationToText(readInt32(view, 24))
            },
            excludeCredentials: descriptors.map((descriptor) => descriptorToView(descriptor, blob))
        }
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodePasskeyLoginBegin(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(PASSKEY_LOGIN_BEGIN_POD_SIZE);
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    const allowCount = readInt32(view, 8);
    if (allowCount < 0)
    {
        throw new Error('passkey_login_begin_count_invalid');
    }

    const descriptors = readDescriptors(reader, allowCount);
    const blob = reader.readBlob();
    const userVerification = readInt32(view, 12);
    return {
        challengeToken: readFixedUtf8(pod, 20, 64),
        options: {
            challenge: bytesToBase64Url(readBytes(blob, pod, 92)),
            timeout: Number(view.getBigUint64(0, true)),
            rpId: readSliceText(blob, readSliceRef(pod, 84)),
            ...(userVerification >= 0 ? { userVerification: userVerificationToText(userVerification) } : {}),
            allowCredentials: descriptors.map((descriptor) => descriptorToView(descriptor, blob))
        }
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodePasskeyCredentialList(payload)
{
    const reader = new BinaryReader(payload);
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error('passkey_credential_count_invalid');
    }

    const pods = [];
    for (let i = 0; i < count; i += 1)
    {
        pods.push(reader.readSpan(PASSKEY_CREDENTIAL_SUMMARY_POD_SIZE));
    }
    const blob = reader.readBlob();
    return pods.map((pod) =>
    {
        const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        return {
            id: readInt32(view, 0),
            deviceFriendlyName: readByte(pod, 4) === 1 ? readSliceText(blob, readSliceRef(pod, 88)) : null,
            createdAt: new Date(readInt64Number(view, 8)).toISOString(),
            lastUsedAt: readByte(pod, 5) === 1 ? new Date(readInt64Number(view, 16)).toISOString() : null,
            aaGuid: readFixedUtf8(pod, 24, 64),
            backupEligible: readByte(pod, 6) === 1,
            backupState: readByte(pod, 7) === 1
        };
    });
}

/**
 * @param {Uint8Array} payload
 */
function decodePasskeySignalState(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(PASSKEY_SIGNAL_STATE_POD_SIZE);
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    const count = readInt32(view, 8);
    if (count < 0 || count > 64)
    {
        throw new Error('passkey_signal_credential_count_invalid');
    }
    const credentials = [];
    for (let index = 0; index < count; index += 1)
    {
        credentials.push(reader.readSpan(PASSKEY_SIGNAL_CREDENTIAL_POD_SIZE));
    }
    const blob = reader.readBlob();
    if (reader.remaining() !== 0)
    {
        throw new Error('passkey_signal_state_trailing_payload_invalid');
    }
    return {
        revision: readInt64Number(view, 0),
        rpId: readSliceText(blob, readSliceRef(pod, 16)),
        userId: readSliceText(blob, readSliceRef(pod, 24)),
        name: readSliceText(blob, readSliceRef(pod, 32)),
        displayName: readSliceText(blob, readSliceRef(pod, 40)),
        allAcceptedCredentialIds: credentials.map((credential) => readSliceText(blob, readSliceRef(credential, 0)))
    };
}

/**
 * @param {BinaryReader} reader
 * @param {number} count
 */
function readDescriptors(reader, count)
{
    const descriptors = [];
    for (let i = 0; i < count; i += 1)
    {
        const pod = reader.readSpan(PASSKEY_CREDENTIAL_DESCRIPTOR_POD_SIZE);
        const transportCount = reader.readInt32();
        const podView = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        if (transportCount < 0 || transportCount !== readInt32(podView, 4))
        {
            throw new Error('passkey_descriptor_transport_count_invalid');
        }

        const transports = [];
        for (let transportIndex = 0; transportIndex < transportCount; transportIndex += 1)
        {
            transports.push(reader.readInt32());
        }
        descriptors.push({ pod, transports });
    }
    return descriptors;
}

/**
 * @param {{ pod: Uint8Array; transports: number[]; }} descriptor
 * @param {Uint8Array} blob
 */
function descriptorToView(descriptor, blob)
{
    const podView = new DataView(descriptor.pod.buffer, descriptor.pod.byteOffset, descriptor.pod.byteLength);
    const transports = descriptor.transports.map(transportToText).filter(Boolean);
    return {
        type: credentialTypeToText(readInt32(podView, 0)),
        id: bytesToBase64Url(readSliceBytes(blob, readSliceRef(descriptor.pod, 8))),
        ...(transports.length > 0 ? { transports } : {})
    };
}

/**
 * @param {Uint8Array} blob
 * @param {Uint8Array} pod
 * @param {number} offset
 * @returns {Uint8Array}
 */
function readBytes(blob, pod, offset)
{
    return readSliceBytes(blob, readSliceRef(pod, offset));
}

/**
 * @param {Uint8Array} payload
 */
function decodeAuthLoginFlow(payload)
{
    if (payload.byteLength !== AUTH_LOGIN_FLOW_POD_SIZE)
    {
        throw new Error(`auth_login_flow_payload_size_mismatch:${payload.byteLength}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const authPhase = payload[4];
    const mfaMode = payload[5];
    const hasChallengeToken = payload[6] === 1;
    const hasIdentityKind = payload[7] === 1;
    return {
        accountId: readInt32(view, 0),
        identityKind: hasIdentityKind ? readFixedUtf8(payload, 8, 64) || 'anonymous_account' : 'anonymous_account',
        authPhase: authPhase === 2 ? 'mfa_required' : 'authenticated',
        mfaMode: mfaMode === 1 ? 'risk' : mfaMode === 2 ? 'standard' : null,
        challengeToken: hasChallengeToken ? readFixedUtf8(payload, 104, 64) : null
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeCurrentUserSnapshot(payload)
{
    if (payload.byteLength !== CURRENT_USER_SNAPSHOT_POD_SIZE)
    {
        throw new Error(`current_user_snapshot_payload_size_mismatch:${payload.byteLength}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const banReason = readFixedUtf8(payload, 116, 256);
    const hasIdentityKind = payload[17] === 1;
    return {
        accountId: readInt32(view, 0),
        identityKind: hasIdentityKind ? readFixedUtf8(payload, 20, 64) || 'anonymous_account' : 'anonymous_account',
        status: readInt32(view, 4),
        deletedAt: payload[16] === 1 ? new Date(readInt64Number(view, 8)).toISOString() : null,
        banReason: banReason.length > 0 ? banReason : null
    };
}

/**
 * @param {Uint8Array} payload
 * @returns {IdentityAccountSnapshot}
 */
function decodeIdentityAccountSnapshot(payload)
{
    if (payload.byteLength < IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE + 4)
    {
        throw new Error(`identity_account_snapshot_payload_size_mismatch:${payload.byteLength}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const blobLength = readInt32(view, IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE);
    if (blobLength < 0 || payload.byteLength !== IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE + 4 + blobLength)
    {
        throw new Error(`identity_account_snapshot_blob_size_mismatch:${payload.byteLength}`);
    }

    for (const flagOffset of [20, 21, 22, 23, 24, 25, 26, 27])
    {
        if (readByte(payload, flagOffset) > 1)
        {
            throw new Error(`identity_account_snapshot_flag_invalid:${flagOffset}`);
        }
    }

    const blob = payload.subarray(IDENTITY_ACCOUNT_SNAPSHOT_POD_SIZE + 4);
    const hasPublicHandle = readByte(payload, 20) === 1;
    const hasTotpStepUpEnabled = readByte(payload, 23) === 1;
    const hasAnonymousCredential = readByte(payload, 25) === 1;
    const hasDeletedAt = readByte(payload, 26) === 1;
    const hasBanReason = readByte(payload, 27) === 1;
    const optionalText = (value) => value.length > 0 ? value : null;
    const accountId = readInt32(view, 0);

    return {
        accountId,
        identityKind: optionalText(readSliceText(blob, readSliceRef(payload, 56))) ?? 'anonymous_account',
        publicHandle: hasPublicHandle ? optionalText(readSliceText(blob, readSliceRef(payload, 32))) : null,
        passkeyEnabled: readByte(payload, 21) === 1,
        recoveryEnabled: readByte(payload, 22) === 1,
        totpStepUpEnabled: hasTotpStepUpEnabled ? readByte(payload, 24) === 1 : null,
        anonymousCredentialStatus: hasAnonymousCredential ? optionalText(readSliceText(blob, readSliceRef(payload, 40))) : null,
        anonymousCredentialLevel: hasAnonymousCredential ? optionalText(readSliceText(blob, readSliceRef(payload, 48))) : null,
        status: readInt32(view, 8),
        banReason: hasBanReason ? optionalText(readSliceText(blob, readSliceRef(payload, 64))) : null,
        deletedAt: hasDeletedAt ? new Date(readInt64Number(view, 12)).toISOString() : null
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUserSessions(payload)
{
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = readInt32(view, 0);
    if (count < 0 || payload.byteLength !== 4 + count * USER_SESSION_SUMMARY_POD_SIZE)
    {
        throw new Error(`auth_session_payload_size_mismatch:${payload.byteLength}`);
    }

    const sessions = [];
    for (let i = 0; i < count; i += 1)
    {
        const offset = 4 + i * USER_SESSION_SUMMARY_POD_SIZE;
        sessions.push({
            createdAt: new Date(readInt64Number(view, offset)).toISOString(),
            lastSeenAt: payload[offset + 17] === 1 ? new Date(readInt64Number(view, offset + 8)).toISOString() : null,
            isCurrent: payload[offset + 16] === 1,
            sessionId: readFixedUtf8(payload, offset + 20, 64),
            deviceLabel: readFixedUtf8(payload, offset + 84, 64),
            authenticationMethod: readFixedUtf8(payload, offset + 148, 32),
            authenticationStrength: readFixedUtf8(payload, offset + 180, 32),
            durationPolicy: readFixedUtf8(payload, offset + 212, 32),
            passkeyFriendlyName: payload[offset + 18] === 1
                ? readFixedUtf8(payload, offset + 244, 256)
                : null
        });
    }
    return sessions;
}

/**
 * @param {Uint8Array} payload
 */
function decodeMfaSetupStart(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(MFA_SETUP_START_POD_SIZE);
    const blob = reader.readBlob();
    return {
        enabled: readByte(pod, 0) === 1,
        secret: readSliceText(blob, readSliceRef(pod, 4)),
        otpAuthUrl: readSliceText(blob, readSliceRef(pod, 12)),
        issuer: readSliceText(blob, readSliceRef(pod, 20)),
        account: readSliceText(blob, readSliceRef(pod, 28))
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeMfaSetupVerify(payload)
{
    assertPayloadLengthAtLeast(payload, MFA_SETUP_VERIFY_POD_SIZE, 'mfa_setup_verify_payload_invalid');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = readInt32(view, 4);
    if (count < 0 || payload.byteLength !== MFA_SETUP_VERIFY_POD_SIZE + count * MFA_RECOVERY_CODE_POD_SIZE)
    {
        throw new Error(`mfa_recovery_code_count_invalid:${count}`);
    }

    const recoveryCodes = [];
    for (let index = 0; index < count; index += 1)
    {
        recoveryCodes.push(readFixedUtf8(
            payload,
            MFA_SETUP_VERIFY_POD_SIZE + index * MFA_RECOVERY_CODE_POD_SIZE,
            MFA_RECOVERY_CODE_POD_SIZE
        ));
    }
    return {
        enabled: readByte(payload, 0) === 1,
        recoveryCodes
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeMfaProfile(payload)
{
    assertPayloadLength(payload, MFA_PROFILE_POD_SIZE, 'mfa_profile_payload_invalid');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        enabled: readByte(payload, 8) === 1,
        verifiedAt: readByte(payload, 9) === 1 ? new Date(readInt64Number(view, 0)).toISOString() : null
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeMfaChallengeResult(payload)
{
    assertPayloadLength(payload, MFA_CHALLENGE_RESULT_POD_SIZE, 'mfa_challenge_result_payload_invalid');
    return {
        verified: readByte(payload, 4) === 1,
        action: readFixedUtf8(payload, 104, 64),
        proofToken: readByte(payload, 5) === 1 ? readFixedUtf8(payload, 168, 128) : null,
        user: readByte(payload, 6) === 1
            ? {
          accountId: readInt32(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), 0),
          identityKind: readByte(payload, 7) === 1 ? readFixedUtf8(payload, 8, 64) || 'anonymous_account' : 'anonymous_account'
        }
            : null
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeUserCommentCursor(payload)
{
    const reader = new BinaryReader(payload);
    const nextCursorRaw = reader.readSpan(8);
    const nextCursor = new DataView(nextCursorRaw.buffer, nextCursorRaw.byteOffset, nextCursorRaw.byteLength).getBigInt64(0, true);
    const hasMore = reader.readByte() === 1;
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error('user_comment_cursor_count_invalid');
    }

    const data = [];
    for (let index = 0; index < count; index += 1)
    {
        const pod = reader.readSpan(USER_COMMENT_POD_SIZE);
        const blob = reader.readBlob();
        const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        data.push({
            id: readInt64String(pod, 0),
            articleId: readInt32(view, 8),
            createTime: new Date(readInt64Number(view, 12)).toISOString(),
            content: readBlobText(pod, blob, 20),
            articleTitle: readFixedUtf8(pod, 28, 256),
            rootId: readInt64String(pod, 284) === '0' ? null : readInt64String(pod, 284)
        });
    }

    return {
        data,
        nextCursor: nextCursor === 0n ? null : String(nextCursor),
        hasMore
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeConversationList(payload)
{
    let payloadBody = payload;
    let hasMore = false;
    let nextCursorPod = null;
    if (payload.byteLength >= CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE &&
      readInt32(payload, 0) === CONVERSATION_LIST_CURSOR_ENVELOPE_MAGIC)
    {
        if (readInt32(payload, 4) !== CONVERSATION_LIST_CURSOR_ENVELOPE_VERSION || payload[8] > 1)
        {
            throw new Error('conversation_list_cursor_envelope_invalid');
        }
        hasMore = payload[8] === 1;
        nextCursorPod = payload.subarray(9, CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
        payloadBody = payload.subarray(CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
    }

    const reader = new BinaryReader(payloadBody);
    const total = reader.readInt32();
    const count = reader.readInt32();
    if (total < 0 || count < 0)
    {
        throw new Error('conversation_list_count_invalid');
    }

    const pods = [];
    for (let index = 0; index < count; index += 1)
    {
        pods.push(reader.readSpan(CONVERSATION_LIST_ITEM_POD_SIZE));
    }
    const blob = reader.readBlob();
    const nextCursor = hasMore && nextCursorPod ? readBlobText(nextCursorPod, blob, 0) : null;
    if (hasMore && !nextCursor)
    {
        throw new Error('conversation_list_next_cursor_missing');
    }
    return {
        total,
        items: pods.map((pod) => readConversationListItem(pod, blob)),
        nextCursor,
        hasMore
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeConversationDetail(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(CONVERSATION_DETAIL_POD_SIZE);
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error('conversation_message_count_invalid');
    }

    const messagePods = [];
    for (let index = 0; index < count; index += 1)
    {
        messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
    }
    const blob = reader.readBlob();
    return {
        conversationId: readInt64String(pod, 0),
        subject: readBlobText(pod, blob, 28),
        status: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 8),
        isSystemSource: readByte(pod, 24) === 1,
        canReply: readByte(pod, 25) === 1,
        unreadCount: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 12),
        lastMessageAt: new Date(readInt64Number(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 16)).toISOString(),
        messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeConversationDetailV2(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(CONVERSATION_DETAIL_V2_POD_SIZE);
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error('conversation_message_count_invalid');
    }

    const messagePods = [];
    for (let index = 0; index < count; index += 1)
    {
        messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
    }
    const blob = reader.readBlob();
    return {
        conversationId: readInt64String(pod, 0),
        readSnapshotMessageId: readInt64String(pod, 24),
        subject: readBlobText(pod, blob, 36),
        status: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 8),
        isSystemSource: readByte(pod, 32) === 1,
        canReply: readByte(pod, 33) === 1,
        unreadCount: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 12),
        lastMessageAt: new Date(readInt64Number(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 16)).toISOString(),
        messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeConversationDetailV3(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(CONVERSATION_DETAIL_V3_POD_SIZE);
    const count = reader.readInt32();
    if (count < 0)
    {
        throw new Error('conversation_message_count_invalid');
    }

    const messagePods = [];
    for (let index = 0; index < count; index += 1)
    {
        messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
    }
    const blob = reader.readBlob();
    const hasOlder = readByte(pod, 42) === 1;
    const previousCursor = readInt64String(pod, 32);
    if (hasOlder !== (previousCursor !== '0'))
    {
        throw new Error('conversation_message_cursor_invalid');
    }
    return {
        conversationId: readInt64String(pod, 0),
        readSnapshotMessageId: readInt64String(pod, 24),
        previousCursor: hasOlder ? previousCursor : null,
        hasOlder,
        subject: readBlobText(pod, blob, 44),
        status: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 8),
        isSystemSource: readByte(pod, 40) === 1,
        canReply: readByte(pod, 41) === 1,
        unreadCount: readInt32(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 12),
        lastMessageAt: new Date(readInt64Number(new DataView(pod.buffer, pod.byteOffset, pod.byteLength), 16)).toISOString(),
        messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
    };
}

/**
 * @param {Uint8Array} payload
 */
function decodeConversationMessageFrame(payload)
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE);
    const blob = reader.readBlob();
    return readConversationMessage(pod, blob);
}

/**
 * @param {Uint8Array} pod
 * @param {Uint8Array} blob
 */
function readConversationListItem(pod, blob)
{
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    const hasLastMessage = readByte(pod, 34) === 1;
    const lastMessagePod = pod.subarray(44, 44 + CONVERSATION_MESSAGE_PREVIEW_POD_SIZE);
    return {
        conversationId: readInt64String(pod, 0),
        subject: readBlobText(pod, blob, 36),
        status: readInt32(view, 8),
        isSystemSource: readByte(pod, 32) === 1,
        canReply: readByte(pod, 33) === 1,
        unreadCount: readInt32(view, 12),
        lastMessageAt: new Date(readInt64Number(view, 16)).toISOString(),
        updatedAt: new Date(readInt64Number(view, 24)).toISOString(),
        lastMessage: hasLastMessage ? readConversationPreview(lastMessagePod, blob) : null
    };
}

/**
 * @param {Uint8Array} pod
 * @param {Uint8Array} blob
 */
function readConversationPreview(pod, blob)
{
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    return {
        senderType: readInt32(view, 0),
        senderName: readByte(pod, 12) === 1 ? readBlobText(pod, blob, 16) : null,
        bodyPreview: readBlobText(pod, blob, 24),
        createdAt: new Date(readInt64Number(view, 4)).toISOString()
    };
}

/**
 * @param {Uint8Array} pod
 * @param {Uint8Array} blob
 */
function readConversationMessage(pod, blob)
{
    const view = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
    return {
        messageId: readInt64String(pod, 0),
        conversationId: readInt64String(pod, 8),
        senderType: readInt32(view, 16),
        senderName: readByte(pod, 28) === 1 ? readBlobText(pod, blob, 32) : null,
        body: readBlobText(pod, blob, 40),
        createdAt: new Date(readInt64Number(view, 20)).toISOString()
    };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function readInt64String(bytes, offset)
{
    return String(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true));
}

/**
 * @param {Uint8Array} pod
 * @param {Uint8Array} blob
 * @param {number} offset
 * @returns {string}
 */
function readBlobText(pod, blob, offset)
{
    return readSliceText(blob, readSliceRef(pod, offset));
}

/**
 * @param {Uint8Array} payload
 */
function decodePowChallengePayload(payload)
{
    if (payload.byteLength !== 204)
    {
        throw new Error(`pow_challenge_payload_size_mismatch:${payload.byteLength}`);
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
        salt: readFixedUtf8(payload, 0, 64),
        difficulty: readInt32(view, 64),
        timestamp: readInt64Number(view, 68),
        signature: readFixedUtf8(payload, 76, 128)
    };
}

/**
 * @param {(string | null | undefined)[]} values
 * @returns {{ bytes: Uint8Array<ArrayBuffer>; refs: AedsSlice[]; blobLength: number; }}
 */
function encodeStringBlob(values)
{
    const encodedValues = values.map((value) => UTF8_ENCODER.encode(value ?? ''));
    const headerLength = values.length === 2 ? 24 : values.length * 8 + 4;
    const blobLength = encodedValues.reduce((sum, item) => sum + item.byteLength, 0);
    const bytes = new Uint8Array(headerLength + blobLength);
    let offset = headerLength;
    const refs = [];
    for (const encoded of encodedValues)
    {
        refs.push({ offset: offset - headerLength, length: encoded.byteLength });
        bytes.set(encoded, offset);
        offset += encoded.byteLength;
    }
    return { bytes, refs, blobLength };
}

function writeSliceRef(view, offset, ref)
{
    view.setInt32(offset, ref.offset, true);
    view.setInt32(offset + 4, ref.length, true);
}

function writeFixedUtf8(target, offset, length, value)
{
    const encoded = UTF8_ENCODER.encode(value ?? '');
    target.set(encoded.subarray(0, length), offset);
}

/**
 * @param {number} headerLength
 * @param {readonly Uint8Array[]} parts
 * @returns {{ bytes: Uint8Array<ArrayBuffer>; refs: AedsSlice[]; blobLength: number; }}
 */
function encodeBinaryBlob(headerLength, parts)
{
    const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const bytes = new Uint8Array(headerLength + 4 + blobLength);
    const refs = [];
    let offset = 0;
    let cursor = headerLength + 4;
    for (const part of parts)
    {
        refs.push({ offset, length: part.byteLength });
        bytes.set(part, cursor);
        offset += part.byteLength;
        cursor += part.byteLength;
    }
    return { bytes, refs, blobLength };
}

function textBytes(value)
{
    return UTF8_ENCODER.encode(value ?? '');
}

function base64UrlToBytes(value)
{
    if (!value)
    {
        return new Uint8Array(0);
    }
    return new Uint8Array(Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function bytesToBase64Url(bytes)
{
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialTypeToText(value)
{
    if (value !== 0)
    {
        throw new Error('passkey_credential_type_invalid');
    }
    return 'public-key';
}

function attestationToText(value)
{
    return value === 1 ? 'indirect' : value === 2 ? 'direct' : value === 3 ? 'enterprise' : 'none';
}

function residentKeyToText(value)
{
    return value === 1 ? 'preferred' : value === 2 ? 'discouraged' : 'required';
}

function userVerificationToText(value)
{
    return value === 1 ? 'preferred' : value === 2 ? 'discouraged' : 'required';
}

function authenticatorAttachmentToText(value)
{
    return value === 1 ? 'cross-platform' : 'platform';
}

function transportToText(value)
{
    return ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'][value] ?? null;
}

function transportToInt(value)
{
    switch (value)
    {
        case 'usb':
            return 0;
        case 'nfc':
            return 1;
        case 'ble':
            return 2;
        case 'smart-card':
            return 3;
        case 'hybrid':
            return 4;
        case 'internal':
            return 5;
        default:
            return null;
    }
}

class BinaryReader
{
    /** @param {Uint8Array} bytes */
    constructor(bytes)
    {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.offset = 0;
    }

    remaining()
    {
        return this.bytes.byteLength - this.offset;
    }

    readInt32()
    {
        if (this.remaining() < 4)
        {
            throw new Error('binary_read_int32_overflow');
        }
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readInt64()
    {
        if (this.remaining() < 8)
        {
            throw new Error('binary_read_int64_overflow');
        }
        const value = Number(this.view.getBigInt64(this.offset, true));
        this.offset += 8;
        return value;
    }

    /** @param {number} length */
    readSpan(length)
    {
        if (length < 0 || this.remaining() < length)
        {
            throw new Error('binary_read_span_overflow');
        }
        const span = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return span;
    }

    readByte()
    {
        if (this.remaining() < 1)
        {
            throw new Error('binary_read_byte_overflow');
        }
        return this.bytes[this.offset++];
    }

    readBlob()
    {
        const length = this.readInt32();
        return this.readSpan(length);
    }
}

class PublicAotValueReader
{
    /** @param {Uint8Array} bytes */
    constructor(bytes)
    {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.offset = 0;
    }

    remaining()
    {
        return this.bytes.byteLength - this.offset;
    }

    /** @returns {PublicAotValue} */
    readValue()
    {
        const kind = this.readByte();
        switch (kind)
        {
            case PUBLIC_AOT_NULL_KIND:
                return null;
            case PUBLIC_AOT_STRING_KIND:
                return this.readString();
            case PUBLIC_AOT_INT32_KIND:
                return this.readInt32();
            case PUBLIC_AOT_INT64_KIND:
                return Number(this.readInt64());
            case PUBLIC_AOT_DOUBLE_KIND:
                return this.readDouble();
            case PUBLIC_AOT_BOOL_KIND:
                return this.readByte() === 1;
            case PUBLIC_AOT_OBJECT_KIND:
                return this.readObject();
            case PUBLIC_AOT_ARRAY_KIND:
                return this.readArray();
            case PUBLIC_AOT_DECIMAL_KIND:
                return this.readDecimal();
            default:
                throw new Error('public_aot_value_kind_invalid');
        }
    }

    readByte()
    {
        if (this.remaining() < 1)
        {
            throw new Error('public_aot_read_byte_overflow');
        }
        return this.bytes[this.offset++];
    }

    readInt32()
    {
        if (this.remaining() < 4)
        {
            throw new Error('public_aot_read_int32_overflow');
        }
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    readInt64()
    {
        if (this.remaining() < 8)
        {
            throw new Error('public_aot_read_int64_overflow');
        }
        const value = this.view.getBigInt64(this.offset, true);
        this.offset += 8;
        return value;
    }

    readDouble()
    {
        if (this.remaining() < 8)
        {
            throw new Error('public_aot_read_double_overflow');
        }
        const value = this.view.getFloat64(this.offset, true);
        this.offset += 8;
        return value;
    }

    readDecimal()
    {
        const lo = BigInt.asUintN(32, BigInt(this.readInt32()));
        const mid = BigInt.asUintN(32, BigInt(this.readInt32()));
        const hi = BigInt.asUintN(32, BigInt(this.readInt32()));
        const flags = this.readInt32() >>> 0;
        const scale = (flags >>> 16) & 0xff;
        const reservedBits = flags & 0x7f00ffff;
        if (reservedBits !== 0 || scale > 28)
        {
            throw new Error('public_aot_decimal_flags_invalid');
        }

        const coefficient = (hi << 64n) | (mid << 32n) | lo;
        const sign = (flags & 0x80000000) !== 0 && coefficient !== 0n ? '-' : '';
        if (scale === 0)
        {
            return `${sign}${coefficient.toString()}`;
        }

        const digits = coefficient.toString().padStart(scale + 1, '0');
        return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    }

    readString()
    {
        const length = this.readInt32();
        if (length < 0 || this.remaining() < length)
        {
            throw new Error('public_aot_string_length_invalid');
        }
        const value = UTF8_DECODER.decode(this.bytes.subarray(this.offset, this.offset + length));
        this.offset += length;
        return value;
    }

    /** @returns {{ [key: string]: PublicAotValue; }} */
    readObject()
    {
        const count = this.readInt32();
        if (count < 0)
        {
            throw new Error('public_aot_object_count_invalid');
        }
        const value = {};
        for (let i = 0; i < count; i += 1)
        {
            value[this.readString()] = this.readValue();
        }
        return value;
    }

    /** @returns {PublicAotValue[]} */
    readArray()
    {
        const count = this.readInt32();
        if (count < 0)
        {
            throw new Error('public_aot_array_count_invalid');
        }
        const value = [];
        for (let i = 0; i < count; i += 1)
        {
            value.push(this.readValue());
        }
        return value;
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
