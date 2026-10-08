import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveBinaryTransportUrl } from '@/api/binaryApiClient';

afterEach(() => vi.unstubAllGlobals());

// URL resolution only: this is no HTTP/session/PoW or browser-runtime receipt.
describe('selected-ID transport consumes the canonical URL base', () =>
{
    it('uses an actual Location object for the selected-ID endpoint and relative browser paths', () =>
    {
        const browser = new Window({ url: 'https://consumer.test/admin/search?probe=1#results' });
        vi.stubGlobal('location', browser.location);
        expect(browser.location).not.toBeInstanceOf(URL);
        expect(resolveBinaryTransportUrl('/api/binary/author/articles/revalidate-selection'))
            .toBe('https://consumer.test/api/binary/author/articles/revalidate-selection');
        expect(resolveBinaryTransportUrl('../articles/revalidate-selection'))
            .toBe('https://consumer.test/articles/revalidate-selection');
    });

    it('preserves the existing localhost fallback with no Location', () =>
    {
        vi.stubGlobal('location', undefined);
        expect(resolveBinaryTransportUrl('/api/binary/author/articles/revalidate-selection'))
            .toBe('http://localhost/api/binary/author/articles/revalidate-selection');
    });
});
