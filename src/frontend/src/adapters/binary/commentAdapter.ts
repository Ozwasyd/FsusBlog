import { BinaryReader, readByte, readCountChecked, readFixedUtf8, readInt32, readInt64Number, readInt64String, readNullableId64, readIsoDate64, readBlobText, readSliceRef, readSliceText } from '@/codecs/binary/reader';
import type {
    AnonymousCommentTicketResponse,
    AnonymousCredentialRevocationArtifact,
    AnonymousCredentialRootSnapshot,
    BlindCredentialIssuerMetadata,
    BlindCredentialIssueResponse,
    AnonymousPrivacyStateSnapshot,
    CommentAuthorMode,
    CommentCreateResult,
    CommentPermalinkContext,
    CommentReplyItem,
    CommentTreeNode,
    CommentTreeRoot,
    CommentThreadItem,
    CursorResponse,
    UserCommentResponse
} from '@/contracts/binaryApi';
import {
    type CommentPolicySnapshot,
    zkProdServerUnavailableReasons,
    type DecodedCommentPolicySnapshot
} from '@/contracts/commentPolicy';
import { COMMENT_POLICY_WIRE, COMMENT_POLICY_OFFSETS } from '@/generated/commentPolicyWire';
import { finalizeCommentPolicySnapshot } from '@/policies/commentPolicy';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { resolveCommentAuthorView } from '@/utils/commentAuthorView';

import { readCursorEnvelope } from './envelopeReaders';
import { readCommentTreeNodeFromReader, readReplyItem, readThreadItemFromReader } from './podReaders';
import {
    ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE,
    ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE,
    ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE,
    BLIND_CREDENTIAL_ISSUER_METADATA_POD_SIZE,
    BLIND_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
    ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE,
    COMMENT_REPLY_ITEM_POD_SIZE,
    USER_COMMENT_POD_SIZE
} from './types';

const ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES = 16 * 1024;
const REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();

export function mapCommentCursorFromPodPayload(payload: Uint8Array): CursorResponse<CommentThreadItem>
{
    const reader = new BinaryReader(payload);
    return readCursorEnvelope(reader, () => readThreadItemFromReader(reader), 'comment_thread_cursor_count_invalid', 'comment_thread_cursor_trailing_payload_invalid');
}

export function mapCommentCreateResultFromPayload(payload: Uint8Array): CommentCreateResult
{
    if (payload.byteLength !== 40)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_create_result_size_invalid');
    }

    const commentId = readInt64String(payload, 0);
    const rootId = readInt64String(payload, 8);
    const rawParentId = readInt64String(payload, 16);
    const createdAtUtc = readIsoDate64(payload, 24);
    const moderationStatus = readInt32(payload, 32);
    const visibilityCode = readByte(payload, 36);
    const visible = readByte(payload, 37);
    const replay = readByte(payload, 38);
    const hasParent = readByte(payload, 39);
    if (commentId === '0' || rootId === '0' || moderationStatus < 0 || moderationStatus > 3
    || visibilityCode > 3 || visible > 1 || replay > 1 || hasParent > 1
    || (hasParent === 0 ? rawParentId !== '0' : rawParentId === '0'))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_create_result_value_invalid');
    }

    return {
        commentId,
        rootId,
        parentId: hasParent === 1 ? rawParentId : null,
        createdAtUtc,
        moderationStatus,
        visibilityState: (['pending', 'public', 'hidden', 'rejected'] as const)[visibilityCode],
        isPubliclyVisible: visible === 1,
        idempotencyReplay: replay === 1
    };
}

const policyUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const policyServerReasons = new Set<string>(zkProdServerUnavailableReasons);

function readPolicyBoolean(pod: Uint8Array, offset: number, error: string): boolean
{
    const value = readByte(pod, offset);
    if (value > COMMENT_POLICY_WIRE.booleanMaxByte)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, error);
    }
    return value === COMMENT_POLICY_WIRE.booleanMaxByte;
}

