import { describe, expect, it } from 'vitest';

import {
    buildSavedViewDeepLink,
    readSavedViewDeepLink
} from '@/components/admin/saved-views/savedViewDeepLink';

const viewId = '11111111-1111-4111-8111-111111111111';

describe('saved-view deep-link schema boundaries', () =>
{
    it.each([1, 999_999_999])('roundtrips the canonical schema boundary %s', (schemaVersion) =>
    {
        const link = buildSavedViewDeepLink('/manage/articles', viewId, schemaVersion);
        const parameters = new URL(link, 'https://fsusblog.test').searchParams;
        expect(parameters.get('viewSchema')).toBe(String(schemaVersion));
        expect(readSavedViewDeepLink(parameters)).toEqual({ status: 'resolve', viewId, schemaVersion });
    });

    it.each([
        0,
        -0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        1_000_000_000,
        Number.MAX_SAFE_INTEGER
    ])('refuses to build an out-of-grammar schema version %s', (schemaVersion) =>
    {
        expect(() => buildSavedViewDeepLink('/manage/articles', viewId, schemaVersion))
            .toThrow('saved_view_deep_link_invalid');
    });

    it.each([
        '',
        '0',
        '-0',
        '-1',
        '01',
        '+1',
        '1.0',
        '1e0',
        '1E0',
        '0x1',
        ' 1',
        '1 ',
        '1\n',
        'NaN',
        'Infinity',
        '1000000000',
        '999999999.0000000001'
    ])('refuses noncanonical schema text %j', (version) =>
    {
        const parameters = new URLSearchParams({ view: viewId, viewSchema: version });
        expect(readSavedViewDeepLink(parameters).status).toBe('invalid');
    });

    it.each([
        `view=${viewId}`,
        `view=${viewId}&viewSchema=1&viewSchema=1`
    ])('requires exactly one schema version: %s', (parameters) =>
    {
        expect(readSavedViewDeepLink(new URLSearchParams(parameters)).status).toBe('invalid');
    });

    it('preserves a mixed-case UUID through the maximum schema boundary', () =>
    {
        const mixedCaseViewId = 'ABCDEFAB-cdef-4ABC-8def-ABCDEFABCDEF';
        const link = buildSavedViewDeepLink('/manage/articles', mixedCaseViewId, 999_999_999);
        expect(readSavedViewDeepLink(new URL(link, 'https://fsusblog.test').searchParams)).toEqual({
            status: 'resolve',
            viewId: mixedCaseViewId,
            schemaVersion: 999_999_999
        });
    });
});
