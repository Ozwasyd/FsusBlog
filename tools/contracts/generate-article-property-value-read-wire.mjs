import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPropertyReadTypeScript } from './format-generated-property-value-read-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const schema = JSON.parse(read('src/shared/Contracts/Validation/article-property-value-read-wire.json'));
const protocol = JSON.parse(read('src/shared/Contracts/Validation/aeds-protocol.json'));
const declarations = schema.enumOwners.map(read).join('\n');
const shared = schema.contractOwners.map(read).join('\n');
const domainValues = read(schema.typedValueOwner);
const definitionContract = read(schema.definitionContractOwner);
const approvalScopeFieldOwner = read(schema.approvalScopeFieldOwner);
const approvalScopeFieldPredicate = approvalScopeFieldOwner.match(/public static bool IsField\(string\? value, int limit\)\s*=>\s*([\s\S]*?);/)?.[1].trim();
const expectedApprovalScopeFieldPredicate = '!string.IsNullOrWhiteSpace(value)&&value.Length<=limit&&value==value.Trim()&&!value.Any(staticc=>char.IsControl(c)||char.IsSurrogate(c))';
const approvalScopeFields = schema.records.AuthoringApprovalScopeView.fields.filter(field => field.type === 'string');
const approvalScopeValidation = approvalScopeFieldOwner.match(/public static void ValidateScope\(AuthoringStateScope scope\)\s*\{([\s\S]*?)\n    \}/)?.[1];
const ownerScopeFields = [...(approvalScopeValidation ?? '').matchAll(/IsField\(scope\.(\w+), (\d+)\)/g)]
    .map(match => ({ name: match[1], maxChars: Number(match[2]) }));
if (approvalScopeFieldPredicate?.replace(/\s+/g, '') !== expectedApprovalScopeFieldPredicate
    || ownerScopeFields.length !== approvalScopeFields.length || ownerScopeFields.length === 0
    || ownerScopeFields.some((owner, index) =>
    {
        const field = approvalScopeFields[index];
        const nullable = approvalScopeValidation.includes(`scope.${owner.name} is null ||`);
        return field.name !== owner.name || field.maxChars !== owner.maxChars || !!field.nullable !== nullable;
    }))
{
    fail('approval_scope_field_owner_drift');
}

const definitionSchemaVersion = Number(definitionContract.match(/public const int SchemaVersion = (\d+);/)?.[1]);
const definitionSiteLimit = Number(definitionContract.match(/public const int MaxSiteScopeLength = ([0-9_]+);/)?.[1].replaceAll('_', ''));
if (schema.records.ArticlePropertyValueReadScope.fields[1].maxChars !== definitionSiteLimit
    || schema.records.ArticlePropertyValueReadScope.fields[2].min !== definitionSchemaVersion
    || schema.records.ArticlePropertyValueReadScope.fields[2].max !== definitionSchemaVersion
    || !shared.includes('public const int SchemaVersion = 2;'))
{
    throw new Error('property_value_read_definition_schema_owner_drift');
}
const enums = {};
for (const match of declarations.matchAll(/public enum (\w+)(?:\s*:\s*\w+)?\s*\{([^}]+)\}/g))
{
    enums[match[1]] = [...match[2].matchAll(/(\w+)\s*=\s*(\d+)/g)].map(item => ({ name: item[1], value: Number(item[2]) }));
}
function fail(message)
{
    throw new Error(`property_value_read_owner_drift: ${message}`);
}
const frame = protocol.frameTypes.find(item => item.name === schema.root);
if (!frame || frame.value !== schema.reservedFrame || schema.schemaVersion !== 2 || schema.maxPayloadBytes !== 8388608
    || schema.maxAggregateItems !== 40000 || schema.byteOrder !== 'little-endian' || schema.guidByteOrder !== 'network')
{
    fail('root/budget');
}
const variants = enums.ArticlePropertyValueType;
if (!variants || variants.length !== 8)
{
    fail('closed eight types');
}
const payloads = {
    Text: { class: 'ArticlePropertyTextValue', field: 'Text', type: 'string', maxChars: 16384 },
    Number: { class: 'ArticlePropertyNumberValue', field: 'Number', type: 'decimal' },
    Boolean: { class: 'ArticlePropertyBooleanValue', field: 'Boolean', type: 'bool' },
    Date: { class: 'ArticlePropertyDateValue', field: 'Utc', type: 'utcTicks' },
    SingleSelect: { class: 'ArticlePropertySingleSelectValue', field: 'OptionId', type: 'guid' },
    MultiSelect: { class: 'ArticlePropertyMultiSelectValue', field: 'OptionIds', type: 'guid', array: true, maxCount: 1000 },
    ArticleReference: { class: 'ArticlePropertyArticleReferenceValue', field: 'ArticleIds', type: 'int64', array: true, maxCount: 1000, min: 1 },
    Url: { class: 'ArticlePropertyUrlValue', field: 'Url', type: 'string', maxChars: 2048 }
};
for (const variant of variants)
{
    const payload = payloads[variant.name];
    if (!payload || !domainValues.includes(`sealed record ${payload.class}`) || !domainValues.includes(payload.field))
    {
        fail(variant.name);
    }
}
const primitives = new Set(['guid', 'bool', 'int32', 'int64', 'string', 'byte', 'decimal', 'utcTicks', 'typedValue', 'scheme']);
const enumTypes = new Set(['ArticlePropertyValuePresence', 'ArticlePropertyValueChangeKind', 'ArticlePropertyValueMutationMode']);
const csType = field => field.type === 'typedValue' ? 'ArticlePropertyTypedValue' :
    field.enum && enumTypes.has(field.enum) ? field.enum : ({ guid: 'Guid', bool: 'bool', int32: 'int', int64: 'long', string: 'string', scheme: 'string', byte: 'byte', decimal: 'decimal', utcTicks: 'DateTime' }[field.type] ?? field.type);
for (const [name, record] of Object.entries(schema.records))
{
    if (shared.includes(`public sealed record ${name}(`))
    {
        const parameters = shared.match(new RegExp(`public sealed record ${name}\\(([\\s\\S]*?)\\);`))[1].split(',');
        const names = parameters.map(item => item.split('=')[0].trim().split(/\s+/).at(-1));
        if (JSON.stringify(names) !== JSON.stringify(record.fields.map(item => item.name)))
        {
            fail(`DTO order ${name}`);
        }
        for (const [index, field] of record.fields.entries())
        {
            const type = field.array ? `IReadOnlyList<${csType(field)}>` : csType(field);
            const expected = `${type}${field.nullable ? '?' : ''} ${field.name}`;
            if (parameters[index].split('=')[0].trim() !== expected)
            {
                fail(`DTO type ${name}.${field.name}`);
            }
        }
    }
    for (const field of record.fields)
    {
        if (!primitives.has(field.type) && !schema.records[field.type])
        {
            fail(`unknown field ${name}.${field.name}`);
        }
        if (field.enum && !enums[field.enum])
        {
            fail(`enum ${field.enum}`);
        }
    }
}
const ownerIdentity = createHash('sha256').update(declarations).update(domainValues).update(definitionContract).update(approvalScopeFieldOwner).digest('hex');
const notice = `// <auto-generated by tools/contracts/generate-article-property-value-read-wire.mjs>\n// Closed enum/typed payload owners SHA256 ${ownerIdentity}; read response frame ${frame.value}, strict payload v${schema.schemaVersion}.\n`;
const camel = value => value[0].toLowerCase() + value.slice(1);
const allowed = field => `[${enums[field.enum].map(item => item.value).join(', ')}]`;
const tsType = field => field.type === 'typedValue' ? 'ArticlePropertyTypedValue' : field.enum ? field.enum :
    ({ guid: 'string', bool: 'boolean', int32: 'number', int64: 'string', string: 'string', scheme: 'string', byte: 'number', decimal: 'ArticlePropertyExactDecimal', utcTicks: 'string' }[field.type] ?? field.type);