export function mapCommentPolicySnapshotFromPayload(payload: Uint8Array): CommentPolicySnapshot
{
    const size = COMMENT_POLICY_WIRE.podBytes;
    if (payload.byteLength < size + 4)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_size_invalid');
    }
    const blobLength = readInt32(payload, size);
    if (blobLength < 0 || payload.byteLength !== size + 4 + blobLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_blob_length_invalid');
    }
    const pod = payload.subarray(0, size);
    const blob = payload.subarray(size + 4);
    const offsets = COMMENT_POLICY_OFFSETS;
    const languages = readSliceRef(pod, offsets.supportedDisplayLanguages);
    const hash = readSliceRef(pod, offsets.snapshotHash);
    const reason = readSliceRef(pod, offsets.zkProdUnavailableReason);
    const authorMode = readByte(pod, offsets.defaultAuthorMode);
    if (authorMode !== COMMENT_POLICY_WIRE.publicAuthorMode && authorMode !== COMMENT_POLICY_WIRE.zkAnonymousAuthorMode)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_author_mode_invalid');
    }
    const maxChars = readInt32(pod, offsets.commentMaxChars);
    const maxBytes = readInt32(pod, offsets.commentMaxUtf8Bytes);
    if (languages.offset !== 0 || languages.length <= 0 || hash.offset !== languages.length || hash.length !== 64
        || reason.offset !== hash.offset + hash.length || reason.length < 0 || reason.offset + reason.length !== blobLength
        || maxChars < COMMENT_POLICY_WIRE.minMaxChars || maxChars > COMMENT_POLICY_WIRE.hardMaxChars
        || maxBytes < COMMENT_POLICY_WIRE.minMaxUtf8Bytes || maxBytes > COMMENT_POLICY_WIRE.hardMaxUtf8Bytes)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_fields_invalid');
    }
    let languageText: string;
    let snapshotHash: string;
    let unavailableReason: string;
    try
    {
        languageText = policyUtf8Decoder.decode(blob.subarray(0, languages.length));
        snapshotHash = policyUtf8Decoder.decode(blob.subarray(hash.offset, hash.offset + hash.length));
        unavailableReason = policyUtf8Decoder.decode(blob.subarray(reason.offset));
    }
    catch
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_utf8_invalid');
    }
    const supportedDisplayLanguages = languageText.split('\n').map(language => language.trim());
    if (!/^[0-9a-f]{64}$/u.test(snapshotHash) || !supportedDisplayLanguages.every(language => language.length > 0)
        || !policyServerReasons.has(unavailableReason))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_fields_invalid');
    }
    const decoded: DecodedCommentPolicySnapshot = {
        anonymousCommentsEnabled: readPolicyBoolean(pod, offsets.anonymousCommentsEnabled, 'comment_policy_snapshot_anonymous_flag_invalid'),
        publicCommentsEnabled: readPolicyBoolean(pod, offsets.publicCommentsEnabled, 'comment_policy_snapshot_public_flag_invalid'),
        zkAnonymousEnabled: readPolicyBoolean(pod, offsets.zkAnonymousEnabled, 'comment_policy_snapshot_zk_flag_invalid'),
        defaultAuthorMode: decodeCommentAuthorMode(authorMode),
        zkProdEnabled: readPolicyBoolean(pod, offsets.zkProdEnabled, 'comment_policy_snapshot_zk_prod_flag_invalid'),
        zkProdNativeVerifierConfigured: readPolicyBoolean(pod, offsets.zkProdNativeVerifierConfigured, 'comment_policy_snapshot_zk_prod_verifier_flag_invalid'),
        zkProdTrustedSetupVerified: readPolicyBoolean(pod, offsets.zkProdTrustedSetupVerified, 'comment_policy_snapshot_zk_prod_setup_flag_invalid'),
        zkProdCredentialRequired: readPolicyBoolean(pod, offsets.zkProdCredentialRequired, 'comment_policy_snapshot_zk_prod_credential_flag_invalid'),
        zkProdCredentialRootReady: readPolicyBoolean(pod, offsets.zkProdCredentialRootReady, 'comment_policy_snapshot_zk_prod_root_flag_invalid'),
        commentMaxChars: maxChars,
        commentMaxUtf8Bytes: maxBytes,
        supportedDisplayLanguages,
        snapshotHash,
        zkProdUnavailableReason: unavailableReason
    };
    return finalizeCommentPolicySnapshot(decoded);
}

export function mapBlindCredentialIssuerMetadataFromPayload(payload: Uint8Array): BlindCredentialIssuerMetadata
{
    const { pod, blob } = readAnonymousPrivacyPayload(
        payload,
        BLIND_CREDENTIAL_ISSUER_METADATA_POD_SIZE,
        'blind_credential_issuer_metadata');
    return {
        credentialEpoch: readInt64Number(pod, 0),
        expiresAtUnixMs: readInt64Number(pod, 8),
        circuitNumericId: readUint32(pod, 16),
        publicInputLayoutVersion: readUint16(pod, 20),
        modulusBytes: readUint16(pod, 22),
        circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'blind_credential_metadata_circuit_invalid'),
        credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'blind_credential_metadata_level_invalid'),
        schemeId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'blind_credential_metadata_scheme_invalid'),
        issuerPublicKeyId: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'blind_credential_metadata_key_id_invalid'),
        issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 56), 'blind_credential_metadata_key_hash_invalid'),
        subjectPublicKeyInfo: readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'blind_credential_metadata_spki_invalid')
    };
}

