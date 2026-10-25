import { describe, expect, it } from 'vitest';

import { encodeJsonRequest } from '@/codecs/binary/jsonRequestEncoder';
import {
    formatPluginConfigText,
    parsePluginConfigText,
    readPluginConfigBoolean,
    readPluginConfigNumber,
    readPluginConfigProperties,
    readPluginConfigValue,
    withPluginConfigValue
} from '@/utils/pluginConfigValue';

describe('plugin configuration value adapters', () =>
{
    it('accepts complete property metadata without filtering malformed entries', () =>
    {
        const properties = { object: { type: 'object', enum: [{ mode: 'safe' }] }, array: { type: 'array' } };
        expect(readPluginConfigProperties(properties)).toBe(properties);
        for (const value of [null, false, [], { valid: { type: 'string' }, invalid: null }, { invalid: [] }])
        {
            expect(readPluginConfigProperties(value)).toBeUndefined();
        }
    });

    it('narrows primitive widget values without coercing unrelated values', () =>
    {
        expect(readPluginConfigBoolean(true)).toBe(true);
        expect(readPluginConfigBoolean(false)).toBe(false);
        expect(readPluginConfigBoolean('false')).toBeUndefined();
        expect(readPluginConfigBoolean({ enabled: true })).toBeUndefined();
        expect(readPluginConfigNumber(0)).toBe(0);
        expect(readPluginConfigNumber(2026)).toBe(2026);
        expect(readPluginConfigNumber(null)).toBeNull();
        expect(readPluginConfigNumber('2026')).toBeUndefined();
        expect(readPluginConfigNumber([])).toBeUndefined();
    });

    it('round trips complete object, array and null JSON values', () =>
    {
        const cases = [
            { type: 'object', value: { nested: { keep: true }, values: [null, 0, false, ''] } },
            { type: 'array', value: [1, { keep: true }, null] },
            { type: 'null', value: null }
        ];
        for (const { type, value } of cases)
        {
            const text = formatPluginConfigText(type, value);
            const result = parsePluginConfigText(type, text);
            expect(result).toEqual({ valid: true, value });
            expect(new TextDecoder().decode(encodeJsonRequest({ setting: value })))
                .toBe(`{"setting":${text}}`);
        }
        expect(formatPluginConfigText('string', 'plain text')).toBe('plain text');
        expect(formatPluginConfigText('string', undefined)).toBe('');
        expect(parsePluginConfigText('string', '')).toEqual({ valid: true, value: '' });
    });

    it('rejects incomplete or wrong-kind JSON while preserving the previous complete draft', () =>
    {
        const previous = Object.freeze({ setting: Object.freeze({ keep: true }), other: [1, 2] });
        for (const [type, text] of [
            ['object', '{'], ['object', '[1,2]'], ['array', '{}'], ['null', 'false']
        ] as const)
        {
            expect(parsePluginConfigText(type, text).valid).toBe(false);
            expect(previous.setting).toEqual({ keep: true });
            expect(previous.other).toEqual([1, 2]);
        }
    });

    it('rejects nested numeric overflow, underflow and rounding instead of changing saved JSON', () =>
    {
        for (const [type, text] of [
            ['object', '{"nested":{"number":1e999}}'],
            ['array', '[1,{"number":1e999}]'],
            ['object', '{"number":1e-999}'],
            ['object', '{"number":9007199254740993}'],
            ['array', '[0.100000000000000005]']
        ] as const)
        {
            expect(parsePluginConfigText(type, text)).toEqual({
                valid: false,
                error: 'JSON 数字超出可无损保存的范围。'
            });
        }
    });

    it('accepts equivalent decimal notation and large numbers that preserve the original numeric value', () =>
    {
        const text = String.raw`{"large":1e20,"safe":9007199254740991,"decimal":0.1,"equivalent":1.2300e+2,"zero":-0,"text":"9007199254740993 and \"1e999\""}`;
        const result = parsePluginConfigText('object', text);
        expect(result).toEqual({ valid: true, value: JSON.parse(text) });
        if (!result.valid)
        {
            throw new Error('Representable JSON numbers were rejected');
        }
        expect(new TextDecoder().decode(encodeJsonRequest(result.value)))
            .toBe(String.raw`{"large":100000000000000000000,"safe":9007199254740991,"decimal":0.1,"equivalent":123,"zero":0,"text":"9007199254740993 and \"1e999\""}`);
        expect(parsePluginConfigText('string', '9007199254740993')).toEqual({
            valid: true, value: '9007199254740993'
        });
    });

    it('retains all other values and stores a prototype-shaped field as an own data property', () =>
    {
        const object = Object.freeze({ keep: true });
        const original = Object.freeze({ object, array: [1, null], nil: null, flag: false });
        const updated = withPluginConfigValue(original, '__proto__', { prototypeField: true });
        expect(Object.hasOwn(updated, '__proto__')).toBe(true);
        expect(updated['__proto__']).toEqual({ prototypeField: true });
        expect(Object.getPrototypeOf(updated)).toBe(Object.prototype);
        expect(updated['object']).toBe(object);
        expect(updated['array']).toBe(original.array);
        expect(updated['nil']).toBeNull();
        expect(updated['flag']).toBe(false);
        expect(Object.hasOwn(original, '__proto__')).toBe(false);
        expect(readPluginConfigValue(original, '__proto__')).toBeUndefined();
        expect(readPluginConfigValue(original, 'toString')).toBeUndefined();
        expect(readPluginConfigValue(updated, '__proto__')).toEqual({ prototypeField: true });
    });
});