function minimum(field)
{
    if (field.nullable)
    {
        return 1;
    }
    if (field.array)
    {
        return 4;
    }
    return { guid: 16, bool: 1, int32: 4, int64: 8, string: 4, scheme: 4, byte: 1, decimal: 14, utcTicks: 8, typedValue: 2 }[field.type]
        ?? schema.records[field.type].fields.reduce((sum, item) => sum + minimum(item), 0);
}
function scalar(field, lang, value)
{
    const writing = value !== undefined;
    const min = field.min ?? 0;
    const max = field.max ?? (field.type === 'int32' ? 2147483647 : '9223372036854775807');
    if (lang === 'cs')
    {
        const call = writing ? 'writer.Write' : 'reader.Read';
        const arg = writing ? `${value}, ` : '';
        if (field.enum)
        {
            return writing ? `writer.WriteEnum((int)${value}, ${allowed(field)})` : `${enumTypes.has(field.enum) ? `(${field.enum})` : ''}reader.ReadEnum(${allowed(field)})`;
        }
        if (field.type === 'guid')
        {
            return writing ? `WritePropertyReadGuid(${value}, writer)` : 'ReadPropertyReadGuid(ref reader)';
        }
        if (field.type === 'bool')
        {
            return `${call}Boolean(${writing ? value : ''})`;
        }
        if (field.type === 'string' || field.type === 'scheme')
        {
            return `${call}String(${arg}${field.maxChars ?? 128}, ${field.digest === true})`;
        }
        if (field.type === 'int32')
        {
            return `${call}Int32(${arg}${min}, ${max})`;
        }
        if (field.type === 'int64')
        {
            return `${call}Int64(${arg}${min}L, ${max}L)`;
        }
        if (field.type === 'decimal')
        {
            return writing ? `WritePropertyReadDecimal(${value}, writer)` : 'ReadPropertyReadDecimal(ref reader)';
        }
        if (field.type === 'utcTicks')
        {
            return writing ? `WritePropertyReadUtc(${value}, writer)` : 'ReadPropertyReadUtc(ref reader)';
        }
        if (field.type === 'typedValue')
        {
            return writing ? `WritePropertyReadTypedValue(${value}, writer)` : 'ReadPropertyReadTypedValue(ref reader)';
        }
        return writing ? `WritePropertyRead${field.type}(${value}, writer)` : `ReadPropertyRead${field.type}(ref reader)`;
    }
    const call = writing ? 'writer.' : 'reader.';
    const arg = writing ? `${value}, ` : '';
    if (field.enum)
    {
        return `${call}enumeration(${writing ? `${value}, ` : ''}${allowed(field)})${writing ? '' : ` as ${field.enum}`}`;
    }
    if (field.type === 'guid')
    {
        return writing ? `writePropertyGuid(${value}, writer)` : 'readPropertyGuid(reader)';
    }
    if (field.type === 'bool')
    {
        return `${call}boolean(${writing ? value : ''})`;
    }
    if (field.type === 'string' || field.type === 'scheme')
    {
        return `${call}text(${arg}${field.maxChars ?? 128}, ${field.digest === true})`;
    }
    if (field.type === 'int32')
    {
        return `${call}int32(${arg}${min}, ${max})`;
    }
    if (field.type === 'int64')
    {
        return `${call}int64(${arg}${min}n, ${max}n)`;
    }
    if (field.type === 'utcTicks')
    {
        return `${call}int64(${arg}0n, 3155378975999999999n)`;
    }
    if (field.type === 'decimal')
    {
        return writing ? `writePropertyDecimal(${value}, writer)` : 'readPropertyDecimal(reader)';
    }
    if (field.type === 'typedValue')
    {
        return writing ? `writePropertyTypedValue(${value}, writer)` : 'readPropertyTypedValue(reader)';
    }
    return writing ? `write${field.type}(${value}, writer)` : `read${field.type}(reader)`;
}
function readExpression(field, lang)
{
    const inner = { ...field, nullable: false, array: false };
    let expression = scalar(inner, lang);
    if (field.array && lang === 'ts')
    {
        expression = `reader.array(${field.maxCount}, ${minimum(inner)}, true, () => ${expression})`;
    }
    if (field.nullable)
    {
        expression = lang === 'cs' ? `(reader.ReadBoolean() ? (${csType(field)}?)${expression} : null)` : `(reader.boolean() ? ${expression} : null)`;
    }
    return expression;
}
function semantic(name, lang, value)
{
    const cs = lang === 'cs';
    const p = name => `${value}.${cs ? name : camel(name)}`;
    if (name === 'AuthoringApprovalScopeView')
    {
        const checks = approvalScopeFields.map(field =>
        {
            const call = cs ? `IsApprovalScopeField(${p(field.name)}, ${field.maxChars})`
                : `isApprovalScopeField(${p(field.name)}, ${field.maxChars})`;
            return field.nullable ? cs ? `(${p(field.name)} is not null && !${call})`
                : `(${p(field.name)} !== null && !${call})` : `!${call}`;
        });
        return cs ? `if (${checks.join(' || ')}) throw new ArgumentException("approval_wire_scope");`
            : `if (${checks.join(' || ')}) invalid();`;
    }
    if (name === 'AuthoringApprovalOperationContextView')
    {
        return cs ? `if (${p('AuthorizationPolicy')} != "canonical-state-scope-authority-required-v1") throw new ArgumentException("approval_wire_scope_policy");`
            : `if (${p('AuthorizationPolicy')} !== 'canonical-state-scope-authority-required-v1') invalid();`;
    }
    if (name === 'AuthoringApprovalExecutionTargetView')
    {
        return cs ? `if (${p('Status')} != 0 || ${p('BlockedReason')} is not null || (${p('ExecutionClass')} == 0 ? ${p('TrustedAdapterId')} is null || ${p('TrustedAdapterIdentity')} is null : ${p('TrustedAdapterId')} is not null || ${p('TrustedAdapterIdentity')} is not null)) throw new ArgumentException("approval_wire_target_shape");`
            : `if (${p('Status')} !== 0 || ${p('BlockedReason')} !== null || (${p('ExecutionClass')} === 0 ? ${p('TrustedAdapterId')} === null || ${p('TrustedAdapterIdentity')} === null : ${p('TrustedAdapterId')} !== null || ${p('TrustedAdapterIdentity')} !== null)) invalid();`;
    }
    if (name === 'AuthoringExtensionApprovalPreviewResponse')
    {
        return cs ? `if (${p('Operation')} == 1 ? ${p('DestinationScope')} is null || ${p('FrozenPlan')} is null || ${p('Measurement')} is not null || ${p('OrderedOldTargets')}.Count == 0 || ${p('OrderedNewTargets')}.Count == 0 || ${p('Retention')} != "retain-exact-source-and-destination-backups" : ${p('DestinationScope')} is not null || ${p('FrozenPlan')} is not null || ${p('Measurement')} is null || ${p('OrderedOldTargets')}.Count != 0 || ${p('OrderedNewTargets')}.Count != 0 || ${p('Retention')} != "purge-current-and-retained-backups") throw new ArgumentException("approval_wire_operation_shape");`
            : `if (${p('Operation')} === 1 ? ${p('DestinationScope')} === null || ${p('FrozenPlan')} === null || ${p('Measurement')} !== null || ${p('OrderedOldTargets')}.length === 0 || ${p('OrderedNewTargets')}.length === 0 || ${p('Retention')} !== 'retain-exact-source-and-destination-backups' : ${p('DestinationScope')} !== null || ${p('FrozenPlan')} !== null || ${p('Measurement')} === null || ${p('OrderedOldTargets')}.length !== 0 || ${p('OrderedNewTargets')}.length !== 0 || ${p('Retention')} !== 'purge-current-and-retained-backups') invalid();`;
    }
    if (name === 'ArticlePropertyValueInput')
    {
        return cs ? `if ((${p('Presence')} == ArticlePropertyValuePresence.Present) != (${p('Value')} is not null)) throw new ArgumentException("property_mutation_presence");` : `if ((${p('Presence')} === 2) !== (${p('Value')} !== null)) invalid();`;
    }
    if (name === 'ArticlePropertyValueEntry')
    {
        return cs ? `if ((${p('Presence')} == ArticlePropertyValuePresence.Present) != (${p('Value')} is not null) || ${p('DefaultApplied')} && ${p('Presence')} == ArticlePropertyValuePresence.Missing) throw new ArgumentException("property_read_presence");` : `if ((${p('Presence')} === 2) !== (${p('Value')} !== null) || ${p('DefaultApplied')} && ${p('Presence')} === 0) invalid();`;
    }
    if (name === 'ArticlePropertySnapshotCoordinates')
    {
        return cs ? `if (${p('DraftId')}.HasValue != ${p('DraftServerRevision')}.HasValue || ${p('DraftId')}.HasValue && ${p('PublicationId')}.HasValue) throw new ArgumentException("property_read_coordinates");` : `if ((${p('DraftId')} !== null) !== (${p('DraftServerRevision')} !== null) || ${p('DraftId')} !== null && ${p('PublicationId')} !== null) invalid();`;
    }
    if (name === 'ArticlePropertyReadDefaultValue')
    {
        return cs ? `if (!IsPropertyReadDefaultShape(${value})) throw new ArgumentException("property_read_default");` : `if (!isPropertyDefaultShape(${value})) invalid();`;
    }
    if (schema.records[name].fields.some(field => field.name === 'SiteScope') && name !== 'ArticlePropertyValueReadResponse')
    {
        return cs ? `if (string.IsNullOrWhiteSpace(${p('SiteScope')}) || ${p('SiteScope')} != ${p('SiteScope')}.Trim() || ${p('SiteScope')}.Any(char.IsControl)) throw new ArgumentException("property_read_scope_site");` : `if (!isPropertyReadSiteScope(${p('SiteScope')})) invalid();`;
    }
    if (name === 'ArticlePropertyValueHistoricalReadResponse')
    {
        return cs ? `var coordinates = ${p('Snapshot')}.Snapshot.Coordinates;
        if (coordinates.ArticleId != ${p('ArticleId')} || coordinates.ArticleRevisionId != ${p('ArticleRevisionId')}
            || coordinates.PublicationId != ${p('PublicationId')} || coordinates.PropertyRevision != ${p('PropertyRevision')}
            || coordinates.DraftId.HasValue || coordinates.DraftServerRevision.HasValue
            || coordinates.DefinitionOwnerUserId != ${p('Scope')}.DefinitionOwnerUserId || coordinates.SiteScope != ${p('Scope')}.SiteScope)
            throw new ArgumentException("property_historical_coordinates");
        foreach (var definition in ${p('Definitions')})
        {
            if (definition.DefinitionOwnerUserId != ${p('Scope')}.DefinitionOwnerUserId || definition.SiteScope != ${p('Scope')}.SiteScope
                || definition.SchemaVersion != ${p('Scope')}.DefinitionSchemaVersion) throw new ArgumentException("property_historical_definition_scope");
        }` : `const coordinates = ${p('Snapshot')}.snapshot.coordinates;
    if (coordinates.articleId !== ${p('ArticleId')} || coordinates.articleRevisionId !== ${p('ArticleRevisionId')}
        || coordinates.publicationId !== ${p('PublicationId')} || coordinates.propertyRevision !== ${p('PropertyRevision')}
        || coordinates.draftId !== null || coordinates.draftServerRevision !== null
        || coordinates.definitionOwnerUserId !== ${p('Scope')}.definitionOwnerUserId || coordinates.siteScope !== ${p('Scope')}.siteScope) invalid();
    for (const definition of ${p('Definitions')})
    {
        if (definition.definitionOwnerUserId !== ${p('Scope')}.definitionOwnerUserId || definition.siteScope !== ${p('Scope')}.siteScope
            || definition.schemaVersion !== ${p('Scope')}.definitionSchemaVersion) invalid();
    }`;
    }
    if (name === 'ArticlePropertyValueReadResponse')
    {
        return cs ? `ArgumentNullException.ThrowIfNull(${p('Scope')});\n        foreach (var definition in ${p('Definitions')})\n        {\n            if (definition.DefinitionOwnerUserId != ${p('Scope')}.DefinitionOwnerUserId || definition.SiteScope != ${p('Scope')}.SiteScope || definition.SchemaVersion != ${p('Scope')}.DefinitionSchemaVersion) throw new ArgumentException("property_read_scope_definition");\n        }\n        if (${p('Current')} is { } current && (current.Snapshot.Coordinates.DefinitionOwnerUserId != ${p('Scope')}.DefinitionOwnerUserId || current.Snapshot.Coordinates.SiteScope != ${p('Scope')}.SiteScope)) throw new ArgumentException("property_read_scope_snapshot");` : `if (!${p('Scope')}) invalid();\n    for (const definition of ${p('Definitions')}) { if (definition.definitionOwnerUserId !== ${p('Scope')}.definitionOwnerUserId || definition.siteScope !== ${p('Scope')}.siteScope || definition.schemaVersion !== ${p('Scope')}.definitionSchemaVersion) invalid(); }\n    if (${p('Current')} !== null && (${p('Current')}.snapshot.coordinates.definitionOwnerUserId !== ${p('Scope')}.definitionOwnerUserId || ${p('Current')}.snapshot.coordinates.siteScope !== ${p('Scope')}.siteScope)) invalid();`;
    }
    return '';
}
let cs = notice + `#nullable enable\nusing System.Buffers;\nusing System.Buffers.Binary;\nusing System.Text;\n\n${schema.contractNamespaces.map(name => `using ${name};`).join('\n')}\n\nnamespace FsusBlog.Core.Cache;\n\npublic static partial class PodBinaryCodec\n{\n    private static readonly UTF8Encoding s_propertyReadWireUtf8 = new(false, true);\n`;
let ts = notice + '// Int64/UTC ticks stay strings. Decimal stores all96 coefficient bits, scale and sign.\n';
for (const [name, cases] of Object.entries(enums))
{
    if (Object.values(schema.records).some(record => record.fields.some(field => field.enum === name)) || name === 'ArticlePropertyValueType')
    {
        ts += `export type ${name} = ${cases.map(item => item.value).join(' | ')};\n`;
    }
}
ts += 'export interface ArticlePropertyExactDecimal { lo: number; mid: number; hi: number; scale: number; negative: boolean; }\n';
ts += `export type ArticlePropertyTypedValue =\n${variants.map(variant =>
{
    const payload = payloads[variant.name];
    return `    | { type: ${variant.value}; ${camel(payload.field)}: ${payload.array ? `ReadonlyArray<${tsType(payload)}>` : tsType(payload)} }`;
}).join('\n')};\n`;
let cpp = notice + '#pragma once\n#include <cstdint>\n#include <cstddef>\n#include <cstring>\n#include <cmath>\n#include <limits>\n#include <initializer_list>\n#include <optional>\n#include <string>\n#include <vector>\nnamespace FsusBlog::Aeds::PropertyValueReadWire\n{\n';
const nativeOwner = read('src/frontend/wasm/aeds/include/authoring_canvas_wire.generated.hpp');
cpp += 'struct CoordinateFact { std::int32_t article = 0; std::int64_t revision = 0, propertyRevision = 0; std::optional<std::int64_t> publication; bool draft = false; };\n';
cpp += 'struct ScopeFact { std::optional<std::int64_t> owner; std::string site; std::int32_t schema = 0; };\n';
cpp += nativeOwner.slice(nativeOwner.indexOf('class Reader'), nativeOwner.indexOf('inline bool ParseAuthoringCanvasOwner')).replaceAll('40002', String(schema.maxAggregateItems));
cpp = cpp.replace('    bool Consumed() const', `    std::vector<ScopeFact> scopeFacts;
    std::vector<CoordinateFact> snapshotCoordinates;
    bool Int64Value(std::int64_t& value)
    {
        std::uint64_t bits;
        if (!Bits64(bits)) return false;
        std::memcpy(&value, &bits, 8);
        return value > 0;
    }
    bool TextValue(std::string& value, std::size_t maxChars)
    {
        const auto start = offset_;
        if (!Text(maxChars, false)) return false;
        value.assign(reinterpret_cast<const char*>(data_ + start + 4), offset_ - start - 4);
        return true;
    }
    bool Owner(std::optional<std::int64_t>& owner)
    {
        bool present; if (!Boolean(present)) return false;
        if (present) { std::uint64_t bits; if (!Bits64(bits)) return false; std::int64_t value; std::memcpy(&value, &bits, 8); if (value < 1) return false; owner = value; }
        return true;
    }
    bool Consumed() const`);