export function mapBlindCredentialIssueResponseFromPayload(payload: Uint8Array): BlindCredentialIssueResponse
{
    const { pod, blob } = readAnonymousPrivacyPayload(
        payload,
        BLIND_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
        'blind_credential_issue_response');
    return {
        credentialEpoch: readInt64Number(pod, 0),
        expiresAtUnixMs: readInt64Number(pod, 8),
        circuitNumericId: readUint32(pod, 16),
        publicInputLayoutVersion: readUint16(pod, 20),
        circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'blind_credential_response_circuit_invalid'),
        credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'blind_credential_response_level_invalid'),
        schemeId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'blind_credential_response_scheme_invalid'),
        issuerPublicKeyId: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'blind_credential_response_key_id_invalid'),
        blindSignature: readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'blind_credential_response_signature_invalid')
    };
}

export function mapAnonymousCredentialRootSnapshotFromPayload(payload: Uint8Array): AnonymousCredentialRootSnapshot
{
    const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE, 'anonymous_credential_root_snapshot');

    return {
        credentialEpoch: readInt64Number(pod, 0),
        rootExpiresAtUnixMs: readInt64Number(pod, 8),
        rootGraceExpiresAtUnixMs: readInt64Number(pod, 16),
        circuitNumericId: readUint32(pod, 24),
        publicInputLayoutVersion: readUint16(pod, 28),
        zkAnonymousEnabled: readBooleanByte(pod, 30, 'anonymous_credential_root_snapshot_zk_flag_invalid'),
        verifierConfigured: readBooleanByte(pod, 31, 'anonymous_credential_root_snapshot_verifier_flag_invalid'),
        circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'anonymous_credential_root_snapshot_circuit_invalid'),
        verifyingKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'anonymous_credential_root_snapshot_verifying_key_invalid'),
        issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'anonymous_credential_root_snapshot_issuer_invalid'),
        credentialRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'anonymous_credential_root_snapshot_root_invalid'),
        revocationRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'anonymous_credential_root_snapshot_revocation_invalid'),
        circuitMetadata: readAnonymousSliceBytes(blob, readSliceRef(pod, 72), 'anonymous_credential_root_snapshot_metadata_invalid')
    };
}

export function mapAnonymousCredentialRevocationArtifactFromPayload(payload: Uint8Array): AnonymousCredentialRevocationArtifact
{
    const { pod, blob } = readAnonymousPrivacyPayload(
        payload,
        ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE,
        'anonymous_credential_revocation_artifact',
        REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
    const entryCount = readUint32(pod, 32);
    const pathDepth = readUint16(pod, 36);
    const kind = readByte(pod, 38);
    const revocationRoot = readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'anonymous_credential_revocation_artifact_root_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
    const contentHash = readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'anonymous_credential_revocation_artifact_hash_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
    const signature = readAnonymousSliceBytes(blob, readSliceRef(pod, 72), 'anonymous_credential_revocation_artifact_signature_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
    const entryHashes = readAnonymousSliceBytes(blob, readSliceRef(pod, 80), 'anonymous_credential_revocation_artifact_entries_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
    if ((kind !== 1 && kind !== 2) || pathDepth !== 128 ||
    revocationRoot.byteLength !== 32 || contentHash.byteLength !== 32 || signature.byteLength !== 32 ||
    entryHashes.byteLength !== entryCount * 32)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'anonymous_credential_revocation_artifact_shape_invalid');
    }

    return {
        credentialEpoch: readInt64Number(pod, 0),
        version: readInt64Number(pod, 8),
        baseVersion: readInt64Number(pod, 16),
        expiresAtUnixMs: readInt64Number(pod, 24),
        kind,
        algorithmId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'anonymous_credential_revocation_artifact_algorithm_invalid'),
        pathDepth,
        issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'anonymous_credential_revocation_artifact_issuer_invalid'),
        revocationRoot,
        contentHash,
        signature,
        entryHashes
    };
}

