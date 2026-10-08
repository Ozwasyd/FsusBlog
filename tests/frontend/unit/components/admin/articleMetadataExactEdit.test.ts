import { describe, expect, it } from 'vitest';

import { formatArticlePropertyExactDecimal, formatArticlePropertyUtcTicks, parseArticlePropertyExactDecimal,
    parseArticlePropertyUtcTicks } from '@/components/admin/article/articleMetadataExactEdit';

const maximum = { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 0, negative: false };
const zero = { lo: 0, mid: 0, hi: 0, scale: 0, negative: false };

describe('released Decimal96 exact editor representation', () =>
{
    it.each([
        ['0', zero], ['-0', { ...zero, negative: true }],
        ['-0.0000000000000000000000000000', { ...zero, scale: 28, negative: true }],
        ['4294967295', { ...zero, lo: 4294967295 }], ['4294967296', { ...zero, mid: 1 }],
        ['18446744073709551616', { ...zero, hi: 1 }],
        ['79228162514264337593543950335', maximum],
        ['-7.9228162514264337593543950335', { ...maximum, scale: 28, negative: true }],
        ['1.2300', { ...zero, lo: 12300, scale: 4 }],
        ['0.0000000000000000000000000001', { ...zero, lo: 1, scale: 28 }]
    ] as const)('preserves every word, scale and sign for %s', (text, value) =>
    {
        expect(parseArticlePropertyExactDecimal(text)).toEqual({ ok: true, value });
        expect(formatArticlePropertyExactDecimal(value)).toEqual({ ok: true, value: text });
    });

    it('roundtrips all29 scales, both signs and deterministic full96-bit coefficients exactly', () =>
    {
        let seed = 0x91abcd123456789abcdef12345n;
        for (let scale = 0; scale <= 28; scale++) for (const negative of [false, true])
        {
            seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 96n) - 1n);
            const value = { lo: Number(seed & 0xffffffffn), mid: Number(seed >> 32n & 0xffffffffn), hi: Number(seed >> 64n), scale, negative };
            const formatted = formatArticlePropertyExactDecimal(value);
            expect(formatted.ok).toBe(true);
            if (!formatted.ok) throw new Error('missing exact text');
            expect(parseArticlePropertyExactDecimal(formatted.value)).toEqual({ ok: true, value });
        }
    });

    it('accepts redundant leading zeros while preserving coefficient, fraction length and negative zero', () =>
    {
        expect(parseArticlePropertyExactDecimal('0001.2300')).toEqual({ ok: true, value: { ...zero, lo: 12300, scale: 4 } });
        expect(parseArticlePropertyExactDecimal('-000.00')).toEqual({ ok: true, value: { ...zero, scale: 2, negative: true } });
    });

    it.each(['', ' ', '1\n', '1\r\n', '\t1', '1 ', '+1', '.5', '1.', '1e3', '1E-2', '1,5', '1_000', 'NaN', 'Infinity', '--1', '０.５', 'private-value<script>'])('returns a closed syntax failure for %j', (text) =>
    {
        expect(parseArticlePropertyExactDecimal(text)).toEqual({ ok: false, error: 'syntax' });
    });
    it.each(['79228162514264337593543950336', '-79228162514264337593543950336', '1000000000000000000000000000000', '7.9228162514264337593543950336'])('rejects coefficient overflow without clipping %s', (text) =>
    {
        expect(parseArticlePropertyExactDecimal(text)).toEqual({ ok: false, error: 'coefficient-range' });
    });
    it('rejects scale29 and malformed typed words without normalization or throwing', () =>
    {
        expect(parseArticlePropertyExactDecimal('0.' + '0'.repeat(29))).toEqual({ ok: false, error: 'scale-range' });
        for (const value of [{ ...zero, lo: -1 }, { ...zero, mid: 4294967296 }, { ...zero, hi: 1.5 }, { ...zero, lo: NaN }])
            expect(formatArticlePropertyExactDecimal(value)).toEqual({ ok: false, error: 'invalid-value' });
        for (const scale of [-1, 29]) expect(formatArticlePropertyExactDecimal({ ...zero, scale })).toEqual({ ok: false, error: 'scale-range' });
    });
});

