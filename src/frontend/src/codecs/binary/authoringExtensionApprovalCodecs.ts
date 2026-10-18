import { encodeAedsFrame } from '@/api/binaryFrame';
import * as wire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';

import { FrameType } from '@wasm/protocol/frame';

/** Pure bounded wire helpers. There is no production HTTP route or approval/execution capability here. */
export function encodeApprovalDecisionFrame(request: wire.AuthoringExtensionApprovalDecisionRequest): ArrayBuffer
{
    return encodeAedsFrame(FrameType.AuthoringExtensionApprovalDecisionRequest,
        wire.encodeAuthoringExtensionApprovalDecisionRequest(request));
}

export function encodeApprovalConfirmationFrame(request: wire.AuthoringExtensionApprovalConfirmationRequest): ArrayBuffer
{
    return encodeAedsFrame(FrameType.AuthoringExtensionApprovalConfirmationRequest,
        wire.encodeAuthoringExtensionApprovalConfirmationRequest(request));
}

export function decodeApprovalPreview(payload: Uint8Array, expectedDecisionId: string): wire.AuthoringExtensionApprovalPreviewResponse
{
    wire.encodeAuthoringExtensionApprovalDecisionRequest({ contractVersion: 2, decisionId: expectedDecisionId });
    const result = decodeBinaryFramePayload(FrameType.AuthoringExtensionApprovalPreviewResponse, payload) as wire.AuthoringExtensionApprovalPreviewResponse;
    if (result.decisionId !== expectedDecisionId)
    {
        throw new Error('authoring_approval_decision_binding_invalid');
    }
    return result;
}