cpp += `inline bool IsScopeSite(const std::string& value)
{
    if (value.empty()) return false;
    std::uint32_t first = 0, last = 0;
    for (std::size_t index = 0; index < value.size();)
    {
        const auto byte = static_cast<unsigned char>(value[index++]); std::uint32_t scalar; unsigned count;
        if (byte < 0x80) { scalar = byte; count = 0; }
        else if (byte < 0xe0) { scalar = byte & 31; count = 1; }
        else if (byte < 0xf0) { scalar = byte & 15; count = 2; }
        else { scalar = byte & 7; count = 3; }
        for (unsigned part = 0; part < count; part++) scalar = (scalar << 6) | (static_cast<unsigned char>(value[index++]) & 63);
        if (scalar <= 31 || (scalar >= 127 && scalar <= 159)) return false;
        if (first == 0) { first = scalar; }\n        last = scalar;
    }
    auto whitespace = [](std::uint32_t scalar) { return scalar == 32 || scalar == 0xa0 || scalar == 0x1680 || (scalar >= 0x2000 && scalar <= 0x200a) || scalar == 0x2028 || scalar == 0x2029 || scalar == 0x202f || scalar == 0x205f || scalar == 0x3000; };
    return !whitespace(first) && !whitespace(last);
}
`;
// TextValue has already checked canonical UTF-8 and the UTF-16 length bound. Every valid
// four-byte scalar becomes a surrogate pair under the unchanged owner's char.IsSurrogate check.
cpp += `inline bool IsApprovalScopeField(const std::string& value)
{
    if (!IsScopeSite(value)) return false;
    for (char unit : value) if (static_cast<unsigned char>(unit) >= 0xf0) return false;
    return true;
}
`;
cpp += `inline bool Guid(Reader& reader) { std::uint8_t value, aggregate = 0; for (unsigned index = 0; index < 16; ++index) { if (!reader.Byte(value)) return false; aggregate |= value; } return aggregate != 0; }\ninline bool Decimal(Reader& reader) { std::int32_t value; std::uint8_t scale; bool sign; return reader.Signed32(value) && reader.Signed32(value) && reader.Signed32(value) && reader.Byte(scale) && scale <= 28 && reader.Boolean(sign); }\ninline bool ParseTypedValue(Reader& reader, std::uint8_t& tag);\n`;
for (const name of Object.keys(schema.records))
{
    cpp += `inline bool Parse${name}(Reader& reader);\n`;
}
function cppScalar(field, id)
{
    if (field.enum)
    {
        return `std::uint8_t ${id}; if (!reader.Byte(${id}) || !(${enums[field.enum].map(item => `${id} == ${item.value}`).join(' || ')})) return false;`;
    }
    if (field.type === 'guid')
    {
        return 'if (!Guid(reader)) return false;';
    }
    if (field.type === 'bool')
    {
        return `bool ${id}; if (!reader.Boolean(${id})) return false;`;
    }
    if (field.type === 'int32')
    {
        return `if (!reader.Int32(${field.min ?? 0}, ${field.max ?? 2147483647})) return false;`;
    }
    if (field.type === 'int64')
    {
        return `if (!reader.Int64(${field.min ?? 0}, ${field.max ?? 'INT64_MAX'})) return false;`;
    }
    if (field.type === 'utcTicks')
    {
        return 'if (!reader.Int64(0, 3155378975999999999LL)) return false;';
    }
    if (field.type === 'decimal')
    {
        return 'if (!Decimal(reader)) return false;';
    }
    if (field.type === 'string' || field.type === 'scheme')
    {
        return `if (!reader.Text(${field.maxChars ?? 128}, ${field.digest === true})) return false;`;
    }
    if (field.type === 'typedValue')
    {
        return `std::uint8_t ${id}Tag; if (!ParseTypedValue(reader, ${id}Tag)) return false;`;
    }
    return `if (!Parse${field.type}(reader)) return false;`;
}
for (const [name, record] of Object.entries(schema.records))
{
    cs += `    private static ${name} ReadPropertyRead${name}(ref PropertyReadWireReader reader)\n    {\n`;
    for (const [index, field] of record.fields.entries())
    {
        if (field.array)
        {
            const inner = { ...field, array: false };
            cs += `        int count${index} = reader.ReadCount(${field.maxCount}, ${minimum(inner)}, true);\n        var field${index} = new ${csType(field)}[count${index}];\n        for (int index = 0; index < count${index}; index++) field${index}[index] = ${readExpression(inner, 'cs')};\n`;
        }
        else
        {
            cs += `        ${field.nullable ? csType(field) + '?' : 'var'} field${index} = ${readExpression(field, 'cs')};\n`;
        }
    }
    cs += `        var value = new ${name}(${record.fields.map((_, index) => `field${index}`).join(', ')});\n        ${semantic(name, 'cs', 'value')}\n        return value;\n    }\n    private static void WritePropertyRead${name}(${name} value, PropertyReadWireWriter writer)\n    {\n        ArgumentNullException.ThrowIfNull(value);\n        ${semantic(name, 'cs', 'value')}\n`;
    for (const field of record.fields)
    {
        const value = `value.${field.name}`;
        const inner = { ...field, nullable: false, array: false };
        if (field.array)
        {
            cs += `        writer.WriteCount(${value}.Count, ${field.maxCount}, true);\n        foreach (var item in ${value}) ${scalar(inner, 'cs', 'item')};\n`;
        }
        else if (field.nullable)
        {
            cs += `        writer.WriteBoolean(${value} is not null);\n        if (${value} is not null) ${scalar(inner, 'cs', ['int32', 'int64', 'decimal', 'utcTicks', 'guid'].includes(field.type) ? `${value}.Value` : value)};\n`;
        }
        else
        {
            cs += `        ${scalar(field, 'cs', value)};\n`;
        }
    }
    cs += '    }\n';
    ts += `export interface ${name}\n{\n${record.fields.map(field => `    ${camel(field.name)}: ${field.array ? `ReadonlyArray<${tsType(field)}>` : tsType(field)}${field.nullable ? ' | null' : ''};`).join('\n')}\n}\nfunction read${name}(reader: PropertyReadWireReader): ${name}\n{\n    const value: ${name} = {\n${record.fields.map(field => `        ${camel(field.name)}: ${readExpression(field, 'ts')}`).join(',\n')}\n    };\n    ${semantic(name, 'ts', 'value')}\n    return value;\n}\nfunction write${name}(value: ${name}, writer: PropertyReadWireWriter): void\n{\n    ${semantic(name, 'ts', 'value')}\n`;
    for (const field of record.fields)
    {
        const value = `value.${camel(field.name)}`;
        const inner = { ...field, nullable: false, array: false };
        if (field.array)
        {
            ts += `    writer.array(${value}, ${field.maxCount}, true, item => ${scalar(inner, 'ts', 'item')});\n`;
        }
        else if (field.nullable)
        {
            ts += `    writer.boolean(${value} !== null);\n    if (${value} !== null) ${scalar(inner, 'ts', value)};\n`;
        }
        else
        {
            ts += `    ${scalar(field, 'ts', value)};\n`;
        }
    }
    ts += '}\n';
    cpp += `inline bool Parse${name}(Reader& reader)\n{\n`;
    const capturesScope = record.fields.some(field => field.name === 'SiteScope');
    if (capturesScope) cpp += '    ScopeFact scopeFact;\n';
    const capturesCoordinates = name === 'ArticlePropertySnapshotCoordinates' || name === 'ArticlePropertyValueHistoricalReadResponse';
    if (capturesCoordinates) cpp += '    CoordinateFact coordinateFact;\n';
    for (const [index, field] of record.fields.entries())
    {
        const inner = { ...field, nullable: false, array: false };
        if (name === 'AuthoringApprovalScopeView' && field.type === 'string')
        {
            if (field.nullable)
            {
                cpp += `    bool present${index}; if (!reader.Boolean(present${index})) return false;\n    if (present${index}) { std::string text; if (!reader.TextValue(text, ${field.maxChars}) || !IsApprovalScopeField(text)) return false; }\n`;
            }
            else cpp += `    { std::string text; if (!reader.TextValue(text, ${field.maxChars}) || !IsApprovalScopeField(text)) return false; }\n`;
        }
        else if (name === 'AuthoringApprovalOperationContextView' && field.name === 'AuthorizationPolicy')
        {
            cpp += `    { std::string policy; if (!reader.TextValue(policy, ${field.maxChars}) || policy != "canonical-state-scope-authority-required-v1") return false; }\n`;
        }
        else if (name === 'AuthoringExtensionApprovalPreviewResponse' && field.name === 'Retention')
        {
            cpp += `    std::string retention; if (!reader.TextValue(retention, ${field.maxChars})) return false;\n`;
        }
        else if (capturesCoordinates && field.name === 'ArticleId')
        {
            cpp += '    if (!reader.Signed32(coordinateFact.article) || coordinateFact.article <= 0) return false;\n';
        }
        else if (capturesCoordinates && field.name === 'ArticleRevisionId')
        {
            cpp += '    if (!reader.Int64Value(coordinateFact.revision)) return false;\n';
        }
        else if (capturesCoordinates && field.name === 'PropertyRevision')
        {
            cpp += '    if (!reader.Int64Value(coordinateFact.propertyRevision)) return false;\n';
        }
        else if (capturesCoordinates && field.name === 'PublicationId')
        {
            cpp += `    if (!reader.Owner(coordinateFact.publication)) return false;\n${name === 'ArticlePropertySnapshotCoordinates' ? `    bool present${index} = coordinateFact.publication.has_value();\n` : ''}`;
        }
        else if (capturesScope && field.name === 'DefinitionOwnerUserId')
        {
            cpp += '    if (!reader.Owner(scopeFact.owner)) return false;\n';
        }
        else if (capturesScope && field.name === 'SiteScope')
        {
            cpp += `    if (!reader.TextValue(scopeFact.site, ${field.maxChars})) return false;\n`;
        }
        else if (capturesScope && (field.name === 'SchemaVersion' || field.name === 'DefinitionSchemaVersion'))
        {
            cpp += `    if (!reader.Signed32(scopeFact.schema) || scopeFact.schema != ${definitionSchemaVersion}) return false;\n`;
        }
        else if (field.array)
        {
            cpp += `    std::int32_t count${index}; if (!reader.Count(${field.maxCount}, ${minimum(inner)}, true, count${index})) return false;\n    for (std::int32_t index = 0; index < count${index}; ++index) { ${cppScalar(inner, `item${index}`)} }\n`;
        }
        else if (field.nullable)
        {
            cpp += `    bool present${index}; if (!reader.Boolean(present${index})) return false;\n    if (present${index}) { ${cppScalar(inner, `field${index}`)} }\n`;
        }
        else
        {
            cpp += `    ${cppScalar(field, `field${index}`)}\n`;
        }
    }
    if (name === 'ArticlePropertyValueEntry')
    {
        cpp += '    if ((field3 == 2) != present4 || (field6 && field3 == 0)) return false;\n';
    }
    if (name === 'ArticlePropertySnapshotCoordinates')
    {
        cpp += '    if (present5 != present6 || (present5 && present7)) return false;\n    coordinateFact.draft = present5 || present6;\n    reader.snapshotCoordinates.push_back(coordinateFact);\n';
    }
    // Nullable typed payload tags must outlive their branch to validate the default-kind pairing.
    if (name === 'ArticlePropertyReadDefaultValue')
    {
        cpp = cpp.replace('if (present1) { std::uint8_t field1Tag;', 'std::uint8_t field1Tag = 255; if (present1) {') + '    if (!((field0 <= 1 && !present1) || (field0 == 2 && present1 && (field1Tag <= 3 || field1Tag == 7)) || (field0 == 3 && present1 && (field1Tag == 4 || field1Tag == 5)) || (field0 == 4 && present1 && field1Tag == 6))) return false;\n';
    }
    if (name === 'ArticlePropertyValueHistoricalReadResponse')
    {
        cpp += '    if (reader.snapshotCoordinates.size() != 1) return false;\n    const auto& actual = reader.snapshotCoordinates.front();\n    if (actual.article != coordinateFact.article || actual.revision != coordinateFact.revision || actual.propertyRevision != coordinateFact.propertyRevision || actual.publication != coordinateFact.publication || actual.draft) return false;\n';
    }
    if (name === 'ArticlePropertyValueInput') cpp += '    if ((field3 == 2) != present4) return false;\n';
    if (name === 'AuthoringApprovalExecutionTargetView')
    {
        cpp += '    if (field0 != 0 || present10 || (field1 == 0 ? !present8 || !present11 : present8 || present11)) return false;\n';
    }
    if (name === 'AuthoringExtensionApprovalPreviewResponse')
    {
        cpp += '    if (field3 == 1 ? !present6 || !present11 || present12 || count15 == 0 || count16 == 0 || retention != "retain-exact-source-and-destination-backups" : present6 || present11 || !present12 || count15 != 0 || count16 != 0 || retention != "purge-current-and-retained-backups") return false;\n';
    }
    if (capturesScope)
    {
        cpp += '    if (!IsScopeSite(scopeFact.site)) return false;\n';
        if (name === 'ArticlePropertyValueReadScope')
        {
            cpp += '    if (!IsScopeSite(scopeFact.site)) return false;\n    for (const auto& fact : reader.scopeFacts) if (fact.owner != scopeFact.owner || fact.site != scopeFact.site || (fact.schema != 0 && fact.schema != scopeFact.schema)) return false;\n';
        }
        else cpp += '    reader.scopeFacts.push_back(std::move(scopeFact));\n';
    }
    cpp += '    return true;\n}\n';
}
cs += `    private static ArticlePropertyTypedValue ReadPropertyReadTypedValue(ref PropertyReadWireReader reader)\n    {\n        byte tag = reader.ReadEnum([${variants.map(v => v.value).join(', ')}]);\n        switch (tag)\n        {\n`;
ts += `function readPropertyTypedValue(reader: PropertyReadWireReader): ArticlePropertyTypedValue\n{\n    const type = reader.enumeration([${variants.map(v => v.value).join(', ')}]);\n    switch (type)\n    {\n`;
cpp += 'inline bool ParseTypedValue(Reader& reader, std::uint8_t& tag)\n{\n    if (!reader.Byte(tag)) return false;\n    switch (tag)\n    {\n';
for (const variant of variants)
{
    const payload = payloads[variant.name];
    if (payload.array)
    {
        const inner = { ...payload, array: false };
        cs += `            case ${variant.value}:\n            {\n                int count = reader.ReadCount(${payload.maxCount}, ${minimum(inner)}, true);\n                var values = new ${csType(payload)}[count];\n                for (int index = 0; index < count; index++) values[index] = ${scalar(inner, 'cs')};\n                return new ${payload.class}(values);\n            }\n`;
        ts += `        case ${variant.value}: return { type: ${variant.value}, ${camel(payload.field)}: reader.array(${payload.maxCount}, ${minimum(inner)}, true, () => ${scalar(inner, 'ts')}) };\n`;
        cpp += `        case ${variant.value}: { std::int32_t count; if (!reader.Count(${payload.maxCount}, ${minimum(inner)}, true, count)) return false; for (std::int32_t index = 0; index < count; ++index) { ${cppScalar(inner, 'item')} } return true; }\n`;
    }
    else
    {
        cs += `            case ${variant.value}: return new ${payload.class}(${scalar(payload, 'cs')});\n`;
        ts += `        case ${variant.value}: return { type: ${variant.value}, ${camel(payload.field)}: ${scalar(payload, 'ts')} };\n`;
        cpp += `        case ${variant.value}: { ${cppScalar(payload, 'payload')} return true; }\n`;
    }
}
cs += '            default: throw new FormatException("property_read_type");\n        }\n    }\n    private static void WritePropertyReadTypedValue(ArticlePropertyTypedValue value, PropertyReadWireWriter writer)\n    {\n        switch (value)\n        {\n';
ts += '        default: return invalid();\n    }\n}\nfunction writePropertyTypedValue(value: ArticlePropertyTypedValue, writer: PropertyReadWireWriter): void\n{\n    switch (value.type)\n    {\n';
cpp += '        default: return false;\n    }\n}\n';
for (const variant of variants)
{
    const payload = payloads[variant.name];
    cs += `            case ${payload.class} item:\n                writer.WriteByte(${variant.value});\n`;
    ts += `        case ${variant.value}:\n            writer.byte(${variant.value});\n`;
    if (payload.array)
    {
        const inner = { ...payload, array: false };
        cs += `                writer.WriteCount(item.${payload.field}.Count, ${payload.maxCount}, true);\n                foreach (var id in item.${payload.field}) ${scalar(inner, 'cs', 'id')};\n`;
        ts += `            writer.array(value.${camel(payload.field)}, ${payload.maxCount}, true, id => ${scalar(inner, 'ts', 'id')});\n`;
    }
    else
    {
        cs += `                ${scalar(payload, 'cs', `item.${payload.field}`)};\n`;
        ts += `            ${scalar(payload, 'ts', `value.${camel(payload.field)}`)};\n`;
    }
    cs += '                break;\n';
    ts += '            break;\n';
}
cs += '            default: throw new ArgumentException("property_read_type");\n        }\n    }\n';
ts += '        default: invalid();\n    }\n}\n';
const roots = [schema.root, ...schema.mutationRoots, ...schema.readRoots];
for (const rootName of roots)
{
    if (!protocol.frameTypes.some(frame => frame.name === rootName)) fail(`unallocated root ${rootName}`);
cs += `    public static byte[] Encode${rootName}(${rootName} value)\n    {\n        var writer = new PropertyReadWireWriter();\n        writer.WriteByte(${schema.schemaVersion});\n        WritePropertyRead${rootName}(value, writer);\n        return writer.ToArray();\n    }\n    public static void Write${rootName}(${rootName} value, IBufferWriter<byte> destination) => destination.Write(Encode${rootName}(value));\n    public static bool TryDecode${rootName}(ReadOnlyMemory<byte> source, out ${rootName} value)\n    {\n        value = default!;\n        if (source.Length is < 1 or > ${schema.maxPayloadBytes}) return false;\n        try\n        {\n            var reader = new PropertyReadWireReader(source.Span);\n            if (reader.ReadByte() != ${schema.schemaVersion}) return false;\n            var decoded = ReadPropertyRead${rootName}(ref reader);\n            if (!reader.IsConsumed) return false;\n            value = decoded;\n            return true;\n        }\n        catch (Exception error) when (error is ArgumentException or FormatException or OverflowException) { return false; }\n    }\n`;
ts += `export function encode${rootName}(value: ${rootName}): Uint8Array\n{\n    const writer = new PropertyReadWireWriter(); writer.byte(${schema.schemaVersion}); write${rootName}(value, writer); return writer.finish();\n}\nexport function decode${rootName}(source: Uint8Array): ${rootName}\n{\n    const reader = new PropertyReadWireReader(source);\n    if (reader.byte() !== ${schema.schemaVersion}) invalid();\n    const value = read${rootName}(reader); reader.finish(); return value;\n}\n`;
}
cs += `    private static bool IsApprovalScopeField(string? value, int limit) => ${approvalScopeFieldPredicate};\n`;
cs += `    private static Guid ReadPropertyReadGuid(ref PropertyReadWireReader reader)\n    {\n        Guid value = reader.ReadGuid();\n        return value != Guid.Empty ? value : throw new FormatException("property_read_guid");\n    }\n    private static void WritePropertyReadGuid(Guid value, PropertyReadWireWriter writer)\n    {\n        if (value == Guid.Empty) throw new ArgumentException("property_read_guid");\n        writer.WriteGuid(value);\n    }\n    private static DateTime ReadPropertyReadUtc(ref PropertyReadWireReader reader) => new(reader.ReadInt64(0, DateTime.MaxValue.Ticks), DateTimeKind.Utc);\n    private static void WritePropertyReadUtc(DateTime value, PropertyReadWireWriter writer)\n    {\n        if (value.Kind != DateTimeKind.Utc) throw new ArgumentException("property_read_utc");\n        writer.WriteInt64(value.Ticks, 0, DateTime.MaxValue.Ticks);\n    }\n    private static decimal ReadPropertyReadDecimal(ref PropertyReadWireReader reader)\n    {\n        int lo = reader.ReadInt32(int.MinValue, int.MaxValue), mid = reader.ReadInt32(int.MinValue, int.MaxValue), hi = reader.ReadInt32(int.MinValue, int.MaxValue);\n        byte scale = reader.ReadByte();\n        if (scale > 28) throw new FormatException("property_read_decimal_scale");\n        return new decimal(lo, mid, hi, reader.ReadBoolean(), scale);\n    }\n    private static void WritePropertyReadDecimal(decimal value, PropertyReadWireWriter writer)\n    {\n        int[] bits = decimal.GetBits(value);\n        writer.WriteInt32(bits[0], int.MinValue, int.MaxValue); writer.WriteInt32(bits[1], int.MinValue, int.MaxValue); writer.WriteInt32(bits[2], int.MinValue, int.MaxValue);\n        writer.WriteByte((byte)((bits[3] >> 16) & 255)); writer.WriteBoolean(bits[3] < 0);\n    }\n    private static bool IsPropertyReadDefaultShape(ArticlePropertyReadDefaultValue value) => value.Kind switch\n    {\n        0 or 1 => value.Value is null,\n        2 => value.Value is ArticlePropertyTextValue or ArticlePropertyNumberValue or ArticlePropertyBooleanValue or ArticlePropertyDateValue or ArticlePropertyUrlValue,\n        3 => value.Value is ArticlePropertySingleSelectValue or ArticlePropertyMultiSelectValue,\n        4 => value.Value is ArticlePropertyArticleReferenceValue,\n        _ => false\n    };\n`;
// Reuse the canonical existing strict primitive implementation as generator input, without editing its owner.
const canvasCs = read('src/core/Cache/PodBinaryCodec.AuthoringCanvas.Generated.cs');
cs += canvasCs.slice(canvasCs.indexOf('    private ref struct CanvasWireReader'), canvasCs.lastIndexOf('\n}'))
    .replaceAll('CanvasWire', 'PropertyReadWire').replaceAll('s_canvasWireUtf8', 's_propertyReadWireUtf8')
    .replaceAll('canvas_wire_', 'property_read_wire_').replaceAll('40002', String(schema.maxAggregateItems));
