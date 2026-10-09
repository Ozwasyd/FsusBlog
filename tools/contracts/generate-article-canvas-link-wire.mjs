import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/article-canvas-link-wire.json'), 'utf8'));
const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
const domain = readFileSync(path.join(root, 'src/shared/Contracts/Articles/ArticleCanvasLinkContracts.cs'), 'utf8');
const fail = (message) =>
{
    throw new Error(message);
};
const camel = (value) => value[0].toLowerCase() + value.slice(1);
const primitives = new Set(['guid', 'bool', 'int32', 'int64', 'string']);
for (const [name, value] of Object.entries({ SchemaVersion: 1, MaxHistoryDepth: 100, MaxPayloadBytes: 131072 }))
{
    if (!domain.includes(`public const int ${name} = ${value};`))
    {
        fail(`domain budget drift: ${name}`);
    }
}
if (schema.schemaVersion !== 1 || schema.maxPayloadBytes !== 131072
    || schema.byteOrder !== 'little-endian' || schema.guidByteOrder !== 'network'
    || schema.int64Presentation !== 'canonical-decimal-string'
    || JSON.stringify(schema.roots) !== JSON.stringify(['ArticleCanvasLinkRequest', 'ArticleCanvasLinkReceipt', 'ArticleCanvasLinkHistoryResponse'])
    || JSON.stringify(schema.enums) !== JSON.stringify({ ArticleCanvasLinkMode: [0, 1, 2] }))
{
    fail('article Canvas link schema owner drift');
}
for (const [name, record] of Object.entries(schema.records))
{
    const declaration = domain.match(new RegExp(`public sealed record ${name}\\(([\\s\\S]*?)\\);`));
    if (!declaration)
    {
        fail(`missing domain ${name}`);
    }
    const declarations = declaration[1].split(',').map((entry) => entry.trim().split(/\s+/));
    const fields = declarations.map((entry) => entry.at(-1));
    if (JSON.stringify(fields) !== JSON.stringify(record.fields.map((field) => field.name)))
    {
        fail(`domain field order drift: ${name}`);
    }
    for (const [index, field] of record.fields.entries())
    {
        const type = field.array ? `IReadOnlyList<${field.type}>`
            : ({ guid: 'Guid', bool: 'bool', int32: 'int', int64: 'long', string: 'string' }[field.type] ?? field.type);
        if (declarations[index].length !== 2 || declarations[index][0] !== type)
        {
            fail(`domain field type drift: ${name}.${field.name}`);
        }
        if (!primitives.has(field.type) && !schema.records[field.type] && !schema.enums[field.type])
        {
            fail(`unknown type ${field.type}`);
        }
        if (field.array && (field.type !== 'ArticleCanvasLinkReceipt' || field.maxCount !== 100))
        {
            fail('history array owner drift');
        }
        if (field.type === 'string' && field.maxChars !== 64)
        {
            fail('digest bound drift');
        }
    }
}
const mode = domain.match(/public enum ArticleCanvasLinkMode\s*\{([^}]+)\}/)?.[1];
if (!mode || JSON.stringify([...mode.matchAll(/=\s*(\d+)/g)].map((match) => Number(match[1]))) !== '[0,1,2]')
{
    fail('domain mode drift');
}
const frames = schema.roots.map((name) =>
{
    const frame = protocol.frameTypes.find((entry) => entry.name === name);
    if (!frame)
    {
        fail(`unregistered protocol root ${name}`);
    }
    return frame;
});
function minimum(name)
{
    return schema.records[name].fields.reduce((total, field) => total + (field.array ? 4 :
        ({ guid: 16, bool: 1, int32: 4, int64: 8, string: 4 }[field.type] ?? (schema.enums[field.type] ? 1 : minimum(field.type)))), 0);
}
const tsType = (field) => field.array ? `ReadonlyArray<${field.type}>` : ({ guid: 'string', bool: 'boolean', int32: 'number', int64: 'string', string: 'string' }[field.type] ?? field.type);
function scalar(field, language, value)
{
    const write = value !== undefined;
    const min = field.min ?? 0;
    const max = field.max ?? (field.type === 'int32' ? 2147483647 : '9223372036854775807');
    if (language === 'cs')
    {
        const call = write ? 'writer.Write' : 'reader.Read';
        const arg = write ? `${value}, ` : '';
        if (field.type === 'guid')
        {
            return `${call}Guid(${write ? value : ''})`;
        }
        if (field.type === 'bool')
        {
            return `${call}Boolean(${write ? value : ''})`;
        }
        if (field.type === 'string')
        {
            return `${call}String(${arg}64, ${field.digest === true})`;
        }
        if (field.type === 'int32')
        {
            return `${call}Int32(${arg}${min}, ${max})`;
        }
        if (field.type === 'int64')
        {
            return `${call}Int64(${arg}${min}L, ${max}L)`;
        }
        if (schema.enums[field.type])
        {
            return write ? `writer.WriteEnum((int)${value}, [0, 1, 2])` : `(${field.type})reader.ReadEnum([0, 1, 2])`;
        }
        return write ? `WriteLink${field.type}(${value}, writer)` : `ReadLink${field.type}(ref reader)`;
    }
    const call = write ? 'writer.' : 'reader.';
    const arg = write ? `${value}, ` : '';
    if (field.type === 'guid')
    {
        return `${call}guid(${write ? value : ''})`;
    }
    if (field.type === 'bool')
    {
        return `${call}boolean(${write ? value : ''})`;
    }
    if (field.type === 'string')
    {
        return `${call}text(${arg}64, ${field.digest === true})`;
    }
    if (field.type === 'int32')
    {
        return `${call}int32(${arg}${min}, ${max})`;
    }
    if (field.type === 'int64')
    {
        return `${call}int64(${arg}${min}n, ${max}n)`;
    }
    if (schema.enums[field.type])
    {
        return `${call}enumeration(${write ? `${value}, ` : ''}[0, 1, 2])${write ? '' : ` as ${field.type}`}`;
    }
    return write ? `write${field.type}(${value}, writer)` : `read${field.type}(reader)`;
}
const notice = '// <auto-generated by tools/contracts/generate-article-canvas-link-wire.mjs>\n';
let cs = notice + '#nullable enable\nusing System.Buffers;\nusing FsusBlog.Contracts.Articles;\nnamespace FsusBlog.Core.Cache;\npublic static partial class PodBinaryCodec\n{\n';
let ts = notice + "import { CanvasWireReader, CanvasWireWriter } from './authoringCanvasWire.generated';\nexport type ArticleCanvasLinkMode = 0 | 1 | 2;\n";
let cpp = notice + '#pragma once\n#include "authoring_canvas_wire.generated.hpp"\nnamespace FsusBlog::Aeds::ArticleCanvasLinkWire\n{\n';
for (const name of schema.roots)
{
    cpp += `inline bool Parse${name}(CanvasWire::Reader& reader);\n`;
}
for (const [name, record] of Object.entries(schema.records))
{
    cs += `    private static ${name} ReadLink${name}(ref CanvasWireReader reader)\n    {\n`;
    for (const [index, field] of record.fields.entries())
    {
        if (field.array)
        {
            cs += `        int count${index} = reader.ReadCount(100, ${minimum(field.type)}, false);\n        var field${index} = new ${field.type}[count${index}];\n        for (int index = 0; index < count${index}; index++) field${index}[index] = ReadLink${field.type}(ref reader);\n`;
        }
        else
        {
            cs += `        var field${index} = ${scalar(field, 'cs')};\n`;
        }
    }
    cs += `        return new ${name}(${record.fields.map((_, index) => `field${index}`).join(', ')});\n    }\n    private static void WriteLink${name}(${name} value, CanvasWireWriter writer)\n    {\n`;
    for (const field of record.fields)
    {
        const value = `value.${field.name}`;
        if (field.array)
        {
            cs += `        writer.WriteCount(${value}.Count, 100, false);\n        foreach (var item in ${value}) WriteLink${field.type}(item, writer);\n`;
        }
        else
        {
            cs += `        ${scalar(field, 'cs', value)};\n`;
        }
    }
    cs += '    }\n';
    ts += `export interface ${name}\n{\n${record.fields.map((field) => `    ${camel(field.name)}: ${tsType(field)};`).join('\n')}\n}\nfunction read${name}(reader: CanvasWireReader): ${name}\n{\n    return {\n`;
    ts += record.fields.map((field) => `        ${camel(field.name)}: ${field.array ? `reader.array(100, ${minimum(field.type)}, false, () => read${field.type}(reader))` : scalar(field, 'ts')}`).join(',\n') + '\n    };\n}\n';
    ts += `function write${name}(value: ${name}, writer: CanvasWireWriter): void\n{\n`;
    for (const field of record.fields)
    {
        const value = `value.${camel(field.name)}`;
        ts += `    ${field.array ? `writer.array(${value}, 100, false, (item) => write${field.type}(item, writer))` : scalar(field, 'ts', value)};\n`;
    }
    ts += '}\n';
    cpp += `inline bool Parse${name}(CanvasWire::Reader& reader)\n{\n`;
    for (const [index, field] of record.fields.entries())
    {
        if (field.array)
        {
            cpp += `    std::int32_t count${index}; if (!reader.Count(100, ${minimum(field.type)}, false, count${index})) return false;\n    for (std::int32_t index = 0; index < count${index}; ++index) if (!Parse${field.type}(reader)) return false;\n`;
        }
        else if (field.type === 'guid')
        {
            cpp += '    if (!reader.Skip(16)) return false;\n';
        }
        else if (field.type === 'bool')
        {
            cpp += `    bool field${index}; if (!reader.Boolean(field${index})) return false;\n`;
        }
        else if (field.type === 'string')
        {
            cpp += `    if (!reader.Text(64, ${field.digest === true})) return false;\n`;
        }
        else if (field.type === 'int32')
        {
            cpp += `    if (!reader.Int32(${field.min}, ${field.max ?? 2147483647})) return false;\n`;
        }
        else if (field.type === 'int64')
        {
            cpp += `    if (!reader.Int64(${field.min}, INT64_MAX)) return false;\n`;
        }
        else
        {
            cpp += `    if (!reader.Enum({0, 1, 2})) return false;\n`;
        }
    }
    cpp += '    return true;\n}\n';
}
for (const name of schema.roots)
{
    cs += `    public static byte[] Encode${name}(${name} value)\n    {\n        var writer = new CanvasWireWriter();\n        writer.WriteByte(1);\n        WriteLink${name}(value, writer);\n        var result = writer.ToArray();\n        if (result.Length > 131072) throw new ArgumentException("article_canvas_link_payload_budget");\n        return result;\n    }\n    public static void Write${name}(${name} value, IBufferWriter<byte> writer) => writer.Write(Encode${name}(value));\n    public static bool TryDecode${name}(ReadOnlyMemory<byte> source, out ${name} value)\n    {\n        value = default!;\n        if (source.Length is < 1 or > 131072) return false;\n        try\n        {\n            var reader = new CanvasWireReader(source.Span);\n            if (reader.ReadByte() != 1) return false;\n            var decoded = ReadLink${name}(ref reader);\n            if (!reader.IsConsumed) return false;\n            value = decoded;\n            return true;\n        }\n        catch (Exception error) when (error is ArgumentException or FormatException or OverflowException) { return false; }\n    }\n`;
    ts += `export function encode${name}(value: ${name}): Uint8Array\n{\n    const writer = new CanvasWireWriter();\n    writer.byte(1);\n    write${name}(value, writer);\n    const result = writer.finish();\n    if (result.byteLength > 131072) throw new RangeError('article_canvas_link_payload_budget');\n    return result;\n}\nexport function decode${name}(source: Uint8Array): ${name}\n{\n    if (source.byteLength < 1 || source.byteLength > 131072) throw new RangeError('article_canvas_link_payload_budget');\n    const reader = new CanvasWireReader(source);\n    if (reader.byte() !== 1) throw new RangeError('article_canvas_link_version');\n    const value = read${name}(reader);\n    reader.finish();\n    return value;\n}\n`;
}
cs += '}\n';
cpp += '}\nnamespace FsusBlog::Aeds\n{\ninline bool ValidateArticleCanvasLinkPayload(std::uint16_t frameType, const std::uint8_t* payload, std::size_t length)\n{\n    if (payload == nullptr || length < 1 || length > 131072) return false;\n    CanvasWire::Reader reader(payload, length);\n    std::uint8_t version; if (!reader.Byte(version) || version != 1) return false;\n    bool valid;\n    switch (frameType)\n    {\n' + frames.map((frame) => `        case ${frame.value}: valid = ArticleCanvasLinkWire::Parse${frame.name}(reader); break;`).join('\n') + '\n        default: return false;\n    }\n    return valid && reader.Consumed();\n}\n}\n';
for (const [relative, content] of [
    ['src/core/Cache/PodBinaryCodec.ArticleCanvasLink.Generated.cs', cs],
    ['src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts', ts],
    ['src/frontend/wasm/aeds/include/article_canvas_link_wire.generated.hpp', cpp]
])
{
    const target = path.join(root, relative);
    if (process.argv.includes('--check'))
    {
        if (readFileSync(target, 'utf8') !== content)
        {
            fail(`stale ${relative}`);
        }
    }
    else
    {
        writeFileSync(target, content);
    }
}
console.log(`[article-canvas-link-wire] ${process.argv.includes('--check') ? 'checked' : 'generated'} 3 closed roots using shared Canvas scalar substrate`);
