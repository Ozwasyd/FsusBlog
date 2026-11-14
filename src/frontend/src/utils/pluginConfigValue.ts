export type PluginConfigTextResult =
    | { valid: true; value: unknown; }
    | { valid: false; error: string; };

function isDictionary(value: unknown): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchemaProperties(value: unknown): value is Record<string, Record<string, unknown>>
{
    return isDictionary(value) && Object.values(value).every(isDictionary);
}

export function readPluginConfigProperties(value: unknown): Record<string, Record<string, unknown>> | undefined
{
    return isSchemaProperties(value) ? value : undefined;
}

export function readPluginConfigValue(current: Readonly<Record<string, unknown>>, name: string): unknown
{
    return Object.hasOwn(current, name) ? current[name] : undefined;
}

export function readPluginConfigBoolean(value: unknown): boolean | undefined
{
    return typeof value === 'boolean' ? value : undefined;
}

export function readPluginConfigNumber(value: unknown): number | null | undefined
{
    return typeof value === 'number' || value === null ? value : undefined;
}

export function formatPluginConfigText(type: string, value: unknown): string
{
    if (value === undefined)
    {
        return '';
    }
    if (type === 'string' && typeof value === 'string')
    {
        return value;
    }
    const text = JSON.stringify(value);
    if (text === undefined)
    {
        throw new TypeError('Plugin configuration must contain JSON values');
    }
    return text;
}

function normalizeJsonNumber(text: string): string
{
    const lower = text.toLowerCase();
    const exponentIndex = lower.indexOf('e');
    const coefficient = exponentIndex < 0 ? lower : lower.slice(0, exponentIndex);
    const negative = coefficient.startsWith('-');
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const decimalIndex = unsigned.indexOf('.');
    const fractionalLength = decimalIndex < 0 ? 0 : unsigned.length - decimalIndex - 1;
    const digits = (decimalIndex < 0 ? unsigned : unsigned.replace('.', '')).replace(/^0+/u, '');
    if (digits === '')
    {
        return '0';
    }
    const significant = digits.replace(/0+$/u, '');
    const exponent = (exponentIndex < 0 ? 0n : BigInt(lower.slice(exponentIndex + 1)))
        - BigInt(fractionalLength) + BigInt(digits.length - significant.length);
    return `${negative ? '-' : ''}${significant}e${exponent}`;
}

function hasLosslessJsonNumbers(text: string): boolean
{
    // JSON.parse has already checked the grammar. Skip complete quoted strings;
    // compare only number tokens with the existing serializer's numeric value.
    const lexemes = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu;
    for (const match of text.matchAll(lexemes))
    {
        const token = match[0];
        if (token.startsWith('"'))
        {
            continue;
        }
        const value = Number(token);
        const encoded = JSON.stringify(value);
        if (!Number.isFinite(value) || encoded === undefined
            || normalizeJsonNumber(token) !== normalizeJsonNumber(encoded))
        {
            return false;
        }
    }
    return true;
}

export function parsePluginConfigText(type: string, text: string): PluginConfigTextResult
{
    if (type === 'string')
    {
        return { valid: true, value: text };
    }
    let value: unknown;
    try
    {
        value = JSON.parse(text);
    }
    catch
    {
        return { valid: false, error: '请输入有效的 JSON。' };
    }
    if (!hasLosslessJsonNumbers(text))
    {
        return { valid: false, error: 'JSON 数字超出可无损保存的范围。' };
    }
    const matches = type === 'array' ? Array.isArray(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : type === 'null' && value === null;
    return matches
        ? { valid: true, value }
        : { valid: false, error: 'JSON 值必须符合此字段声明的类型。' };
}

export function withPluginConfigValue(
    current: Readonly<Record<string, unknown>>,
    name: string,
    value: unknown
): Record<string, unknown>
{
    return { ...current, [name]: value };
}
