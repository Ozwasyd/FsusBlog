import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/authoring-canvas-wire.json'), 'utf8'));
const primitive = new Set(['string', 'int32', 'int64', 'timestamp', 'guid', 'double', 'bool']);
const valueTypes = new Set(['int32', 'int64', 'timestamp', 'guid', 'double', 'bool', 'AuthoringCanvasOwner', 'AuthoringCanvasViewport', 'AuthoringCanvasGeometry', 'AuthoringCanvasPageCursor', 'AuthoringCanvasReferenceAuthorityCoordinate', ...Object.keys(schema.enums)]);
const camel = (value) => value[0].toLowerCase() + value.slice(1);
const fail = (message) =>
{
    throw new Error(message);
};
const identifier = /^[A-Za-z][A-Za-z0-9]*$/;
if (schema.schemaVersion !== 1 || schema.maxPayloadBytes !== 8388608 || schema.maxAggregateFacts !== 40002 || schema.byteOrder !== 'little-endian' || schema.guidByteOrder !== 'network' || schema.stringLengthUnit !== 'utf16-code-units' || schema.timestampUnit !== 'unix-milliseconds')
{
    fail('unsupported Canvas wire ABI');
}
for (const [name, values] of Object.entries(schema.enums))
{
    if (!identifier.test(name) || !Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    {
        fail(`invalid enum ${name}`);
    }
}
for (const [name, record] of Object.entries(schema.records))
{
    if (!identifier.test(name) || !Array.isArray(record.fields) || new Set(record.fields.map((field) => field.name)).size !== record.fields.length)
    {
        fail(`invalid record ${name}`);
    }
    for (const field of record.fields)
    {
        if (!identifier.test(field.name) || (!primitive.has(field.type) && !schema.enums[field.type] && !schema.records[field.type]))
        {
            fail(`invalid field ${name}.${field.name}`);
        }
        if (field.type === 'string' && (!Number.isInteger(field.maxChars) || field.maxChars < 1 || field.maxChars > 8192))
        {
            fail('invalid string bound');
        }
        if (field.array && (!Number.isInteger(field.maxCount) || field.maxCount < 1 || field.maxCount > 20001))
        {
            fail('invalid array bound');
        }
        if (field.facts && (!field.array || field.type !== 'AuthoringCanvasOperationFact'))
        {
            fail('invalid aggregate facts owner');
        }
        if (field.allowed && (!schema.enums[field.type] || field.allowed.some((value) => !schema.enums[field.type].includes(value))))
        {
            fail('invalid closed enum subset');
        }
        for (const limit of ['min', 'max'])
        {
            if (field[limit] !== undefined && !Number.isFinite(field[limit]))
            {
                fail('invalid numeric bound');
            }
        }
    }
}
if (schema.roots.length !== 13 || schema.roots.some((entry, index) => entry.frameType !== 253 + index || !schema.records[entry.type]))
{
    fail('invalid Canvas frame roster');
}
if (schema.preparation?.rootType !== 'AuthoringCanvasApplyRequest' || schema.preparation.frameType !== 258 || schema.preparation.responseRole !== 'prepared-intention' || schema.preparation.operationReceipt !== false || JSON.stringify(schema.preparation.mutableReferenceFields) !== JSON.stringify(['DisplayProjectionReference', 'ReferenceState']))
{
    fail('invalid preparation role');
}

function domainConstantResolver(domainFiles)
{
    const constants = new Map();
    for (let index = 0; index < 3; index++)
    {
        const owner = ['AuthoringCanvasContract', 'AuthoringCanvasOperationContract', 'AuthoringCanvasReferenceContract'][index];
        for (const match of domainFiles[index].matchAll(/public const (?:int|double) ([A-Za-z][A-Za-z0-9]*)\s*=\s*([^;]+);/g))
        {
            constants.set(`${owner}.${match[1]}`, match[2].trim());
        }
    }
    function constantValue(expression, pending = new Set())
    {
        const text = expression.replaceAll('_', '').trim();
        if (/^-?\d+(?:\.\d+)?$/.test(text))
        {
            return Number(text);
        }
        if (text.startsWith('-'))
        {
            return -constantValue(text.slice(1), pending);
        }
        if (text.includes('+'))
        {
            return text.split('+').reduce((sum, term) => sum + constantValue(term, pending), 0);
        }
        if (!constants.has(text) || pending.has(text))
        {
            fail(`unsupported domain constant: ${text}`);
        }
        return constantValue(constants.get(text), new Set(pending).add(text));
    }
    return constantValue;
}

// Wire layout is owned here; frame identities and existing domain constraints retain
// their original owners. Refuse drift instead of silently generating another ABI.
export function validateCanvasWireOwners(candidateSchema, protocol, domainFiles)
{
    const schema = candidateSchema;
    for (const entry of schema.roots)
    {
        if (!protocol.frameTypes.some((frame) => frame.name === entry.type && frame.value === entry.frameType))
        {
            fail(`protocol frame drift: ${entry.type}`);
        }
    }
    const domainSource = domainFiles.join('\n');
    for (const [name, values] of Object.entries(schema.enums))
    {
        const declaration = domainSource.match(new RegExp(`public enum ${name}\\s*\\{([^}]+)\\}`));
        if (!declaration)
        {
            fail(`domain enum missing: ${name}`);
        }
        const entries = declaration[1].split(',').map((entry) => entry.trim()).filter(Boolean);
        const actual = entries.map((entry) =>
        {
            const match = entry.match(/^[A-Za-z][A-Za-z0-9]*\s*=\s*(\d+)$/);
            if (!match)
            {
                fail(`unsupported domain enum declaration: ${name}`);
            }
            return Number(match[1]);
        });
        if (JSON.stringify(actual) !== JSON.stringify(values))
        {
            fail(`domain enum drift: ${name}`);
        }
    }
    const domainTypes = { string: 'string', int32: 'int', int64: 'long', timestamp: 'DateTime', guid: 'Guid', double: 'double', bool: 'bool' };
    for (const [name, record] of Object.entries(schema.records))
    {
        const declaration = domainSource.match(new RegExp(`public (?:sealed |readonly )?record(?: struct)? ${name}\\s*\\(([\\s\\S]*?)\\)(?:;|\\s*\\{)`));
        if (!declaration)
        {
            fail(`domain record missing: ${name}`);
        }
        const parameters = declaration[1].split(',').map((entry) => entry.trim());
        const wireParameters = record.fields.filter((field) => !field.init);
        const actual = parameters.map((entry) =>
        {
            const match = entry.match(/^([A-Za-z][A-Za-z0-9<>?]*)\s+([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*(?:null|""|[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*))?$/);
            if (!match)
            {
                fail(`unsupported domain record parameter: ${name}: ${entry}`);
            }
            return { type: match[1], name: match[2] };
        });
        // Operation facts are sealed by the authenticated server after typed ingress.
        // This sole omission is an explicit transport boundary, not a generic escape.
        const expected = actual.filter((field) => !(name === 'AuthoringCanvasOperationFact' && field.name === 'ContentDigest'));
        if (expected.length !== wireParameters.length)
        {
            fail(`domain field roster drift: ${name}`);
        }
        for (let index = 0; index < expected.length; index++)
        {
            const field = wireParameters[index];
            const type = domainTypes[field.type] ?? field.type;
            let actualType = (field.array ? `IReadOnlyList<${type}>` : type) + (field.nullable ? '?' : '');
            if (name === 'AuthoringCanvasNode' && field.name === 'Members')
            {
                actualType += '?';
            }
            if (field.name !== expected[index].name || actualType !== expected[index].type)
            {
                fail(`domain field drift: ${name}.${field.name}`);
            }
        }
        for (const field of record.fields.filter((entry) => entry.init))
        {
            if (name !== 'AuthoringCanvasReferenceProjection' || field.name !== 'DisplayProjectionReference' || !/public string\? DisplayProjectionReference\s*\{\s*get;\s*init;\s*\}/.test(domainSource))
            {
                fail('unsupported domain init field');
            }
        }
    }
    const constantValue = domainConstantResolver(domainFiles);
    for (const [name, source] of Object.entries(schema.clientLimits))
    {
        if (!identifier.test(name) || typeof source !== 'string'
            || !/^AuthoringCanvas(?:Contract|OperationContract|ReferenceContract)\.[A-Za-z][A-Za-z0-9]*$/.test(source))
        {
            fail('invalid client limit owner');
        }
        constantValue(source);
    }
    if (schema.maxAggregateFacts !== constantValue(schema.aggregateFactsPerSideSource) * 2)
    {
        fail('domain aggregate facts drift');
    }
    for (const [name, record] of Object.entries(schema.records))
    {
        for (const field of record.fields)
        {
            for (const [limit, owner] of Object.entries(field.boundsSource ?? {}))
            {
                if (!['min', 'max', 'maxChars', 'maxCount'].includes(limit) || field[limit] !== constantValue(owner))
                {
                    fail(`domain budget drift: ${name}.${field.name}.${limit}`);
                }
            }
        }
    }
}

const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
const domainFiles = ['Document', 'Operation', 'Reference', 'Transport'].map((domain) => readFileSync(path.join(root, `src/shared/Contracts/AuthoringCanvas/AuthoringCanvas${domain}Contracts.cs`), 'utf8'));
validateCanvasWireOwners(schema, protocol, domainFiles);

function minimum(field, stack = new Set())
{
    if (field.nullable)
    {
        return 1;
    }
    if (field.array || field.type === 'string')
    {
        return 4;
    }
    if (schema.enums[field.type] || field.type === 'bool')
    {
        return 1;
    }
    if (field.type === 'guid')
    {
        return 16;
    }
    if (field.type === 'int32')
    {
        return 4;
    }
    if (primitive.has(field.type))
    {
        return 8;
    }
    if (stack.has(field.type))
    {
        fail('recursive Canvas wire record');
    }
    const next = new Set(stack).add(field.type);
    return schema.records[field.type].fields.reduce((sum, item) => sum + minimum(item, next), 0);
}
const elementMinimum = (field) => minimum({ ...field, array: false, nullable: false });
const csType = (field) => ({ string: 'string', int32: 'int', int64: 'long', timestamp: 'DateTime', guid: 'Guid', double: 'double', bool: 'bool' }[field.type] ?? field.type) + (field.nullable ? '?' : '');
const range = (field, low, high, suffix = '') => `${field.min ?? low}${suffix}, ${field.max ?? high}${suffix}`;
const enumValues = (field) => field.allowed ?? schema.enums[field.type];

function csRead(field)
{
    let expression;
    if (field.array)
    {
        expression = `Read${field.type}Array${field.maxCount}${field.facts ? 'Facts' : ''}${field.type === 'string' ? `Chars${field.maxChars}` : ''}(ref reader)`;
    }
    else if (field.type === 'string')
    {
        expression = `reader.ReadString(${field.maxChars}, ${field.digest === true})`;
    }
    else if (field.type === 'int32')
    {
        expression = `reader.ReadInt32(${range(field, '-2147483648', '2147483647')})`;
    }
    else if (field.type === 'int64')
    {
        expression = `reader.ReadInt64(${range(field, '-9223372036854775808', '9223372036854775807', 'L')})`;
    }
    else if (field.type === 'timestamp')
    {
        expression = 'PodTimeCodec.FromUnixMs(reader.ReadInt64(-62135596800000L, 253402300799999L))';
    }
    else if (field.type === 'double')
    {
        expression = `reader.ReadDouble(${range(field, '-1.7976931348623157E+308', '1.7976931348623157E+308')})`;
    }
    else if (field.type === 'guid')
    {
        expression = 'reader.ReadGuid()';
    }
    else if (field.type === 'bool')
    {
        expression = 'reader.ReadBoolean()';
    }
    else if (schema.enums[field.type])
    {
        expression = `(${field.type})reader.ReadEnum([${enumValues(field).join(', ')}])`;
    }
    else
    {
        expression = `Read${field.type}(ref reader)`;
    }
    return field.nullable ? `(reader.ReadBoolean() ? (${csType(field)})${expression} : null)` : expression;
}

function csWrite(field, expression, indentation = '        ')
{
    let value = expression;
    const lines = [];
    if (field.nullable)
    {
        lines.push(`${indentation}writer.WriteBoolean(${expression} is not null);`, `${indentation}if (${expression} is not null)`, `${indentation}{`);
        indentation += '    ';
        value = `${expression}${valueTypes.has(field.type) ? '.Value' : ''}`;
    }
    if (field.array)
    {
        lines.push(`${indentation}ArgumentNullException.ThrowIfNull(${value});`, `${indentation}writer.WriteCount(${value}.Count, ${field.maxCount}, ${field.facts === true});`, `${indentation}foreach (var item in ${value})`, `${indentation}{`, csWrite({ ...field, array: false, nullable: false }, 'item', indentation + '    '), `${indentation}}`);
    }
    else if (field.type === 'string')
    {
        lines.push(`${indentation}writer.WriteString(${value}, ${field.maxChars}, ${field.digest === true});`);
    }
    else if (field.type === 'int32')
    {
        lines.push(`${indentation}writer.WriteInt32(${value}, ${range(field, '-2147483648', '2147483647')});`);
    }
    else if (field.type === 'int64')
    {
        lines.push(`${indentation}writer.WriteInt64(${value}, ${range(field, '-9223372036854775808', '9223372036854775807', 'L')});`);
    }
    else if (field.type === 'timestamp')
    {
        lines.push(`${indentation}writer.WriteInt64(PodTimeCodec.ToUnixMs(${value}), -62135596800000L, 253402300799999L);`);
    }
    else if (field.type === 'double')
    {
        lines.push(`${indentation}writer.WriteDouble(${value}, ${range(field, '-1.7976931348623157E+308', '1.7976931348623157E+308')});`);
    }
    else if (field.type === 'guid')
    {
        lines.push(`${indentation}writer.WriteGuid(${value});`);
    }
    else if (field.type === 'bool')
    {
        lines.push(`${indentation}writer.WriteBoolean(${value});`);
    }
    else if (schema.enums[field.type])
    {
        lines.push(`${indentation}writer.WriteEnum((int)${value}, [${enumValues(field).join(', ')}]);`);
    }
    else
    {
        lines.push(`${indentation}Write${field.type}Value(${value}, writer);`);
    }
    if (field.nullable)
    {
        lines.push(`${indentation.slice(0, -4)}}`);
    }
    return lines.join('\n');
}

let csharp = `// <auto-generated by tools/contracts/generate-authoring-canvas-wire.mjs>\n#nullable enable\nusing System.Buffers;\nusing System.Buffers.Binary;\nusing System.Text;\n\nusing FsusBlog.Core.Mapping.Codecs;\nusing FsusBlog.Shared.Contracts.AuthoringCanvas;\n\nnamespace FsusBlog.Core.Cache;\n\npublic static partial class PodBinaryCodec\n{\n    private static readonly UTF8Encoding s_canvasWireUtf8 = new(false, true);\n\n`;
for (const { type } of schema.roots)
{
    csharp += `    public static byte[] Encode${type}(${type} value)\n    {\n        var writer = new CanvasWireWriter();\n        writer.WriteByte(1);\n        Write${type}Value(value, writer);\n        return writer.ToArray();\n    }\n\n    public static void Write${type}(${type} value, IBufferWriter<byte> destination)\n        => destination.Write(Encode${type}(value));\n\n    public static bool TryDecode${type}(ReadOnlyMemory<byte> source, out ${type} value)\n    {\n        value = default!;\n        if (source.Length is < 1 or > ${schema.maxPayloadBytes}) return false;\n        try\n        {\n            var reader = new CanvasWireReader(source.Span);\n            if (reader.ReadByte() != 1) return false;\n            var decoded = Read${type}(ref reader);\n            if (!reader.IsConsumed) return false;\n            value = decoded;\n            return true;\n        }\n        catch (Exception error) when (error is ArgumentException or FormatException or OverflowException)\n        {\n            return false;\n        }\n    }\n\n`;
}
const csArrays = new Map();
for (const [name, record] of Object.entries(schema.records))
{
    const fields = record.fields;
    csharp += `    private static ${name} Read${name}(ref CanvasWireReader reader)\n    {\n`;
    fields.forEach((field, index) =>
    {
        csharp += `        var field${index} = ${csRead(field)};\n`;
        if (field.array)
        {
            csArrays.set(csRead(field), field);
        }
    });
    csharp += `        return new ${name}(${fields.map((field, index) => !field.init ? `field${index}` : null).filter(Boolean).join(', ')})`;
    if (fields.some((field) => field.init))
    {
        csharp += ` { ${fields.map((field, index) => field.init ? `${field.name} = field${index}` : null).filter(Boolean).join(', ')} }`;
    }
    csharp += `;\n    }\n\n    private static void Write${name}Value(${name} value, CanvasWireWriter writer)\n    {\n`;
    if (!valueTypes.has(name))
    {
        csharp += '        ArgumentNullException.ThrowIfNull(value);\n';
    }
    csharp += fields.map((field) => csWrite(field, `value.${field.sourceProperty ?? field.name}`)).join('\n') + '\n    }\n\n';
}
for (const [expression, field] of csArrays)
{
    const method = expression.replace('(ref reader)', '');
    const element = { ...field, array: false, nullable: false };
    csharp += `    private static IReadOnlyList<${csType(element)}> ${method}(ref CanvasWireReader reader)\n    {\n        int count = reader.ReadCount(${field.maxCount}, ${elementMinimum(field)}, ${field.facts === true});\n        var items = new ${csType(element)}[count];\n        for (int index = 0; index < count; index++) items[index] = ${csRead(element)};\n        return items;\n    }\n\n`;
}
csharp += `    private ref struct CanvasWireReader\n    {\n        private readonly ReadOnlySpan<byte> _source;\n        private int _offset;\n        private int _facts;\n        public CanvasWireReader(ReadOnlySpan<byte> source) { _source = source; _offset = 0; _facts = 0; }\n        public bool IsConsumed => _offset == _source.Length;\n        private ReadOnlySpan<byte> Take(int length)\n        {\n            if (length < 0 || length > _source.Length - _offset) throw new FormatException("canvas_wire_truncated");\n            var bytes = _source.Slice(_offset, length);\n            _offset += length;\n            return bytes;\n        }\n        public byte ReadByte() => Take(1)[0];\n        public bool ReadBoolean()\n        {\n            byte value = ReadByte();\n            if (value > 1) throw new FormatException("canvas_wire_boolean");\n            return value == 1;\n        }\n        public byte ReadEnum(ReadOnlySpan<byte> allowed)\n        {\n            byte value = ReadByte();\n            if (!allowed.Contains(value)) throw new FormatException("canvas_wire_enum");\n            return value;\n        }\n        public int ReadInt32(int min, int max)\n        {\n            int value = BinaryPrimitives.ReadInt32LittleEndian(Take(4));\n            if (value < min || value > max) throw new FormatException("canvas_wire_int32");\n            return value;\n        }\n        public long ReadInt64(long min, long max)\n        {\n            long value = BinaryPrimitives.ReadInt64LittleEndian(Take(8));\n            if (value < min || value > max) throw new FormatException("canvas_wire_int64");\n            return value;\n        }\n        public double ReadDouble(double min, double max)\n        {\n            double value = BinaryPrimitives.ReadDoubleLittleEndian(Take(8));\n            if (!double.IsFinite(value) || value < min || value > max) throw new FormatException("canvas_wire_double");\n            return value;\n        }\n        public Guid ReadGuid() => new(Take(16), bigEndian: true);\n        public string ReadString(int maxChars, bool digest)\n        {\n            int length = ReadInt32(0, maxChars * 4);\n            string value = s_canvasWireUtf8.GetString(Take(length));\n            if (value.Length > maxChars || (digest && !IsCanvasWireDigest(value))) throw new FormatException("canvas_wire_string");\n            return value;\n        }\n        public int ReadCount(int maxCount, int minimumBytes, bool facts)\n        {\n            int count = ReadInt32(0, maxCount);\n            if (count > (_source.Length - _offset) / minimumBytes) throw new FormatException("canvas_wire_count");\n            if (facts)\n            {\n                if (count > ${schema.maxAggregateFacts} - _facts) throw new FormatException("canvas_wire_facts_budget");\n                _facts += count;\n            }\n            return count;\n        }\n    }\n\n    private sealed class CanvasWireWriter\n    {\n        private readonly ArrayBufferWriter<byte> _buffer = new();\n        private int _facts;\n        private Span<byte> Reserve(int length)\n        {\n            if (length < 0 || length > ${schema.maxPayloadBytes} - _buffer.WrittenCount) throw new ArgumentException("canvas_wire_payload_budget");\n            return _buffer.GetSpan(length)[..length];\n        }\n        public byte[] ToArray() => _buffer.WrittenSpan.ToArray();\n        public void WriteByte(byte value) { Reserve(1)[0] = value; _buffer.Advance(1); }\n        public void WriteBoolean(bool value) => WriteByte(value ? (byte)1 : (byte)0);\n        public void WriteEnum(int value, ReadOnlySpan<byte> allowed)\n        {\n            if (value is < 0 or > 255 || !allowed.Contains((byte)value)) throw new ArgumentException("canvas_wire_enum");\n            WriteByte((byte)value);\n        }\n        public void WriteInt32(int value, int min, int max)\n        {\n            if (value < min || value > max) throw new ArgumentException("canvas_wire_int32");\n            BinaryPrimitives.WriteInt32LittleEndian(Reserve(4), value); _buffer.Advance(4);\n        }\n        public void WriteInt64(long value, long min, long max)\n        {\n            if (value < min || value > max) throw new ArgumentException("canvas_wire_int64");\n            BinaryPrimitives.WriteInt64LittleEndian(Reserve(8), value); _buffer.Advance(8);\n        }\n        public void WriteDouble(double value, double min, double max)\n        {\n            if (!double.IsFinite(value) || value < min || value > max) throw new ArgumentException("canvas_wire_double");\n            BinaryPrimitives.WriteDoubleLittleEndian(Reserve(8), value); _buffer.Advance(8);\n        }\n        public void WriteGuid(Guid value)\n        {\n            if (!value.TryWriteBytes(Reserve(16), bigEndian: true, out int written) || written != 16) throw new ArgumentException("canvas_wire_guid");\n            _buffer.Advance(16);\n        }\n        public void WriteString(string value, int maxChars, bool digest)\n        {\n            ArgumentNullException.ThrowIfNull(value);\n            if (value.Length > maxChars || (digest && !IsCanvasWireDigest(value))) throw new ArgumentException("canvas_wire_string");\n            int length = s_canvasWireUtf8.GetByteCount(value);\n            WriteInt32(length, 0, maxChars * 4);\n            if (length != 0) { s_canvasWireUtf8.GetBytes(value, Reserve(length)); _buffer.Advance(length); }\n        }\n        public void WriteCount(int count, int maxCount, bool facts)\n        {\n            if (facts)\n            {\n                if (count < 0 || count > ${schema.maxAggregateFacts} - _facts) throw new ArgumentException("canvas_wire_facts_budget");\n                _facts += count;\n            }\n            WriteInt32(count, 0, maxCount);\n        }\n    }\n\n    private static bool IsCanvasWireDigest(string value)\n    {\n        if (value.Length != 64) return false;\n        foreach (char character in value) if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')) return false;\n        return true;\n    }\n}\n`;

const tsType = (field) => (field.array ? `ReadonlyArray<${tsType({ ...field, array: false, nullable: false })}>` : ({ string: 'string', int32: 'number', int64: 'string', timestamp: 'string', guid: 'string', double: 'number', bool: 'boolean' }[field.type] ?? field.type)) + (field.nullable ? ' | null' : '');
const tsLimits = (field, kind) => kind === 'int64' ? `${field.min ?? '-9223372036854775808'}n, ${field.max ?? '9223372036854775807'}n` : range(field, kind === 'int32' ? '-2147483648' : '-Number.MAX_VALUE', kind === 'int32' ? '2147483647' : 'Number.MAX_VALUE');
function tsRead(field)
{
    let expression;
    if (field.array)
    {
        expression = `reader.array(${field.maxCount}, ${elementMinimum(field)}, ${field.facts === true}, () => ${tsRead({ ...field, array: false, nullable: false })})`;
    }
    else if (field.type === 'string')
    {
        expression = `reader.text(${field.maxChars}, ${field.digest === true})`;
    }
    else if (field.type === 'timestamp')
    {
        expression = 'reader.int64(-62135596800000n, 253402300799999n)';
    }
    else if (field.type === 'int64')
    {
        expression = `reader.int64(${tsLimits(field, 'int64')})`;
    }
    else if (field.type === 'int32' || field.type === 'double')
    {
        expression = `reader.${field.type}(${tsLimits(field, field.type)})`;
    }
    else if (field.type === 'guid')
    {
        expression = 'reader.guid()';
    }
    else if (field.type === 'bool')
    {
        expression = 'reader.boolean()';
    }
    else if (schema.enums[field.type])
    {
        expression = `reader.enumeration([${enumValues(field).join(', ')}]) as ${field.type}`;
    }
    else
    {
        expression = `read${field.type}(reader)`;
    }
    return field.nullable ? `(reader.boolean() ? ${expression} : null)` : expression;
}
function tsWrite(field, value, indentation = '    ')
{
    const lines = [];
    if (field.nullable)
    {
        lines.push(`${indentation}writer.boolean(${value} !== null);`, `${indentation}if (${value} !== null)`, `${indentation}{`);
        indentation += '    ';
    }
    if (field.array)
    {
        lines.push(`${indentation}writer.array(${value}, ${field.maxCount}, ${field.facts === true}, (item) =>`, `${indentation}{`, tsWrite({ ...field, array: false, nullable: false }, 'item', indentation + '    '), `${indentation}});`);
    }
    else if (field.type === 'string')
    {
        lines.push(`${indentation}writer.text(${value}, ${field.maxChars}, ${field.digest === true});`);
    }
    else if (field.type === 'timestamp')
    {
        lines.push(`${indentation}writer.int64(${value}, -62135596800000n, 253402300799999n);`);
    }
    else if (field.type === 'int64')
    {
        lines.push(`${indentation}writer.int64(${value}, ${tsLimits(field, 'int64')});`);
    }
    else if (field.type === 'int32' || field.type === 'double')
    {
        lines.push(`${indentation}writer.${field.type}(${value}, ${tsLimits(field, field.type)});`);
    }
    else if (field.type === 'guid')
    {
        lines.push(`${indentation}writer.guid(${value});`);
    }
    else if (field.type === 'bool')
    {
        lines.push(`${indentation}writer.boolean(${value});`);
    }
    else if (schema.enums[field.type])
    {
        lines.push(`${indentation}writer.enumeration(${value}, [${enumValues(field).join(', ')}]);`);
    }
    else
    {
        lines.push(`${indentation}write${field.type}(${value}, writer);`);
    }
    if (field.nullable)
    {
        lines.push(`${indentation.slice(0, -4)}}`);
    }
    return lines.join('\n');
}
let typescript = `// <auto-generated by tools/contracts/generate-authoring-canvas-wire.mjs>\n// Int64 and Unix-millisecond timestamps are canonical decimal strings, never JS numbers.\nconst maxPayloadBytes = ${schema.maxPayloadBytes};\nconst maxAggregateFacts = ${schema.maxAggregateFacts};\nconst utf8Encoder = new TextEncoder();\nconst utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });\nconst digestPattern = /^[0-9a-f]{64}$/;\nconst guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;\nfunction invalid(): never { throw new RangeError('authoring_canvas_wire_invalid'); }\n`;
for (const [name, values] of Object.entries(schema.enums))
{
    typescript += `export type ${name} = ${values.join(' | ')};\n`;
}
const clientLimitValue = domainConstantResolver(domainFiles);
typescript += `\nexport const authoringCanvasLimits = Object.freeze({\n${Object.entries(schema.clientLimits).map(([name, owner]) => `    ${name}: ${clientLimitValue(owner)}`).join(',\n')}\n} as const);\n`;
for (const [name, record] of Object.entries(schema.records))
{
    typescript += `\nexport interface ${name}\n{\n${record.fields.map((field) => `    ${camel(field.name)}: ${tsType(field)};`).join('\n')}\n}\n`;
    typescript += `function read${name}(reader: CanvasWireReader): ${name}\n{\n    return {\n${record.fields.map((field) => `        ${camel(field.name)}: ${tsRead(field)}`).join(',\n')}\n    };\n}\n`;
    typescript += `function write${name}(value: ${name}, writer: CanvasWireWriter): void\n{\n${record.fields.map((field) => tsWrite(field, `value.${camel(field.name)}`)).join('\n')}\n}\n`;
}
for (const { type } of schema.roots)
{
    if (type === schema.preparation.rootType)
    {
        typescript += '// Frame 258 also returns a prepared intention; it never represents an operation receipt.\n';
    }
    typescript += `\nexport function encode${type}(value: ${type}): Uint8Array\n{\n    const writer = new CanvasWireWriter();\n    writer.byte(1);\n    write${type}(value, writer);\n    return writer.finish();\n}\nexport function decode${type}(source: Uint8Array): ${type}\n{\n    const reader = new CanvasWireReader(source);\n    if (reader.byte() !== 1) invalid();\n    const value = read${type}(reader);\n    reader.finish();\n    return value;\n}\n`;
}
typescript += `\nexport class CanvasWireReader\n{\n    private offset = 0;\n    private facts = 0;\n    private readonly view: DataView;\n    private readonly source: Uint8Array;\n    constructor(source: Uint8Array)\n    {\n        this.source = source;\n        if (source.byteLength < 1 || source.byteLength > maxPayloadBytes) invalid();\n        this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);\n    }\n    private take(length: number): number\n    {\n        if (length < 0 || length > this.source.byteLength - this.offset) invalid();\n        const start = this.offset; this.offset += length; return start;\n    }\n    byte(): number { return this.view.getUint8(this.take(1)); }\n    boolean(): boolean { const value = this.byte(); if (value > 1) invalid(); return value === 1; }\n    enumeration(allowed: ReadonlyArray<number>): number { const value = this.byte(); if (!allowed.includes(value)) invalid(); return value; }\n    int32(min: number, max: number): number { const value = this.view.getInt32(this.take(4), true); if (value < min || value > max) invalid(); return value; }\n    int64(min: bigint, max: bigint): string { const value = this.view.getBigInt64(this.take(8), true); if (value < min || value > max) invalid(); return value.toString(); }\n    double(min: number, max: number): number { const value = this.view.getFloat64(this.take(8), true); if (!Number.isFinite(value) || value < min || value > max) invalid(); return value; }\n    guid(): string\n    {\n        const start = this.take(16);\n        const hex = Array.from(this.source.subarray(start, start + 16), (value) => value.toString(16).padStart(2, '0')).join('');\n        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);\n    }\n    text(maxChars: number, digest: boolean): string\n    {\n        const length = this.int32(0, maxChars * 4);\n        const start = this.take(length);\n        const value = utf8Decoder.decode(this.source.subarray(start, start + length));\n        if (value.length > maxChars || (digest && !digestPattern.test(value))) invalid();\n        return value;\n    }\n    array<T>(maxCount: number, minimumBytes: number, facts: boolean, read: () => T): T[]\n    {\n        const count = this.int32(0, maxCount);\n        if (count > Math.floor((this.source.byteLength - this.offset) / minimumBytes)) invalid();\n        if (facts) { if (count > maxAggregateFacts - this.facts) invalid(); this.facts += count; }\n        const values: T[] = [];\n        for (let index = 0; index < count; index++) values.push(read());\n        return values;\n    }\n    finish(): void { if (this.offset !== this.source.byteLength) invalid(); }\n}\nexport class CanvasWireWriter\n{\n    private buffer = new Uint8Array(256);\n    private offset = 0;\n    private facts = 0;\n    private reserve(length: number): DataView\n    {\n        if (length < 0 || length > maxPayloadBytes - this.offset) invalid();\n        const needed = this.offset + length;\n        if (needed > this.buffer.byteLength)\n        {\n            const grown = new Uint8Array(Math.min(maxPayloadBytes, Math.max(needed, this.buffer.byteLength * 2)));\n            grown.set(this.buffer.subarray(0, this.offset)); this.buffer = grown;\n        }\n        const view = new DataView(this.buffer.buffer, this.offset, length); this.offset += length; return view;\n    }\n    byte(value: number): void { this.reserve(1).setUint8(0, value); }\n    boolean(value: boolean): void { if (typeof value !== 'boolean') invalid(); this.byte(value ? 1 : 0); }\n    enumeration(value: number, allowed: ReadonlyArray<number>): void { if (!allowed.includes(value)) invalid(); this.byte(value); }\n    int32(value: number, min: number, max: number): void { if (!Number.isInteger(value) || value < min || value > max) invalid(); this.reserve(4).setInt32(0, value, true); }\n    int64(value: string, min: bigint, max: bigint): void\n    {\n        if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value) || value.length > 20) invalid();\n        const parsed = BigInt(value); if (parsed < min || parsed > max) invalid(); this.reserve(8).setBigInt64(0, parsed, true);\n    }\n    double(value: number, min: number, max: number): void { if (!Number.isFinite(value) || value < min || value > max) invalid(); this.reserve(8).setFloat64(0, value, true); }\n    guid(value: string): void\n    {\n        if (typeof value !== 'string' || !guidPattern.test(value)) invalid();\n        const hex = value.replaceAll('-', ''); const view = this.reserve(16);\n        for (let index = 0; index < 16; index++) view.setUint8(index, Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));\n    }\n    text(value: string, maxChars: number, digest: boolean): void\n    {\n        if (typeof value !== 'string' || value.length > maxChars || (digest && !digestPattern.test(value))) invalid();\n        // TextEncoder replaces isolated surrogates; reject them before encoding.\n        for (let index = 0; index < value.length; index++)\n        {\n            const code = value.charCodeAt(index);\n            if (code >= 0xd800 && code <= 0xdbff)\n            {\n                const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();\n            }\n            else if (code >= 0xdc00 && code <= 0xdfff) invalid();\n        }\n        const bytes = utf8Encoder.encode(value); this.int32(bytes.byteLength, 0, maxChars * 4);\n        const start = this.offset; this.reserve(bytes.byteLength); this.buffer.set(bytes, start);\n    }\n    array<T>(values: ReadonlyArray<T>, maxCount: number, facts: boolean, write: (item: T) => void): void\n    {\n        if (!Array.isArray(values) || values.length > maxCount) invalid();\n        if (facts) { if (values.length > maxAggregateFacts - this.facts) invalid(); this.facts += values.length; }\n        this.int32(values.length, 0, maxCount); for (const value of values) write(value);\n    }\n    finish(): Uint8Array { return this.buffer.slice(0, this.offset); }\n}\n`;

function cppRead(field, index)
{
    const suffix = index;
    if (field.nullable)
    {
        return `bool present${suffix}; if (!reader.Boolean(present${suffix})) return false; if (present${suffix}) { ${cppRead({ ...field, nullable: false }, `${index}N`)} }`;
    }
    if (field.array)
    {
        return `std::int32_t count${suffix}; if (!reader.Count(${field.maxCount}, ${elementMinimum(field)}, ${field.facts === true}, count${suffix})) return false; for (std::int32_t index${suffix} = 0; index${suffix} < count${suffix}; ++index${suffix}) { ${cppRead({ ...field, array: false }, `${index}A`)} }`;
    }
    if (field.type === 'string')
    {
        return `if (!reader.Text(${field.maxChars}, ${field.digest === true})) return false;`;
    }
    if (field.type === 'guid')
    {
        return 'if (!reader.Skip(16)) return false;';
    }
    if (field.type === 'bool')
    {
        return `bool value${suffix}; if (!reader.Boolean(value${suffix})) return false;`;
    }
    if (field.type === 'int32')
    {
        return `if (!reader.Int32(${range(field, '-2147483647 - 1', '2147483647')})) return false;`;
    }
    if (field.type === 'int64')
    {
        return `if (!reader.Int64(${range(field, '(-9223372036854775807LL - 1)', '9223372036854775807LL')})) return false;`;
    }
    if (field.type === 'timestamp')
    {
        return 'if (!reader.Int64(-62135596800000LL, 253402300799999LL)) return false;';
    }
    if (field.type === 'double')
    {
        return `if (!reader.Double(${range(field, '-1.7976931348623157E+308', '1.7976931348623157E+308')})) return false;`;
    }
    if (schema.enums[field.type])
    {
        return `if (!reader.Enum({${enumValues(field).join(', ')}})) return false;`;
    }
    return `if (!Parse${field.type}(reader)) return false;`;
}
let cpp = `// <auto-generated by tools/contracts/generate-authoring-canvas-wire.mjs>\n#pragma once\n#include <cmath>\n#include <cstddef>\n#include <cstdint>\n#include <cstring>\n#include <initializer_list>\n#include <limits>\n\nnamespace FsusBlog::Aeds::CanvasWire\n{\nclass Reader\n{\n    const std::uint8_t* data_;\n    std::size_t length_;\n    std::size_t offset_ = 0;\n    std::size_t facts_ = 0;\npublic:\n    Reader(const std::uint8_t* data, std::size_t length) : data_(data), length_(length) {}\n    bool Consumed() const { return offset_ == length_; }\n    bool Skip(std::size_t length) { if (length > length_ - offset_) return false; offset_ += length; return true; }\n    bool Byte(std::uint8_t& value) { if (offset_ == length_) return false; value = data_[offset_++]; return true; }\n    bool Boolean(bool& value) { std::uint8_t byte; if (!Byte(byte) || byte > 1) return false; value = byte == 1; return true; }\n    bool Enum(std::initializer_list<std::uint8_t> allowed)\n    {\n        std::uint8_t value; if (!Byte(value)) return false;\n        for (auto item : allowed) if (item == value) return true;\n        return false;\n    }\n    bool Signed32(std::int32_t& value)\n    {\n        if (length_ - offset_ < 4) return false;\n        std::uint32_t bits = 0; for (unsigned index = 0; index < 4; ++index) bits |= static_cast<std::uint32_t>(data_[offset_++]) << (index * 8u);\n        std::memcpy(&value, &bits, sizeof(value)); return true;\n    }\n    bool Int32(std::int32_t min, std::int32_t max) { std::int32_t value; return Signed32(value) && value >= min && value <= max; }\n    bool Bits64(std::uint64_t& bits)\n    {\n        if (length_ - offset_ < 8) return false;\n        bits = 0; for (unsigned index = 0; index < 8; ++index) bits |= static_cast<std::uint64_t>(data_[offset_++]) << (index * 8u); return true;\n    }\n    bool Int64(std::int64_t min, std::int64_t max)\n    {\n        std::uint64_t bits; if (!Bits64(bits)) return false; std::int64_t value; std::memcpy(&value, &bits, sizeof(value)); return value >= min && value <= max;\n    }\n    bool Double(double min, double max)\n    {\n        static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);\n        std::uint64_t bits; if (!Bits64(bits)) return false; double value; std::memcpy(&value, &bits, sizeof(value)); return std::isfinite(value) && value >= min && value <= max;\n    }\n    bool Count(std::int32_t max, std::size_t minimumBytes, bool facts, std::int32_t& count)\n    {\n        if (!Signed32(count) || count < 0 || count > max || static_cast<std::size_t>(count) > (length_ - offset_) / minimumBytes) return false;\n        if (facts) { if (static_cast<std::size_t>(count) > ${schema.maxAggregateFacts} - facts_) return false; facts_ += static_cast<std::size_t>(count); }\n        return true;\n    }\n    bool Text(std::size_t maxChars, bool digest)\n    {\n        std::int32_t signedLength; if (!Signed32(signedLength) || signedLength < 0 || static_cast<std::size_t>(signedLength) > maxChars * 4) return false;\n        const auto length = static_cast<std::size_t>(signedLength); if (length > length_ - offset_) return false;\n        const auto end = offset_ + length; std::size_t characters = 0;\n        if (digest)\n        {\n            if (length != 64) return false;\n            for (auto index = offset_; index < end; ++index) { const auto byte = data_[index]; if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) return false; }\n        }\n        while (offset_ < end)\n        {\n            const auto first = data_[offset_++]; std::uint32_t scalar; unsigned continuation;\n            if (first <= 0x7f) { scalar = first; continuation = 0; }\n            else if (first >= 0xc2 && first <= 0xdf) { scalar = first & 0x1f; continuation = 1; }\n            else if (first >= 0xe0 && first <= 0xef) { scalar = first & 0x0f; continuation = 2; }\n            else if (first >= 0xf0 && first <= 0xf4) { scalar = first & 0x07; continuation = 3; }\n            else return false;\n            if (continuation > end - offset_) return false;\n            for (unsigned index = 0; index < continuation; ++index) { const auto byte = data_[offset_++]; if ((byte & 0xc0) != 0x80) return false; scalar = (scalar << 6u) | (byte & 0x3f); }\n            if ((continuation == 1 && scalar < 0x80) || (continuation == 2 && scalar < 0x800) || (continuation == 3 && scalar < 0x10000) || (scalar >= 0xd800 && scalar <= 0xdfff) || scalar > 0x10ffff) return false;\n            characters += scalar > 0xffff ? 2 : 1; if (characters > maxChars) return false;\n        }\n        return true;\n    }\n};\n`;
for (const name of Object.keys(schema.records))
{
    cpp += `inline bool Parse${name}(Reader& reader);\n`;
}
for (const [name, record] of Object.entries(schema.records))
{
    cpp += `inline bool Parse${name}(Reader& reader)\n{\n${record.fields.map((field, index) => '    ' + cppRead(field, index)).join('\n')}\n    return true;\n}\n`;
}
cpp += `} // namespace FsusBlog::Aeds::CanvasWire\n\nnamespace FsusBlog::Aeds\n{\ninline bool ValidateAuthoringCanvasPayload(std::uint16_t frameType, const std::uint8_t* payload, std::size_t length)\n{\n    if (payload == nullptr || length < 1 || length > ${schema.maxPayloadBytes}) return false;\n    CanvasWire::Reader reader(payload, length);\n    std::uint8_t version; if (!reader.Byte(version) || version != 1) return false;\n    bool valid = false;\n    switch (frameType)\n    {\n${schema.roots.map(({ frameType, type }) => `        case ${frameType}: valid = CanvasWire::Parse${type}(reader); break;`).join('\n')}\n        default: return false;\n    }\n    return valid && reader.Consumed();\n}\n} // namespace FsusBlog::Aeds\n`;

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
{

    for (const [relative, content] of [
        ['src/core/Cache/PodBinaryCodec.AuthoringCanvas.Generated.cs', csharp],
        ['src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts', typescript],
        ['src/frontend/wasm/aeds/include/authoring_canvas_wire.generated.hpp', cpp]
    ])
    {
        const target = path.join(root, relative);
        if (process.argv.includes('--check'))
        {
            if (readFileSync(target, 'utf8') !== content)
            {
                fail(`${relative} is stale; run node tools/contracts/generate-authoring-canvas-wire.mjs`);
            }
        }
        else
        {
            writeFileSync(target, content);
        }
    }
    console.log(`[authoring-canvas-wire] ${process.argv.includes('--check') ? 'checked' : 'generated'} 13 bounded C#/TypeScript/C++ payload codecs`);
}
