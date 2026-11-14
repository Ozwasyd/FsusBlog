export interface PluginConfigEnumChoice {
    key: string;
    label: string;
    value: unknown;
}

function isObject(value: unknown): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean
{
    if (left === right)
    {
        return true;
    }
    if (Array.isArray(left))
    {
        return Array.isArray(right) && left.length === right.length
            && left.every((value, index) => sameJsonValue(value, right[index]));
    }
    if (!isObject(left) || !isObject(right))
    {
        return false;
    }
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}

export function createPluginConfigEnumChoices(values: readonly unknown[]): readonly PluginConfigEnumChoice[]
{
    return values.map((value, index) =>
    {
        const label = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (label === undefined)
        {
            throw new TypeError('Plugin enum choices must contain JSON values');
        }
        return { key: String(index), label, value };
    });
}

export function findPluginConfigEnumChoice(
    choices: readonly PluginConfigEnumChoice[],
    value: unknown
): string | undefined
{
    return choices.find(choice => sameJsonValue(choice.value, value))?.key;
}

export function readPluginConfigEnumChoice(
    choices: readonly PluginConfigEnumChoice[],
    key: unknown
): { found: true; value: unknown; } | { found: false; }
{
    const choice = typeof key === 'string' ? choices.find(item => item.key === key) : undefined;
    return choice ? { found: true, value: choice.value } : { found: false };
}
