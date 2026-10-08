import { describe, expect, it } from 'vitest';

import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import type { WritingAidPreferenceSnapshot } from '@/contracts/binaryApi';
import { projectWritingAidPreference } from '@/services/authoring/writingAidPreferenceProjection';

import { FrameType } from '@wasm/protocol/frame';

import golden from '../../../fixtures/protocol/writing-aid-preference-wire-golden.json';

function snapshot(name: string): WritingAidPreferenceSnapshot
{
    const row = golden.cases.find(candidate => candidate.name === name);
    if (!row)
    {
        throw new Error(`missing independent fixture: ${name}`);
    }
    return decodeBinaryFramePayload(FrameType.WritingAidPreferenceSnapshotResponse,
        Uint8Array.from(Buffer.from(row.payloadHex, 'hex'))) as WritingAidPreferenceSnapshot;
}

describe('account writing aid public request projection', () =>
{
    it.each(Array.from({ length: 8 }, (_, index) => index))('keeps all three independent preferred values in combination %i', index =>
    {
        const value = snapshot(`snapshot-values-${index}`);
        const before = structuredClone(value);
        const result = projectWritingAidPreference(value, value.owner);
        expect(result.editorWritingAids).toEqual({ focus: (index & 1) !== 0, typewriter: (index & 2) !== 0 });
        expect(result.immersiveEnabled).toBe((index & 4) !== 0);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.editorWritingAids)).toBe(true);
        expect(value).toEqual(before);
    });

    it('keeps actual server defaults off and missing account authority unavailable', () =>
    {
        const value = snapshot('snapshot-defaults-zero');
        expect(projectWritingAidPreference(value, value.owner)).toEqual({
            editorWritingAids: { focus: false, typewriter: false }, immersiveEnabled: false
        });
        expect(projectWritingAidPreference(null, value.owner)).toEqual({ editorWritingAids: null, immersiveEnabled: null });
    });

    it('retains no preference after logout and refuses prior-account or prior-site snapshots', () =>
    {
        const value = snapshot('snapshot-values-7');
        projectWritingAidPreference(value, value.owner);
        expect(projectWritingAidPreference(null, { ...value.owner, userScope: 'account:43' }))
            .toEqual({ editorWritingAids: null, immersiveEnabled: null });
        expect(() => projectWritingAidPreference(value, { ...value.owner, userScope: 'account:43' }))
            .toThrow('writing_aid_preference_payload_invalid');
        expect(() => projectWritingAidPreference(value, { ...value.owner, siteScope: 'site:other' }))
            .toThrow('writing_aid_preference_payload_invalid');
    });

    it('exposes only public editor requests and the independent shell preference', () =>
    {
        const value = snapshot('snapshot-values-4');
        expect(projectWritingAidPreference(value, value.owner)).toEqual({
            editorWritingAids: { focus: false, typewriter: false }, immersiveEnabled: true
        });
        expect(Object.keys(projectWritingAidPreference(value, value.owner)).sort())
            .toEqual(['editorWritingAids', 'immersiveEnabled']);
    });

    it('uses the original codec refusal for corrupt or legacy preferences', () =>
    {
        const value = snapshot('snapshot-values-7');
        expect(() => projectWritingAidPreference({ ...value, contentDigest: '0'.repeat(64) }, value.owner))
            .toThrow('writing_aid_preference_payload_invalid');
        expect(() => projectWritingAidPreference({ ...value, values: { ...value.values, zen: true } } as WritingAidPreferenceSnapshot,
            value.owner)).toThrow('writing_aid_preference_payload_invalid');
    });
});
