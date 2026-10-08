import {
    decodeWritingAidPreferenceReceipt,
    decodeWritingAidPreferenceSnapshot,
    encodeWritingAidPreferenceReceipt,
    encodeWritingAidPreferenceSnapshot,
    encodeWritingAidPreferenceUpdateRequest
} from '@/codecs/binary/writingAidPreferenceWire.generated';
import type {
    WritingAidPreferenceOwner,
    WritingAidPreferenceReceipt,
    WritingAidPreferenceSnapshot,
    WritingAidPreferenceUpdate
} from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';

// The account/request owner supplies these coordinates. This module stores no
// preference, discovers no identity and does not confer authentication authority.
export function bindWritingAidPreferenceSnapshot(
    snapshot: WritingAidPreferenceSnapshot,
    owner: WritingAidPreferenceOwner
): WritingAidPreferenceSnapshot
{
    return decodeWritingAidPreferenceSnapshot(encodeWritingAidPreferenceSnapshot(snapshot), owner);
}

// Invoke after the existing binary transport and registered decoder succeed.
// Reuse the generated validators for every payload/digest check; only request
// correlation belongs here. A nullable backend receipt cannot imply a commit.
export function bindWritingAidPreferenceUpdateReceipt(
    receipt: WritingAidPreferenceReceipt | null | undefined,
    owner: WritingAidPreferenceOwner,
    deviceScope: string,
    previous: WritingAidPreferenceSnapshot,
    request: WritingAidPreferenceUpdate
): WritingAidPreferenceReceipt
{
    const expected = bindWritingAidPreferenceSnapshot(previous, owner);
    encodeWritingAidPreferenceUpdateRequest(request);
    if (!receipt)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'writing_aid_preference_receipt_missing');
    }
    const bound = decodeWritingAidPreferenceReceipt(encodeWritingAidPreferenceReceipt(receipt), owner);
    if (request.expectedRevision !== expected.revision
        || bound.action !== 'update'
        || bound.operationId !== request.operationId
        || bound.deviceScope !== deviceScope
        || bound.previous.contentDigest !== expected.contentDigest
        || bound.committed.values.focusEnabled !== request.values.focusEnabled
        || bound.committed.values.typewriterEnabled !== request.values.typewriterEnabled
        || bound.committed.values.immersiveEnabled !== request.values.immersiveEnabled)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'writing_aid_preference_receipt_request_mismatch');
    }
    return bound;
}