export function mapAnonymousCommentTicketResponseFromPayload(payload: Uint8Array): AnonymousCommentTicketResponse
{
    const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE, 'anonymous_comment_ticket_response');

    return {
        ticketExpiresAtUnixMs: readInt64Number(pod, 0),
        rateClass: readAnonymousSliceText(blob, readSliceRef(pod, 12), 'anonymous_comment_ticket_response_rate_class_invalid') as 'common' | 'unknown',
        requiresModeration: readByte(pod, 8) === 1,
        ticket: readAnonymousSliceBytes(blob, readSliceRef(pod, 20), 'anonymous_comment_ticket_response_ticket_invalid'),
        moderationSubjectHash: readAnonymousSliceBytes(blob, readSliceRef(pod, 28), 'anonymous_comment_ticket_response_moderation_hash_invalid')
    };
}

export function mapAnonymousPrivacyStateSnapshotFromPayload(payload: Uint8Array): AnonymousPrivacyStateSnapshot
{
    const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE, 'anonymous_privacy_state_snapshot');

    return {
        credentialEpoch: readInt64Number(pod, 0),
        rootExpiresAtUnixMs: readInt64Number(pod, 8),
        ticketExpiresAtUnixMs: readInt64Number(pod, 16),
        circuitNumericId: readUint32(pod, 24),
        publicInputLayoutVersion: readUint16(pod, 28),
        hasActiveCredential: readBooleanByte(pod, 30, 'anonymous_privacy_state_active_flag_invalid'),
        canIssueCredential: readBooleanByte(pod, 31, 'anonymous_privacy_state_issue_flag_invalid'),
        canSubmitAnonymousComment: readBooleanByte(pod, 32, 'anonymous_privacy_state_submit_flag_invalid'),
        circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 34), 'anonymous_privacy_state_circuit_invalid'),
        verifyingKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 42), 'anonymous_privacy_state_verifying_key_invalid'),
        credentialStatus: readAnonymousSliceText(blob, readSliceRef(pod, 50), 'anonymous_privacy_state_status_invalid'),
        credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 58), 'anonymous_privacy_state_level_invalid')
    };
}

export function mapThreadReplyCursorFromPodPayload(payload: Uint8Array): CursorResponse<CommentReplyItem>
{
    const reader = new BinaryReader(payload);
    const rootIdRaw = reader.readInt64();
    const nextCursorRaw = reader.readInt64();
    const hasMore = reader.readByte() === 1;
    const count = readCountChecked(reader, 'comment_reply_cursor_count_invalid');
    const data: CommentReplyItem[] = [];

    for (let i = 0; i < count; i++)
    {
        const pod = reader.readSpan(COMMENT_REPLY_ITEM_POD_SIZE);
        const blob = reader.readBlob();
        const reply = readReplyItem(pod, blob);
        if (!reply.rootId || reply.rootId === '0')
        {
            reply.rootId = String(rootIdRaw);
        }
        data.push(reply);
    }

    return {
        data,
        nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
        hasMore
    };
}

export function mapCommentTreeRootCursorFromPayload(payload: Uint8Array): CursorResponse<CommentTreeRoot>
{
    const reader = new BinaryReader(payload);
    return readCursorEnvelope(reader, () =>
    {
        const node = readCommentTreeNodeFromReader(reader);
        if (node.parentId !== null || node.rootId !== node.id || node.depth !== 0)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_tree_root_coordinate_invalid');
        }
        const previewCount = reader.readByte();
        const reserved = reader.readSpan(3);
        if (reserved.some((value) => value !== 0))
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_tree_root_reserved_invalid');
        }
        const childrenPreview: CommentTreeNode[] = [];
        for (let index = 0; index < previewCount; index++)
        {
            const child = readCommentTreeNodeFromReader(reader);
            if (child.parentId !== node.id || child.rootId !== node.rootId || child.depth !== 1)
            {
                throw createAppError(AppErrorCode.ProtocolFailure, 'comment_tree_preview_parent_invalid');
            }
            childrenPreview.push(child);
        }
        return { node, childrenPreview };
    }, 'comment_tree_root_cursor_count_invalid', 'comment_tree_root_cursor_trailing_payload_invalid');
}

