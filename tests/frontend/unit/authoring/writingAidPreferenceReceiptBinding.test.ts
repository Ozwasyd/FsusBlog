import { describe, expect, it } from 'vitest';

import {
    decodeWritingAidPreferenceUpdateRequest
} from '@/codecs/binary/writingAidPreferenceWire.generated';
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import type {
    WritingAidPreferenceReceipt,
    WritingAidPreferenceSnapshot,
    WritingAidPreferenceUpdate
} from '@/contracts/binaryApi';
import {
    bindWritingAidPreferenceSnapshot,
    bindWritingAidPreferenceUpdateReceipt
} from '@/services/authoring/writingAidPreferenceReceiptBinding';

import { FrameType } from '@wasm/protocol/frame';

import golden from '../../../fixtures/protocol/writing-aid-preference-wire-golden.json';

function bytes(name: string): Uint8Array
{
    const row = golden.cases.find(candidate => candidate.name === name);
    if (!row)
    {
        throw new Error(`missing independent fixture: ${name}`);
    }
    return Uint8Array.from(Buffer.from(row.payloadHex, 'hex'));
}

function receipt(name = 'receipt-values-5'): WritingAidPreferenceReceipt
{
    return decodeBinaryFramePayload(FrameType.WritingAidPreferenceReceiptResponse, bytes(name)) as WritingAidPreferenceReceipt;
}

function request(name = 'update-values-5'): WritingAidPreferenceUpdate
{
    return decodeWritingAidPreferenceUpdateRequest(bytes(name));
}

function bind(value = receipt(), update = request(), previous = value.previous): WritingAidPreferenceReceipt
{
    return bindWritingAidPreferenceUpdateReceipt(value, value.previous.owner, value.deviceScope, previous, update);
}

describe('writing aid decoded response request binding', () =>
{
    it.each(Array.from({ length: 8 }, (_, index) => index))('binds all independent boolean combinations %i through the actual registry', index =>
    {
        const value = receipt(`receipt-values-${index}`);
        const result = bind(value, request(`update-values-${index}`));
        expect(result).toEqual(value);
        expect(result).not.toBe(value);
        expect(result.previous).not.toBe(value.previous);
        expect(result.committed.values).not.toBe(value.committed.values);
    });

    it.each([null, undefined])('refuses absent receipt %s instead of acknowledging persistence', value =>
    {
        const original = receipt();
        expect(() => bindWritingAidPreferenceUpdateReceipt(value, original.previous.owner,
            original.deviceScope, original.previous, request())).toThrow('writing_aid_preference_receipt_missing');
    });

    it.each(['account:43', 'admin:42'])('refuses a valid response after a user switch to %s', userScope =>
    {
        const value = receipt();
        expect(() => bindWritingAidPreferenceUpdateReceipt(value, { ...value.previous.owner, userScope },
            value.deviceScope, value.previous, request())).toThrow('writing_aid_preference_payload_invalid');
    });

    it('refuses a different current site and device without mutating the response', () =>
    {
        const value = receipt();
        const before = structuredClone(value);
        expect(() => bindWritingAidPreferenceUpdateReceipt(value, { ...value.previous.owner, siteScope: 'site:other' },
            value.deviceScope, value.previous, request())).toThrow('writing_aid_preference_payload_invalid');
        expect(() => bindWritingAidPreferenceUpdateReceipt(value, value.previous.owner,
            `device:${'b'.repeat(64)}`, value.previous, request())).toThrow('writing_aid_preference_receipt_request_mismatch');
        expect(value).toEqual(before);
    });

    it.each(['focusEnabled', 'typewriterEnabled', 'immersiveEnabled'] as const)('refuses a receipt for different requested %s', field =>
    {
        const update = request();
        update.values[field] = !update.values[field];
        expect(() => bind(receipt(), update)).toThrow('writing_aid_preference_receipt_request_mismatch');
    });

    it('refuses a different CAS revision and operation even with a valid receipt digest', () =>
    {
        expect(() => bind(receipt(), { ...request(), expectedRevision: 6 })).toThrow('writing_aid_preference_receipt_request_mismatch');
        expect(() => bind(receipt(), { ...request(), operationId: 'abcdef01-2345-6789-abcd-ef0123456789' })).toThrow('writing_aid_preference_receipt_request_mismatch');
    });

    it('refuses initialization as an update acknowledgement', () =>
    {
        const value = receipt('receipt-initialize');
        expect(() => bind(value, { ...request(), expectedRevision: value.previous.revision,
            operationId: value.operationId, values: value.committed.values })).toThrow('writing_aid_preference_receipt_request_mismatch');
    });

    it('refuses a different valid previous snapshot rather than checking revision alone', () =>
    {
        const value = receipt();
        const previous = decodeBinaryFramePayload(FrameType.WritingAidPreferenceSnapshotResponse,
            bytes('snapshot-values-1')) as WritingAidPreferenceSnapshot;
        expect(previous.revision).toBe(value.previous.revision);
        expect(() => bind(value, request(), previous)).toThrow('writing_aid_preference_receipt_request_mismatch');
    });

    it('reuses the generated closed validators for tamper and unknown fields', () =>
    {
        const value = receipt();
        expect(() => bind({ ...value, contentDigest: '0'.repeat(64) })).toThrow('writing_aid_preference_payload_invalid');
        expect(() => bind({ ...value, articleId: 42 } as WritingAidPreferenceReceipt)).toThrow('writing_aid_preference_payload_invalid');
        expect(() => bind(value, { ...request(), deviceScope: value.deviceScope } as WritingAidPreferenceUpdate))
            .toThrow('writing_aid_preference_payload_invalid');
    });

    it('returns an independent validated snapshot bound to the current owner', () =>
    {
        const value = receipt().committed;
        const result = bindWritingAidPreferenceSnapshot(value, value.owner);
        expect(result).toEqual(value);
        result.values.focusEnabled = !result.values.focusEnabled;
        expect(value.values.focusEnabled).toBe(true);
    });
});
