import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { articlePropertyDefinitionsApi } from '@/api/articlePropertyDefinitions';
import { articlePropertyValuesApi } from '@/api/articlePropertyValues';
import { encodeAedsFrame } from '@/api/binaryFrame';
import * as wire from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

import { decode } from '@wasm/aeds';
import { AEDS_HEADER_LENGTH, FrameType } from '@wasm/protocol/frame';

vi.mock('@/composables/usePow', () => ({ usePow: () => ({ calculate: async () => ({ nonce: '1', duration: 1 }) }) }));
vi.mock('@/utils/fingerprint', () => ({ getBrowserFp: () => 'property-transport-fingerprint' }));

const golden = JSON.parse(readFileSync(new URL('../../../fixtures/protocol/article-property-mutation-wire-golden.json', import.meta.url), 'utf8')) as {
    cases: Array<{ name: string; payloadHex: string }>;
};
const fetchBoundary = vi.fn();
function bytes(name: string): Uint8Array
{
    return Uint8Array.from(Buffer.from(golden.cases.find(item => item.name === name)!.payloadHex, 'hex'));
}
function challenge(): Response
{
    const payload = new Uint8Array(204);
    payload.set(new TextEncoder().encode('property-salt'));
    new DataView(payload.buffer).setInt32(64, 1, true);
    new DataView(payload.buffer).setBigInt64(68, 1710000000000n, true);
    payload.set(new TextEncoder().encode('property-signature'), 76);
    return new Response(encodeAedsFrame(FrameType.PowChallenge, payload));
}
function respond(type: FrameType, payload: Uint8Array): void
{
    fetchBoundary.mockImplementation(async (url: string) => url.includes('pow-challenge')
        ? challenge() : new Response(encodeAedsFrame(type, payload)));
}
function mutationCall(): [string, RequestInit]
{
    return fetchBoundary.mock.calls.find(([url]) => !String(url).includes('pow-challenge')) as [string, RequestInit];
}
beforeEach(() =>
{
    privateRequestRuntime.resetForTests();
    fetchBoundary.mockReset();
    vi.stubGlobal('fetch', fetchBoundary);
    // Native extraction and PoW calculation are substituted; registry, codec, leases and binary client execute.
    vi.mocked(decode).mockImplementation(buffer =>
    {
        const view = new DataView(buffer);
        return { ok: true, frameType: view.getUint16(8, true), payloadView: new Uint8Array(buffer).subarray(AEDS_HEADER_LENGTH), error: '' };
    });
});
afterEach(() =>
{
    privateRequestRuntime.resetForTests();
    vi.unstubAllGlobals();
});

describe('formal property mutation API through private binary client and registry', () =>
{
    it('posts exact command frame and consumes a persisted receipt without a read request', async () =>
    {
        const command = wire.decodeArticlePropertyValueMutationCommand(bytes('value-0'));
        const receipt = wire.decodeArticlePropertyValueMutationReceipt(bytes('persisted-value-receipt'));
        respond(FrameType.ArticlePropertyValueMutationReceipt, wire.encodeArticlePropertyValueMutationReceipt(receipt));
        expect(await articlePropertyValuesApi.mutate(command)).toEqual(receipt);
        const [url, init] = mutationCall();
        expect(url).toContain('/api/binary/author/articles/7/properties');
        expect(init.method).toBe('POST');
        expect(init.cache).toBe('no-store');
        expect(init.credentials).toBe('include');
        expect(new Headers(init.headers).get('X-Fsus-Pow-Proof')).toBeTruthy();
        const frame = init.body as ArrayBuffer;
        expect(new DataView(frame).getUint16(8, true)).toBe(FrameType.ArticlePropertyValueMutationCommand);
        expect(wire.decodeArticlePropertyValueMutationCommand(new Uint8Array(frame).subarray(AEDS_HEADER_LENGTH))).toEqual(command);
        expect(fetchBoundary.mock.calls.filter(([target]) => !String(target).includes('pow-challenge'))).toHaveLength(1);
    });

    it.each(['requestId', 'articleId', 'definitionOwnerUserId', 'siteScope', 'expectedArticleRevisionId',
        'beforePropertyRevision', 'afterPropertyRevision', 'commandKind'] as const)('refuses altered receipt coordinate %s', async key =>
    {
        const command = wire.decodeArticlePropertyValueMutationCommand(bytes('value-0'));
        const receipt = wire.decodeArticlePropertyValueMutationReceipt(bytes('persisted-value-receipt'));
        const changes = { requestId: '10112233-4455-6677-8899-aabbccddeeff', articleId: 8,
            definitionOwnerUserId: '43', siteScope: 'foreign-site', expectedArticleRevisionId: '1',
            beforePropertyRevision: '1', afterPropertyRevision: '2', commandKind: 0 };
        respond(FrameType.ArticlePropertyValueMutationReceipt,
            wire.encodeArticlePropertyValueMutationReceipt({ ...receipt, [key]: changes[key] }));
        await expect(articlePropertyValuesApi.mutate(command)).rejects.toThrow('article_property_value_receipt_binding_invalid');
    });

    it('refuses a read snapshot in place of the persisted receipt', async () =>
    {
        respond(FrameType.ArticlePropertyValueReadResponse, new Uint8Array([2]));
        await expect(articlePropertyValuesApi.mutate(wire.decodeArticlePropertyValueMutationCommand(bytes('value-0')))).rejects.toThrow();
    });

    it('creates definitions and binds persisted receipt owner/revision/identity', async () =>
    {
        const command = wire.decodeArticlePropertyDefinitionCreateRequest(bytes('definition-create'));
        const receipt = wire.decodeArticlePropertyDefinitionMutationReceipt(bytes('persisted-definition-receipt'));
        respond(FrameType.ArticlePropertyDefinitionMutationReceipt, wire.encodeArticlePropertyDefinitionMutationReceipt(receipt));
        expect(await articlePropertyDefinitionsApi.create(command)).toEqual(receipt);
        const [url, init] = mutationCall();
        expect(url).toContain('/api/binary/author/property-definitions');
        expect(new DataView(init.body as ArrayBuffer).getUint16(8, true)).toBe(FrameType.ArticlePropertyDefinitionCreateRequest);
        respond(FrameType.ArticlePropertyDefinitionMutationReceipt,
            wire.encodeArticlePropertyDefinitionMutationReceipt({ ...receipt, definitionOwnerUserId: '43' }));
        await expect(articlePropertyDefinitionsApi.create(command)).rejects.toThrow('article_property_definition_receipt_binding_invalid');
    });
});