export function mapCommentChildCursorFromPayload(payload: Uint8Array): CursorResponse<CommentTreeNode>
{
    const reader = new BinaryReader(payload);
    const header = reader.readSpan(32);
    const parentId = readInt64String(header, 0);
    const rootId = readInt64String(header, 8);
    const nextCursor = readInt64String(header, 16);
    const count = readInt32(header, 24);
    const hasMore = readByte(header, 28);
    if (count < 0 || hasMore > 1 || readByte(header, 29) !== 0 || readByte(header, 30) !== 0 || readByte(header, 31) !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_child_cursor_header_invalid');
    }
    const data: CommentTreeNode[] = [];
    for (let index = 0; index < count; index++)
    {
        const child = readCommentTreeNodeFromReader(reader);
        if (child.parentId !== parentId || (rootId !== '0' && child.rootId !== rootId))
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_child_cursor_parent_invalid');
        }
        data.push(child);
    }
    if (reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_child_cursor_trailing_payload_invalid');
    }
    return { data, nextCursor: nextCursor === '0' ? null : nextCursor, hasMore: hasMore === 1 };
}

export function mapCommentPermalinkContextFromPayload(payload: Uint8Array): CommentPermalinkContext
{
    const reader = new BinaryReader(payload);
    const header = reader.readSpan(32);
    const targetId = readInt64String(header, 0);
    const rootId = readInt64String(header, 8);
    const ancestorCount = readInt32(header, 16);
    const siblingCount = readInt32(header, 20);
    const status = readByte(header, 24);
    const hasTarget = readByte(header, 25);
    const hasPreviousSiblings = readByte(header, 26);
    const hasNextSiblings = readByte(header, 27);
    if (ancestorCount < 0 || siblingCount < 0 || status > 1 || hasTarget > 1
    || hasPreviousSiblings > 1 || hasNextSiblings > 1
    || header.subarray(28).some((value) => value !== 0))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_header_invalid');
    }
    const ancestors: CommentTreeNode[] = [];
    for (let index = 0; index < ancestorCount; index++)
    {
        ancestors.push(readCommentTreeNodeFromReader(reader));
    }
    const target = hasTarget === 1 ? readCommentTreeNodeFromReader(reader) : null;
    const siblings: CommentTreeNode[] = [];
    for (let index = 0; index < siblingCount; index++)
    {
        siblings.push(readCommentTreeNodeFromReader(reader));
    }
    if (reader.remaining() !== 0 || (status === 0) !== Boolean(target))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_payload_invalid');
    }
    if (status === 1)
    {
        if (targetId !== '0' || rootId !== '0' || ancestorCount !== 0 || siblingCount !== 0
      || hasTarget !== 0 || hasPreviousSiblings !== 0 || hasNextSiblings !== 0)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_unavailable_shape_invalid');
        }
    }
    else
    {
        if (!target || target.id !== targetId || target.rootId !== rootId || ancestorCount > 256 || siblingCount > 20)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_coordinate_invalid');
        }
        let expectedParentId: string | null = null;
        for (let index = 0; index < ancestors.length; index++)
        {
            const ancestor = ancestors[index];
            if (ancestor.parentId !== expectedParentId || ancestor.rootId !== rootId || ancestor.depth !== index)
            {
                throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_ancestor_path_invalid');
            }
            expectedParentId = ancestor.id;
        }
        if (target.parentId !== expectedParentId || target.depth !== ancestors.length
      || siblings.some((sibling) => sibling.id === target.id
        || sibling.parentId !== target.parentId
        || sibling.rootId !== target.rootId
        || sibling.depth !== target.depth))
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_permalink_sibling_window_invalid');
        }
    }
    return {
        status: status === 0 ? 'found' : 'unavailable',
        targetId: targetId === '0' ? null : targetId,
        rootId: rootId === '0' ? null : rootId,
        ancestors,
        target,
        siblings,
        hasPreviousSiblings: hasPreviousSiblings === 1,
        hasNextSiblings: hasNextSiblings === 1
    };
}

export function mapUserCommentCursorFromPodPayload(payload: Uint8Array): CursorResponse<UserCommentResponse>
{
    const reader = new BinaryReader(payload);
    return readCursorEnvelope(
        reader,
        () =>
        {
            const pod = reader.readSpan(USER_COMMENT_POD_SIZE);
            const blob = reader.readBlob();
            return {
                id: readNullableId64(pod, 0) ?? '0',
                articleId: readInt32(pod, 8),
                createTime: readIsoDate64(pod, 12),
                content: readBlobText(pod, blob, 20),
                articleTitle: readFixedUtf8(pod, 28, 256),
                rootId: readNullableId64(pod, 284),
                ...readUserCommentAuthors(pod, blob),
                moderationStatus: readInt32(pod, 292),
                isPubliclyVisible: readByte(pod, 296) === 1,
                visibilityState: readFixedUtf8(pod, 300, 32),
                visibilityReasonCode: readFixedUtf8(pod, 332, 64),
                moderationStatusLabel: readFixedUtf8(pod, 396, 64)
            };
        },
        'user_comment_cursor_count_invalid',
        'user_comment_cursor_trailing_payload_invalid'
    );
}

