import { describe, expect, it } from 'vitest';

import { encodeJsonRequest } from '@/codecs/binary/jsonRequestEncoder';
import {
    createPluginConfigEnumChoices,
    findPluginConfigEnumChoice,
    readPluginConfigEnumChoice
} from '@/utils/pluginConfigEnum';

describe('plugin configuration enum presentation', () =>
{
    it('retains every value without conflating scalar types or object identities', () =>
    {
        const object = Object.freeze({ mode: 'fast', limit: 2 });
        const array = Object.freeze([1, 'x']);
        const values = Object.freeze([object, array, null, 1, '1', true]);
        const choices = createPluginConfigEnumChoices(values);

        expect(choices).toHaveLength(values.length);
        expect(choices.map(choice => choice.key)).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(choices[0]?.label).toBe('{"mode":"fast","limit":2}');
        expect(choices[1]?.label).toBe('[1,"x"]');
        expect(choices[0]?.value).toBe(object);
        expect(choices[1]?.value).toBe(array);
        expect(findPluginConfigEnumChoice(choices, { limit: 2, mode: 'fast' })).toBe('0');
        expect(findPluginConfigEnumChoice(choices, [1, 'x'])).toBe('1');
        expect(findPluginConfigEnumChoice(choices, null)).toBe('2');
        expect(findPluginConfigEnumChoice(choices, 1)).toBe('3');
        expect(findPluginConfigEnumChoice(choices, '1')).toBe('4');
        expect(findPluginConfigEnumChoice(choices, true)).toBe('5');
        expect(findPluginConfigEnumChoice(choices, ['x', 1])).toBeUndefined();
        expect(findPluginConfigEnumChoice(choices, { mode: 'fast' })).toBeUndefined();
    });

    it('distinguishes a selected null value from a missing or malformed UI key', () =>
    {
        const choices = createPluginConfigEnumChoices([null]);
        expect(readPluginConfigEnumChoice(choices, '0')).toEqual({ found: true, value: null });
        for (const key of [null, undefined, 0, 'missing', '__proto__'])
        {
            expect(readPluginConfigEnumChoice(choices, key)).toEqual({ found: false });
        }
        expect(createPluginConfigEnumChoices([])).toEqual([]);
    });

    it('passes the original selected JSON values through the existing request serializer', () =>
    {
        const values = [{ mode: 'safe', limit: 3 }, [2, 'y'], null, 2, 'safe', false];
        const choices = createPluginConfigEnumChoices(values);
        for (const [index, value] of values.entries())
        {
            const selected = readPluginConfigEnumChoice(choices, String(index));
            if (!selected.found)
            {
                throw new Error('A declared enum choice was dropped');
            }
            expect(selected.value).toBe(value);
            const request = { action: 'update-config', config: { setting: selected.value } };
            expect(new TextDecoder().decode(encodeJsonRequest(request)))
                .toBe(JSON.stringify({ action: 'update-config', config: { setting: value } }));
        }
    });
});
