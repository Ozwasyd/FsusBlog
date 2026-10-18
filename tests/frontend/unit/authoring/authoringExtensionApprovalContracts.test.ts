import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as wire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { decodeApprovalPreview, encodeApprovalConfirmationFrame, encodeApprovalDecisionFrame } from '@/codecs/binary/authoringExtensionApprovalCodecs';

import { AEDS_HEADER_LENGTH, FrameType } from '@wasm/protocol/frame';

const corpus = JSON.parse(readFileSync(new URL('../../../fixtures/protocol/authoring-extension-approval-wire-golden.json', import.meta.url), 'utf8')) as {
    cases: Array<{ record: string; name: string; payloadHex: string; valid: boolean }>;
};
const payload = (name: string): Uint8Array => Uint8Array.from(Buffer.from(corpus.cases.find(row => row.name === name)!.payloadHex, 'hex'));
function decode(record: string, bytes: Uint8Array): unknown
{
    if (record === 'AuthoringExtensionApprovalDecisionRequest')
    {
        return wire.decodeAuthoringExtensionApprovalDecisionRequest(bytes);
    }
    if (record === 'AuthoringExtensionApprovalConfirmationRequest')
    {
        return wire.decodeAuthoringExtensionApprovalConfirmationRequest(bytes);
    }
    return wire.decodeAuthoringExtensionApprovalPreviewResponse(bytes);
}

describe('bounded approval wire through original registry without a production HTTP client', () =>
{
    it.each(corpus.cases)('$name', row =>
    {
        const operation = (): unknown => decode(row.record, Uint8Array.from(Buffer.from(row.payloadHex, 'hex')));
        if (row.valid)
        {
            expect(operation).not.toThrow();
        }
        else
        {
            expect(operation).toThrow();
        }
    });

    it('binds the registered preview to the located decision and retains exact int64/UTC strings', () =>
    {
        const value = decodeApprovalPreview(payload('migration-format-only'), 'a'.repeat(64));
        expect(value.records).toBe('9007199254740993');
        expect(value.bytes).toBe('9223372036854775807');
        expect(value.expiresAtUtc).toBe('638954208000000001');
        expect(value.operationContext.authorizationPolicy).toBe('canonical-state-scope-authority-required-v1');
        expect(() => decodeApprovalPreview(payload('migration-format-only'), 'b'.repeat(64))).toThrow('authoring_approval_decision_binding_invalid');
    });

    it('emits only the original generated decision and confirmation frames', () =>
    {
        const decision = wire.decodeAuthoringExtensionApprovalDecisionRequest(payload('decision-location-only'));
        const confirmation = wire.decodeAuthoringExtensionApprovalConfirmationRequest(payload('display-confirmation-only'));
        for (const [buffer, frame, expected] of [
            [encodeApprovalDecisionFrame(decision), FrameType.AuthoringExtensionApprovalDecisionRequest, payload('decision-location-only')],
            [encodeApprovalConfirmationFrame(confirmation), FrameType.AuthoringExtensionApprovalConfirmationRequest, payload('display-confirmation-only')]
        ] as const)
        {
            expect(new DataView(buffer).getUint16(8, true)).toBe(frame);
            expect(new Uint8Array(buffer).subarray(AEDS_HEADER_LENGTH)).toEqual(expected);
        }
        expect(() => encodeApprovalDecisionFrame({ ...decision, contractVersion: 1 })).toThrow();
    });
});