cs += '\n}\n';
cs = cs.replace(/^[\t ]+$/gmu, '');
// Emit the repository's C# layout through this producer; preserve the existing primitive owner.
const csLayout = [
    ['public static partial class PodBinaryCodec', '/// <summary>Typed article-property read wire extensions with exact decimal and UTC tick representations.</summary>\npublic static partial class PodBinaryCodec'],
    [`    public static byte[] Encode${schema.root}`, `    /// <summary>Encodes the bounded private read projection without promoting its receipt references to authority.</summary>\n    public static byte[] Encode${schema.root}`],
    [`    public static void Write${schema.root}`, `    /// <summary>Writes the typed read payload into the caller-owned binary destination.</summary>\n    public static void Write${schema.root}`],
    [`    public static bool TryDecode${schema.root}`, `    /// <summary>Accepts only a complete bounded payload with closed tags, exact numeric values and valid primitive shapes.</summary>\n    public static bool TryDecode${schema.root}`],
    ['        catch (Exception error) when (error is ArgumentException or FormatException or OverflowException) { return false; }', '        catch (Exception error) when (error is ArgumentException or FormatException or OverflowException)\n        {\n            return false;\n        }'],
    ['        int lo = reader.ReadInt32(int.MinValue, int.MaxValue), mid = reader.ReadInt32(int.MinValue, int.MaxValue), hi = reader.ReadInt32(int.MinValue, int.MaxValue);', '        int lo = reader.ReadInt32(int.MinValue, int.MaxValue);\n        int mid = reader.ReadInt32(int.MinValue, int.MaxValue);\n        int hi = reader.ReadInt32(int.MinValue, int.MaxValue);'],
    ['        writer.WriteInt32(bits[0], int.MinValue, int.MaxValue); writer.WriteInt32(bits[1], int.MinValue, int.MaxValue); writer.WriteInt32(bits[2], int.MinValue, int.MaxValue);', '        writer.WriteInt32(bits[0], int.MinValue, int.MaxValue);\n        writer.WriteInt32(bits[1], int.MinValue, int.MaxValue);\n        writer.WriteInt32(bits[2], int.MinValue, int.MaxValue);'],
    ['        writer.WriteByte((byte)((bits[3] >> 16) & 255)); writer.WriteBoolean(bits[3] < 0);', '        writer.WriteByte((byte)((bits[3] >> 16) & 255));\n        writer.WriteBoolean(bits[3] < 0);'],
    ['        public PropertyReadWireReader(ReadOnlySpan<byte> source) { _source = source; _offset = 0; _facts = 0; }', '        public PropertyReadWireReader(ReadOnlySpan<byte> source)\n        {\n            _source = source;\n            _offset = 0;\n            _facts = 0;\n        }'],
    ['        public void WriteByte(byte value) { Reserve(1)[0] = value; _buffer.Advance(1); }', '        public void WriteByte(byte value)\n        {\n            Reserve(1)[0] = value;\n            _buffer.Advance(1);\n        }'],
    ['            BinaryPrimitives.WriteInt32LittleEndian(Reserve(4), value); _buffer.Advance(4);', '            BinaryPrimitives.WriteInt32LittleEndian(Reserve(4), value);\n            _buffer.Advance(4);'],
    ['            BinaryPrimitives.WriteInt64LittleEndian(Reserve(8), value); _buffer.Advance(8);', '            BinaryPrimitives.WriteInt64LittleEndian(Reserve(8), value);\n            _buffer.Advance(8);'],
    ['            BinaryPrimitives.WriteDoubleLittleEndian(Reserve(8), value); _buffer.Advance(8);', '            BinaryPrimitives.WriteDoubleLittleEndian(Reserve(8), value);\n            _buffer.Advance(8);'],
    ['            if (length != 0) { s_propertyReadWireUtf8.GetBytes(value, Reserve(length)); _buffer.Advance(length); }', '            if (length != 0)\n            {\n                s_propertyReadWireUtf8.GetBytes(value, Reserve(length));\n                _buffer.Advance(length);\n            }']
];
for (const [original, formatted] of csLayout)
{
    if (!cs.includes(original))
    {
        fail('C# primitive layout owner drift');
    }
    cs = cs.replace(original, formatted);
}
const canvasTs = read('src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts');
ts += `function readPropertyGuid(reader: PropertyReadWireReader): string { const value = reader.guid(); if (value === '00000000-0000-0000-0000-000000000000') invalid(); return value; }\nfunction writePropertyGuid(value: string, writer: PropertyReadWireWriter): void { if (value === '00000000-0000-0000-0000-000000000000') invalid(); writer.guid(value); }\nfunction readPropertyDecimal(reader: PropertyReadWireReader): ArticlePropertyExactDecimal\n{\n    const lo = reader.int32(-2147483648, 2147483647) >>> 0, mid = reader.int32(-2147483648, 2147483647) >>> 0, hi = reader.int32(-2147483648, 2147483647) >>> 0;\n    const scale = reader.byte(); if (scale > 28) invalid(); return { lo, mid, hi, scale, negative: reader.boolean() };\n}\nfunction writePropertyDecimal(value: ArticlePropertyExactDecimal, writer: PropertyReadWireWriter): void\n{\n    for (const word of [value.lo, value.mid, value.hi]) { if (!Number.isInteger(word) || word < 0 || word > 4294967295) invalid(); writer.int32(word > 2147483647 ? word - 4294967296 : word, -2147483648, 2147483647); }\n    if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 28) invalid(); writer.byte(value.scale); writer.boolean(value.negative);\n}\nfunction isPropertyDefaultShape(value: ArticlePropertyReadDefaultValue): boolean\n{\n    return value.kind <= 1 ? value.value === null : value.value !== null && (value.kind === 2 ? value.value.type <= 3 || value.value.type === 7 : value.kind === 3 ? value.value.type === 4 || value.value.type === 5 : value.kind === 4 && value.value.type === 6);\n}\n`;
ts += `const maxPayloadBytes = ${schema.maxPayloadBytes};\nconst maxAggregateFacts = ${schema.maxAggregateItems};\nconst utf8Encoder = new TextEncoder();\nconst utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });\nconst digestPattern = /^[0-9a-f]{64}$/;\nconst guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;\nfunction invalid(): never { throw new RangeError('article_property_value_read_wire_invalid'); }\n`;
ts += canvasTs.slice(canvasTs.indexOf('export class CanvasWireReader')).replaceAll('export class CanvasWire', 'class PropertyReadWire');
// Keep the runtime array check from narrowing the original generic readonly array to any[].
ts += `\nfunction isApprovalScopeField(value: string, limit: number): boolean
{
    if (typeof value !== 'string' || value.length > limit || !isPropertyReadSiteScope(value)) return false;
    for (let index = 0; index < value.length; index++)
    {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdfff) return false;
    }
    return true;
}
`;
ts += `\nfunction isPropertyReadSiteScope(value: string): boolean\n{\n    if (typeof value !== 'string' || value.length === 0) return false;\n    for (const character of value) { const scalar = character.charCodeAt(0); if (scalar <= 31 || scalar >= 127 && scalar <= 159) return false; }\n    const whitespace = (scalar: number): boolean => scalar === 32 || scalar === 160 || scalar === 5760 || scalar >= 8192 && scalar <= 8202 || [8232, 8233, 8239, 8287, 12288].includes(scalar);\n    return !whitespace(value.charCodeAt(0)) && !whitespace(value.charCodeAt(value.length - 1));\n}\n`;
ts += '\nfunction isPropertyReadArray(value: unknown): boolean\n{\n    return Array.isArray(value);\n}\n';
ts = ts.replaceAll('Array.isArray(values)', 'isPropertyReadArray(values)');
ts = await formatPropertyReadTypeScript(ts, root, 'src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts');
cpp += `}\nnamespace FsusBlog::Aeds\n{\ninline bool IsArticlePropertyPayloadFrame(std::uint16_t frameType)\n{\n    switch (frameType)\n    {\n${roots.map(name => `        case ${protocol.frameTypes.find(frame => frame.name === name).value}:`).join('\n')}\n            return true;\n        default: return false;\n    }\n}\ninline bool ValidateArticlePropertyValueReadPayload(std::uint16_t frameType, const std::uint8_t* payload, std::size_t length)\n{\n    if (!IsArticlePropertyPayloadFrame(frameType) || payload == nullptr || length < 1 || length > ${schema.maxPayloadBytes}) return false;\n    PropertyValueReadWire::Reader reader(payload, length);\n    std::uint8_t version; if (!reader.Byte(version) || version != ${schema.schemaVersion}) return false;\n    bool valid;\n    switch (frameType)\n    {\n${roots.map(name => `        case ${protocol.frameTypes.find(frame => frame.name === name).value}: valid = PropertyValueReadWire::Parse${name}(reader); break;`).join('\n')}\n        default: return false;\n    }\n    return valid && reader.Consumed();\n}\n}\n`;
for (const [name, content] of [
    ['src/core/Cache/PodBinaryCodec.ArticlePropertyValueRead.Generated.cs', cs],
    ['src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts', ts],
    ['src/frontend/wasm/aeds/include/property_value_read.generated.hpp', cpp]
])
{
    if (process.argv.includes('--typescript-only') && !name.endsWith('.ts'))
    {
        continue;
    }
    if (process.argv.includes('--check'))
    {
        if (read(name) !== content)
        {
            fail(`generated ${name}`);
        }
    }
    else
    {
        writeFileSync(path.join(root, name), content);
    }
}
