export interface PluginConfigEnumOption {
    readonly key: symbol;
    readonly value: unknown;
    readonly label: string;
}

export function isPluginConfigJsonValue(value: unknown, ancestors = new Set<object>()): boolean
{
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
    {
        return true;
    }
    if (typeof value === 'number')
    {
        return Number.isFinite(value);
    }
    if (typeof value !== 'object' || ancestors.has(value))
    {
        return false;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    {
        return false;
    }

    ancestors.add(value);
    try
    {
        return Object.values(value).every((child: unknown) => isPluginConfigJsonValue(child, ancestors));
    }
    finally
    {
        ancestors.delete(value);
    }
}

export function createPluginConfigEnumOptions(values: readonly unknown[]): readonly PluginConfigEnumOption[]
{
    return values.map((value) =>
    {
        if (!isPluginConfigJsonValue(value))
        {
            throw new TypeError('plugin_config_enum_value_not_json');
        }
        const label = JSON.stringify(value);
        if (label === undefined)
        {
            throw new TypeError('plugin_config_enum_value_not_json');
        }
        // The key identifies a DOM choice only; its original value is never replaced.
        return Object.freeze({ key: Symbol('plugin-config-enum-choice'), value, label });
    });
}

function equalJsonValues(left: unknown, right: unknown): boolean
{
    if (left === right)
    {
        return true;
    }
    if (Array.isArray(left))
    {
        return Array.isArray(right)
            && left.length === right.length
            && left.every((value: unknown, index: number) => equalJsonValues(value, right[index]));
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(right))
    {
        return false;
    }

    const leftEntries = Object.entries(left);
    const rightEntries = new Map<string, unknown>(Object.entries(right));
    return leftEntries.length === rightEntries.size
        && leftEntries.every(([key, value]) => rightEntries.has(key) && equalJsonValues(value, rightEntries.get(key)));
}

/** Compare decoded JSON values; object order is irrelevant and array order is retained. */
export function pluginConfigJsonValuesEqual(left: unknown, right: unknown): boolean
{
    return isPluginConfigJsonValue(left) && isPluginConfigJsonValue(right) && equalJsonValues(left, right);
}