function readUserCommentAuthors(pod: Uint8Array, blob: Uint8Array): Pick<UserCommentResponse, 'author' | 'replyToAuthor'>
{
    const content = readSliceRef(pod, 20);
    let offset = content.offset + content.length;
    const authorPayload = readEmbeddedPayload(blob, offset, 'user_comment_author_contract_missing');
    offset = authorPayload.nextOffset;
    if (authorPayload.payload.byteLength === 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'user_comment_author_contract_missing');
    }

    const replyPayload = readEmbeddedPayload(blob, offset, 'user_comment_reply_author_contract_missing');
    if (replyPayload.nextOffset !== blob.byteLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'user_comment_author_trailing_payload_invalid');
    }

    return {
        author: readCommentAuthorViewPayload(authorPayload.payload, 'user_comment_author_contract_missing'),
        replyToAuthor: replyPayload.payload.byteLength === 0
            ? null
            : readCommentAuthorViewPayload(replyPayload.payload, 'user_comment_reply_author_contract_missing')
    };
}

function readEmbeddedPayload(blob: Uint8Array, offset: number, errorCode: string): { payload: Uint8Array; nextOffset: number; }
{
    if (offset < 0 || offset + 4 > blob.byteLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
    }

    const length = readInt32(blob, offset);
    const payloadOffset = offset + 4;
    const nextOffset = payloadOffset + length;
    if (length < 0 || nextOffset > blob.byteLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
    }

    return { payload: blob.subarray(payloadOffset, nextOffset), nextOffset };
}

function readCommentAuthorViewPayload(payload: Uint8Array, errorCode: string): UserCommentResponse['author']
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(36);
    const blob = reader.readBlob();
    if (reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
    }

    return resolveCommentAuthorView({
        author: {
            mode: decodeEmbeddedCommentAuthorMode(readByte(pod, 0), errorCode),
            displayName: readSliceText(blob, readSliceRef(pod, 4)),
            displayLanguage: readSliceText(blob, readSliceRef(pod, 12)) === 'en' ? 'en' : 'zh-CN',
            badge: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 20))),
            scopeLabel: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 28)))
        }
    });
}

function decodeEmbeddedCommentAuthorMode(raw: number, errorCode: string): UserCommentResponse['author']['mode']
{
    if (raw === 0 || raw === 1)
    {
        return 'legacy_server_visible_pseudonymous';
    }
    if (raw === 3)
    {
        return 'public';
    }
    if (raw === 4)
    {
        return 'zk_anonymous';
    }
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
}

function nullableAuthorField(value: string): string | null
{
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readBooleanByte(pod: Uint8Array, offset: number, errorCode: string): boolean
{
    const value = readByte(pod, offset);
    if (value > 1)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
    }

    return value === 1;
}

function readAnonymousPrivacyPayload(payload: Uint8Array, podSize: number, errorPrefix: string, maxPayloadBytes = ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES): { pod: Uint8Array; blob: Uint8Array; }
{
    const reader = new BinaryReader(payload);
    const pod = reader.readSpan(podSize);
    const blob = reader.readBlob();
    if (reader.remaining() !== 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_trailing_payload_invalid`);
    }

    if (blob.byteLength > maxPayloadBytes)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_payload_oversized`);
    }

    return { pod, blob };
}

function readAnonymousSliceBytes(blob: Uint8Array, slice: { offset: number; length: number; }, errorCode: string, maxPayloadBytes = ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES): Uint8Array
{
    if (slice.offset < 0 || slice.length < 0 || slice.length > maxPayloadBytes || slice.offset + slice.length > blob.byteLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
    }

    return blob.slice(slice.offset, slice.offset + slice.length);
}

function readAnonymousSliceText(blob: Uint8Array, slice: { offset: number; length: number; }, errorCode: string): string
{
    return decoder.decode(readAnonymousSliceBytes(blob, slice, errorCode));
}

function readUint16(bytes: Uint8Array, offset: number): number
{
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number
{
    return (
        ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>> 0
    );
}

function decodeCommentAuthorMode(value: number): CommentAuthorMode
{
    switch (value)
    {
        case 3:
            return 'public';
        case 4:
            return 'zk_anonymous';
        default:
            throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_author_mode_invalid');
    }
}
