import { isPluginConfigJsonValue } from './pluginConfigEnum';

export interface PluginConfigWidgetField {
    readonly type: string;
    readonly minimum?: number;
    readonly maximum?: number;
}

export type PluginConfigWidgetModel =
    | { readonly kind: 'boolean'; readonly value: boolean | undefined; }
    | { readonly kind: 'number'; readonly value: number | undefined; }
    | { readonly kind: 'text'; readonly value: string | undefined; }
    | { readonly kind: 'json'; readonly error: string | null; };

export function isPluginConfigObject(value: unknown): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only mount scalar controls for their real model values, never for a coerced projection. */
export function getPluginConfigWidgetModel(
    field: PluginConfigWidgetField,
    value: unknown,
    present: boolean
): PluginConfigWidgetModel
{
    if (field.type === 'boolean' && (!present || typeof value === 'boolean'))
    {
        return { kind: 'boolean', value: typeof value === 'boolean' ? value : undefined };
    }
    if (field.type === 'string' && (!present || typeof value === 'string'))
    {
        return { kind: 'text', value: typeof value === 'string' ? value : undefined };
    }
    if (field.type === 'number' || field.type === 'integer')
    {
        const boundsValid = field.minimum === undefined || field.maximum === undefined
            || field.minimum <= field.maximum;
        if (boundsValid && !present)
        {
            return { kind: 'number', value: undefined };
        }
        if (boundsValid && typeof value === 'number' && Number.isFinite(value)
            && (field.type !== 'integer' || Number.isInteger(value))
            && (field.minimum === undefined || value >= field.minimum)
            && (field.maximum === undefined || value <= field.maximum))
        {
            return { kind: 'number', value };
        }
    }
    const structuredValueMatches = field.type === 'object' && isPluginConfigObject(value)
        || field.type === 'array' && Array.isArray(value)
        || field.type === 'null' && value === null;
    return {
        kind: 'json',
        error: !present || structuredValueMatches ? null
            : `当前值与 ${field.type} 类型或控件范围不匹配；原值已保留，请显式编辑 JSON。`
    };
}

/** A missing/unsupported value has no invented JSON initial value. */
export function pluginConfigJsonText(value: unknown): string | null
{
    if (!isPluginConfigJsonValue(value))
    {
        return null;
    }
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : null;
}

export function parsePluginConfigJson(text: string): unknown
{
    const value: unknown = JSON.parse(text, (_key: string, item: unknown): unknown =>
    {
        if (typeof item === 'number' && (!Number.isFinite(item)
            || Number.isInteger(item) && !Number.isSafeInteger(item)))
        {
            throw new RangeError('JSON 数值超出此编辑器可安全表示的范围');
        }
        return item;
    });
    if (!isPluginConfigJsonValue(value))
    {
        throw new TypeError('请输入有限 JSON 值');
    }
    return value;
}