// Independent calendar vectors: Python datetime.date ordinal difference from
// 0001-01-01 times864000000000, plus exact integer time/fraction. No JS Date.
const utcVectors = [
    ['0', '0001-01-01T00:00:00.0000000Z'],
    ['1', '0001-01-01T00:00:00.0000001Z'],
    ['863999999999', '0001-01-01T23:59:59.9999999Z'],
    ['997056000000000', '0004-02-29T00:00:00.0000000Z'],
    ['31292352000000000', '0100-03-01T00:00:00.0000000Z'],
    ['125962560000000000', '0400-02-29T00:00:00.0000000Z'],
    ['126226944000000000', '0400-12-31T00:00:00.0000000Z'],
    ['504645984000000000', '1600-02-29T00:00:00.0000000Z'],
    ['599317056000000000', '1900-03-01T00:00:00.0000000Z'],
    ['630873792000000000', '2000-02-29T00:00:00.0000000Z'],
    ['638948736000000001', '2025-10-01T00:00:00.0000001Z'],
    ['3155378112000000000', '9999-12-31T00:00:00.0000000Z'],
    ['3155378975999999999', '9999-12-31T23:59:59.9999999Z']
] as const;

describe('released UTC ticks exact editor representation', () =>
{
    it.each(utcVectors)('roundtrips independent tick/calendar vector %s', (ticks, text) =>
    {
        expect(formatArticlePropertyUtcTicks(ticks)).toEqual({ ok: true, value: text });
        expect(parseArticlePropertyUtcTicks(text)).toEqual({ ok: true, value: ticks });
    });
    it('retains all100ns fractions across month/year boundaries and deterministic full-range ticks', () =>
    {
        let ticks = 123456789n;
        for (let index = 0; index < 500; index++)
        {
            ticks = (ticks * 6364136223846793005n + 1442695040888963407n) % 3155378976000000000n;
            const formatted = formatArticlePropertyUtcTicks(ticks.toString());
            expect(formatted.ok).toBe(true);
            if (!formatted.ok) throw new Error('missing UTC text');
            expect(formatted.value).toMatch(/\.[0-9]{7}Z$/);
            expect(parseArticlePropertyUtcTicks(formatted.value)).toEqual({ ok: true, value: ticks.toString() });
        }
    });
    it.each(['', '2025-10-01', '2025-10-01T00:00:00Z', '2025-10-01T00:00:00.000Z',
        '2025-10-01T00:00:00.00000001Z', '2025-10-01T00:00:00.0000000+00:00', '2025-10-01T00:00:00.0000000z',
        '2025-10-01T00:00:00.0000000Z\n', ' 2025-10-01T00:00:00.0000000Z', '10000-01-01T00:00:00.0000000Z'])('rejects unsupported syntax without Date conversion: %j', (text) =>
    {
        expect(parseArticlePropertyUtcTicks(text)).toEqual({ ok: false, error: 'syntax' });
    });
    it.each(['0000-01-01T00:00:00.0000000Z', '1900-02-29T00:00:00.0000000Z', '2025-02-29T00:00:00.0000000Z',
        '2025-04-31T00:00:00.0000000Z', '2025-00-01T00:00:00.0000000Z', '2025-13-01T00:00:00.0000000Z',
        '2025-01-00T00:00:00.0000000Z', '2025-01-01T24:00:00.0000000Z', '2025-01-01T00:60:00.0000000Z',
        '2025-01-01T00:00:60.0000000Z'])('rejects impossible calendar fields rather than normalizing %s', (text) =>
    {
        expect(parseArticlePropertyUtcTicks(text)).toEqual({ ok: false, error: 'calendar-range' });
    });
    it.each(['-1', '00', '+1', '1.0', '1e3', '1\n', 'private-ticks'])('refuses noncanonical tick text %j', (text) =>
    {
        expect(formatArticlePropertyUtcTicks(text)).toEqual({ ok: false, error: 'invalid-value' });
    });
    it.each(['3155378976000000000', '100000000000000000000000000000000000000'])('refuses ticks outside the published range %s', (ticks) =>
    {
        expect(formatArticlePropertyUtcTicks(ticks)).toEqual({ ok: false, error: 'tick-range' });
    });
});
