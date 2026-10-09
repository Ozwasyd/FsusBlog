import type { ArticlePropertyExactDecimal } from '@/codecs/binary/articlePropertyValueReadCodecs';

// Pure editor representation, released by the canonical property owner in
// 0d9cd9b. These results are structural conversion only, never Server validation.
export type ArticleMetadataExactEditError = 'syntax' | 'coefficient-range' | 'scale-range'
    | 'calendar-range' | 'tick-range' | 'invalid-value';
export type ArticleMetadataExactEditResult<T> = { ok: true; value: T; }
    | { ok: false; error: ArticleMetadataExactEditError; };

const maxCoefficient = (1n << 96n) - 1n;
const wordMask = (1n << 32n) - 1n;
const ticksPerSecond = 10_000_000n;
const ticksPerDay = 86400n * ticksPerSecond;
const maxTicks = 3155378975999999999n;

function failure(error: ArticleMetadataExactEditError): { ok: false; error: ArticleMetadataExactEditError; }
{
    return { ok: false, error };
}
function isWord(value: number): boolean
{
    return Number.isInteger(value) && value >= 0 && value <= 4294967295;
}

export function formatArticlePropertyExactDecimal(value: ArticlePropertyExactDecimal): ArticleMetadataExactEditResult<string>
{
    if (!value || !isWord(value.lo) || !isWord(value.mid) || !isWord(value.hi)
        || !Number.isInteger(value.scale) || typeof value.negative !== 'boolean')
    {
        return failure('invalid-value');
    }
    if (value.scale < 0 || value.scale > 28)
    {
        return failure('scale-range');
    }
    const coefficient = BigInt(value.lo) | (BigInt(value.mid) << 32n) | (BigInt(value.hi) << 64n);
    const digits = coefficient.toString().padStart(value.scale + 1, '0');
    const magnitude = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
    return { ok: true, value: `${value.negative ? '-' : ''}${magnitude}` };
}

export function parseArticlePropertyExactDecimal(text: string): ArticleMetadataExactEditResult<ArticlePropertyExactDecimal>
{
    // Decimal-point syntax only: no locale/grouping/exponent, plus, whitespace
    // or inferred default. Fractional zeroes and a negative zero retain identity.
    const match = typeof text === 'string' ? /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text) : null;
    if (match?.[0] !== text)
    {
        return failure('syntax');
    }
    const fraction = match[3] ?? '';
    if (fraction.length > 28)
    {
        return failure('scale-range');
    }
    const digits = `${match[2]}${fraction}`.replace(/^0+/, '') || '0';
    if (digits.length > 29)
    {
        return failure('coefficient-range');
    }
    const coefficient = BigInt(digits);
    if (coefficient > maxCoefficient)
    {
        return failure('coefficient-range');
    }
    // Each conversion below is confined to one unsigned32 word, exactly
    // representable by the public codec's number field; no decimal float exists.
    return { ok: true, value: { lo: Number(coefficient & wordMask), mid: Number((coefficient >> 32n) & wordMask),
        hi: Number(coefficient >> 64n), scale: fraction.length, negative: match[1] === '-' } };
}

function monthLengths(year: bigint): readonly bigint[]
{
    const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
    return [31n, leap ? 29n : 28n, 31n, 30n, 31n, 30n, 31n, 31n, 30n, 31n, 30n, 31n];
}
function pad(value: bigint, width: number): string
{
    return value.toString().padStart(width, '0');
}

export function formatArticlePropertyUtcTicks(ticks: string): ArticleMetadataExactEditResult<string>
{
    if (typeof ticks !== 'string' || /^(0|[1-9][0-9]*)$/.exec(ticks)?.[0] !== ticks)
    {
        return failure('invalid-value');
    }
    if (ticks.length > 19 || BigInt(ticks) > maxTicks)
    {
        return failure('tick-range');
    }
    const total = BigInt(ticks);
    let days = total / ticksPerDay;
    const cycles400 = days / 146097n;
    days %= 146097n;
    let cycles100 = days / 36524n;
    if (cycles100 === 4n)
    {
        cycles100 = 3n;
    }
    days -= cycles100 * 36524n;
    const cycles4 = days / 1461n;
    days %= 1461n;
    let cycles1 = days / 365n;
    if (cycles1 === 4n)
    {
        cycles1 = 3n;
    }
    days -= cycles1 * 365n;
    const year = cycles400 * 400n + cycles100 * 100n + cycles4 * 4n + cycles1 + 1n;
    let month = 1n;
    for (const length of monthLengths(year))
    {
        if (days < length)
        {
            break;
        }
        days -= length;
        month++;
    }
    const time = total % ticksPerDay;
    const seconds = time / ticksPerSecond;
    return { ok: true, value: `${pad(year, 4)}-${pad(month, 2)}-${pad(days + 1n, 2)}T${pad(seconds / 3600n, 2)}:${pad(seconds / 60n % 60n, 2)}:${pad(seconds % 60n, 2)}.${pad(time % ticksPerSecond, 7)}Z` };
}

export function parseArticlePropertyUtcTicks(text: string): ArticleMetadataExactEditResult<string>
{
    // UTC-only ISO text with all seven100ns digits. No Date/Dayjs, timezone
    // conversion, leap-second normalization or fractional precision truncation.
    const match = typeof text === 'string'
        ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{7})Z$/.exec(text) : null;
    if (match?.[0] !== text)
    {
        return failure('syntax');
    }
    const year = BigInt(match[1]);
    const month = BigInt(match[2]);
    const day = BigInt(match[3]);
    const hour = BigInt(match[4]);
    const minute = BigInt(match[5]);
    const second = BigInt(match[6]);
    if (year < 1n || year > 9999n || month < 1n || month > 12n || day < 1n
        || hour > 23n || minute > 59n || second > 59n)
    {
        return failure('calendar-range');
    }
    const previousYear = year - 1n;
    let days = previousYear * 365n + previousYear / 4n - previousYear / 100n + previousYear / 400n;
    let currentMonth = 1n;
    for (const length of monthLengths(year))
    {
        if (currentMonth === month)
        {
            if (day > length)
            {
                return failure('calendar-range');
            }
            break;
        }
        days += length;
        currentMonth++;
    }
    const ticks = (days + day - 1n) * ticksPerDay
        + (hour * 3600n + minute * 60n + second) * ticksPerSecond + BigInt(match[7]);
    return ticks > maxTicks ? failure('tick-range') : { ok: true, value: ticks.toString() };
}
