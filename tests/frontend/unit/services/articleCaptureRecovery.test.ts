import { describe, expect, it } from 'vitest';

import { describeArticleCaptureRequest } from '@/services/articleCaptureRecovery';

const captureId = '12345678-1234-1234-1234-123456789abc';
const identity = { requestId: '87654321-4321-4321-4321-cba987654321', clientRevision: 'client-2382-original' };

describe('capture request correlation source controls, runtime held', () =>
{
    it('retains exact raw title, BOM, CRLF, trailing whitespace and final-newline state', () =>
    {
        const input = { schemaVersion: 1 as const, title: '  原始标题  ', markdownContent: '\uFEFF# 文本🙂\r\n尾部  \r\n' };
        const request = describeArticleCaptureRequest('7', captureId, identity, input);
        expect(request.input).toEqual(input);
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.input)).toBe(true);
        const trimmed = describeArticleCaptureRequest('7', captureId, identity, { ...input, title: input.title.trim() });
        const folded = describeArticleCaptureRequest('7', captureId, identity, { ...input, markdownContent: input.markdownContent.replaceAll('\r\n', '\n') });
        const finalLineRemoved = describeArticleCaptureRequest('7', captureId, identity, { ...input, markdownContent: input.markdownContent.slice(0, -2) });
        expect(trimmed.inputDigest).not.toBe(request.inputDigest);
        expect(folded.inputDigest).not.toBe(request.inputDigest);
        expect(finalLineRemoved.inputDigest).not.toBe(request.inputDigest);
    });

    it('binds actual actor/UUID while retaining one exact input digest and canonical Guid identity', () =>
    {
        const input = { schemaVersion: 1 as const, title: 'Title', markdownContent: '' };
        const first = describeArticleCaptureRequest('9223372036854775807', captureId, identity, input);
        const otherActor = describeArticleCaptureRequest('9223372036854775806', captureId, identity, input);
        const otherUuid = describeArticleCaptureRequest('9223372036854775807', captureId, { ...identity, requestId: captureId }, input);
        const upper = describeArticleCaptureRequest('9223372036854775807', captureId.toUpperCase(), { ...identity, requestId: identity.requestId.toUpperCase() }, input);
        expect(otherActor.inputDigest).toBe(first.inputDigest);
        expect(otherActor.requestDigest).not.toBe(first.requestDigest);
        expect(otherUuid.requestDigest).not.toBe(first.requestDigest);
        expect(upper.requestDigest).toBe(first.requestDigest);
        expect(upper.requestId).toBe(identity.requestId);
    });

    it('separates length-prefixed title/body fields and never treats equal concatenations as equal input', () =>
    {
        const first = describeArticleCaptureRequest('7', captureId, identity, { schemaVersion: 1, title: 'ab', markdownContent: 'c' });
        const second = describeArticleCaptureRequest('7', captureId, identity, { schemaVersion: 1, title: 'a', markdownContent: 'bc' });
        expect(first.inputDigest).not.toBe(second.inputDigest);
        expect(first.requestDigest).not.toBe(second.requestDigest);
    });

    it('admits title-only/body-only and .NET non-whitespace BOM without fabricating template or URL support', () =>
    {
        expect(describeArticleCaptureRequest('7', captureId, identity, { schemaVersion: 1, title: 'Title', markdownContent: '' }).input.title).toBe('Title');
        expect(describeArticleCaptureRequest('7', captureId, identity, { schemaVersion: 1, title: '', markdownContent: '\uFEFF' }).input.markdownContent).toBe('\uFEFF');
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { schemaVersion: 1, title: ' ', markdownContent: '\u0085\u3000' })).toThrow();
        const url = { schemaVersion: 1 as const, title: 'Title', markdownContent: '', sourceUrl: 'https://example.test' };
        const template = { schemaVersion: 1 as const, title: 'Title', markdownContent: '', templateId: captureId };
        expect(() => describeArticleCaptureRequest('7', captureId, identity, url)).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, identity, template)).toThrow();
    });

    it('refuses control-title, lossy UTF16, overbound input and invalid actor/request identity', () =>
    {
        const valid = { schemaVersion: 1 as const, title: 'Title', markdownContent: '' };
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { ...valid, title: 'Title\n' })).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { ...valid, title: '\uD800' })).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { ...valid, markdownContent: '\uDFFF' })).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { ...valid, title: 'x'.repeat(257) })).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, identity, { ...valid, markdownContent: 'x'.repeat(200_001) })).toThrow();
        expect(() => describeArticleCaptureRequest('0', captureId, identity, valid)).toThrow();
        expect(() => describeArticleCaptureRequest('9223372036854775808', captureId, identity, valid)).toThrow();
        expect(() => describeArticleCaptureRequest('7', captureId, { ...identity, requestId: '00000000-0000-0000-0000-000000000000' }, valid)).toThrow();
    });
});
