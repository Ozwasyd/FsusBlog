import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function validateManifest(manifest)
{
    const frameTypes = manifest.frameTypes;
    const retiredFrameValues = manifest.retiredFrameValues ?? [];
    const reservedFrameValues = manifest.reservedFrameValues ?? [];
    if (!Array.isArray(frameTypes) || frameTypes.length === 0 || !Array.isArray(retiredFrameValues)
        || !Array.isArray(reservedFrameValues))
    {
        throw new Error('AEDS frame and retired collections must be complete arrays');
    }

    if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1)
    {
        throw new Error('aeds-protocol.json schemaVersion must be a positive integer');
    }
    if (manifest.header?.size !== 16)
    {
        throw new Error('aeds-protocol.json v2 header size must be exactly 16 bytes');
    }
    if (!/^0x[0-9A-Fa-f]{8}$/u.test(manifest.header.magic))
    {
        throw new Error('aeds-protocol.json header magic must be an 8-digit hexadecimal uint32');
    }
    if (!Number.isInteger(manifest.header.version) || manifest.header.version < 1 || manifest.header.version > 0xff)
    {
        throw new Error('aeds-protocol.json header version must be a positive uint8');
    }

    const names = new Set();
    const values = new Set();
    const retiredValues = new Set();
    const reservedValues = new Set();
    const reservedNames = new Set();
    for (const retired of retiredFrameValues)
    {
        if (!Number.isInteger(retired.value) || retired.value < 0 || retired.value > 0xffff)
        {
            throw new Error(`Invalid retired frame value: ${retired.value}`);
        }
        if (typeof retired.reason !== 'string' || retired.reason.trim().length === 0)
        {
            throw new Error(`Retired frame ${retired.value} must include a reason`);
        }
        if (retiredValues.has(retired.value))
        {
            throw new Error(`Duplicate retired frame value: ${retired.value}`);
        }
        retiredValues.add(retired.value);
    }

    for (const reservation of reservedFrameValues)
    {
        if (reservation == null || typeof reservation !== 'object' || Array.isArray(reservation)
            || Object.keys(reservation).sort().join(',') !== 'name,ownerIssue,reason,value'
            || !Number.isInteger(reservation.value) || reservation.value < 0 || reservation.value > 0xffff
            || typeof reservation.name !== 'string' || reservation.name.trim() !== reservation.name
            || !/^[A-Z][A-Za-z0-9]*$/u.test(reservation.name)
            || !Number.isInteger(reservation.ownerIssue) || reservation.ownerIssue <= 0
            || typeof reservation.reason !== 'string' || reservation.reason.trim() !== reservation.reason
            || reservation.reason.length === 0)
        {
            throw new Error('AEDS reservation must have a closed valid identity and owner shape');
        }
        if (reservedValues.has(reservation.value) || reservedNames.has(reservation.name))
        {
            throw new Error('Duplicate reserved frame identity');
        }
        if (retiredValues.has(reservation.value))
        {
            throw new Error(`Reserved frame ${reservation.name} reuses retired value ${reservation.value}`);
        }
        reservedValues.add(reservation.value);
        reservedNames.add(reservation.name);
    }

    for (const frame of frameTypes)
    {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(frame.name))
        {
            throw new Error(`Invalid frame type name: ${frame.name}`);
        }
        if (!Number.isInteger(frame.value) || frame.value < 0 || frame.value > 0xffff)
        {
            throw new Error(`Invalid frame type value for ${frame.name}: ${frame.value}`);
        }
        if (names.has(frame.name))
        {
            throw new Error(`Duplicate frame type name: ${frame.name}`);
        }
        if (values.has(frame.value))
        {
            throw new Error(`Duplicate frame type value: ${frame.value}`);
        }
        if (retiredValues.has(frame.value))
        {
            throw new Error(`Frame type ${frame.name} reuses retired value ${frame.value}`);
        }
        if (reservedValues.has(frame.value) || reservedNames.has(frame.name))
        {
            throw new Error(`Frame type ${frame.name} collides with an unadmitted reservation`);
        }
        names.add(frame.name);
        values.add(frame.value);
    }

    const golden = manifest.goldenCatalog;
    if (golden == null || typeof golden !== 'object' || Array.isArray(golden)
        || Object.keys(golden).sort().join(',') !== 'defaultEvidence,version'
        || golden.version !== 'fsusblog-aeds-golden-catalog-v1')
    {
        throw new Error('AEDS golden catalog metadata must have the closed v1 shape');
    }
    if (!Array.isArray(golden.defaultEvidence) || golden.defaultEvidence.length === 0
        || new Set(golden.defaultEvidence).size !== golden.defaultEvidence.length
        || golden.defaultEvidence.some((entry) => typeof entry !== 'string'
            || entry.trim() !== entry
            || !/^tests\/backend\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.cs$/u.test(entry)))
    {
        throw new Error('AEDS golden evidence must be unique canonical backend test paths');
    }
    const goldenOrders = new Set();
    for (const frame of frameTypes)
    {
        if (typeof frame.goldenFamily !== 'string'
            || frame.goldenFamily.trim() !== frame.goldenFamily
            || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(frame.goldenFamily))
        {
            throw new Error(`AEDS golden family is missing or invalid for ${frame.name}`);
        }
        if (!Number.isInteger(frame.goldenOrder) || frame.goldenOrder < 0
            || frame.goldenOrder >= frameTypes.length || goldenOrders.has(frame.goldenOrder))
        {
            throw new Error(`AEDS golden order must uniquely cover every frame: ${frame.name}`);
        }
        goldenOrders.add(frame.goldenOrder);
    }
}

const generatedNotice = 'Generated from src/shared/Contracts/Validation/aeds-protocol.json. Run npm run generate:aeds-protocol from src/frontend.';

function renderCsEnum(frameTypes)
{
    const lines = [];
    for (const frame of frameTypes)
    {
        if (frame.comment)
        {
            lines.push(`    // ${frame.comment}`);
        }
        lines.push(`    ${frame.name} = ${frame.value},`);
    }
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
    return lines.join('\n');
}

function renderCoreFrameType(frameTypes)
{
    return `// <auto-generated />\n// ${generatedNotice}\n\nnamespace FsusBlog.Core.Algorithms;\n\npublic enum AedsFrameType : ushort\n{\n${renderCsEnum(frameTypes)}\n}\n`;
}

function renderSharedFrameHeader(manifest)
{
    const frameTypes = manifest.frameTypes;
    return `// <auto-generated />\n// ${generatedNotice}\n\nusing System.Runtime.InteropServices;\n\nnamespace FsusBlog.Shared;\n\n[StructLayout(LayoutKind.Sequential, Pack = 1)]\npublic readonly struct AedsFrameHeader\n{\n    public const int Size = ${manifest.header.size};\n    public const uint Magic = ${manifest.header.magic}; // "AEDS" little-endian\n    public const byte VersionValue = ${manifest.header.version};\n    public const byte CurrentVersion = VersionValue;\n    public const byte CurrentHeaderLength = Size;\n\n    public AedsFrameHeader(\n        uint magic,\n        byte version,\n        byte headerLength,\n        ushort flags,\n        ushort frameType,\n        uint payloadLength,\n        ushort payloadCrc16)\n    {\n        MagicValue = magic;\n        Version = version;\n        HeaderLength = headerLength;\n        Flags = flags;\n        FrameType = frameType;\n        PayloadLength = payloadLength;\n        PayloadCrc16 = payloadCrc16;\n    }\n\n    public readonly uint MagicValue;\n    public readonly byte Version;\n    public readonly byte HeaderLength;\n    public readonly ushort Flags;\n    public readonly ushort FrameType;\n    public readonly uint PayloadLength;\n    public readonly ushort PayloadCrc16;\n}\n\npublic enum AedsFrameType : ushort\n{\n${renderCsEnum(frameTypes)}\n}\n`;
}

function renderCppFrameHeader(manifest)
{
    const frameTypes = manifest.frameTypes;
    const retiredFrameValues = manifest.retiredFrameValues ?? [];
    const enumLines = [];
    const knownCases = [];
    const retiredCases = [];
    for (const frame of frameTypes)
    {
        if (frame.comment)
        {
            enumLines.push(`    // ${frame.comment}`);
        }
        enumLines.push(`    ${frame.name} = ${frame.value},`);
        knownCases.push(`        case FrameType::${frame.name}:`);
    }
    for (const retired of retiredFrameValues)
    {
        retiredCases.push(`        case ${retired.value}:`);
    }
    for (const frame of frameTypes)
    {
        if (String(frame.name).startsWith('Retired'))
        {
            retiredCases.push(`        case static_cast<std::uint16_t>(FrameType::${frame.name}):`);
        }
    }

    return `// <auto-generated />
// ${generatedNotice}
#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace FsusBlog::Aeds
{

inline constexpr std::uint32_t kMagic = ${manifest.header.magic}U; // "AEDS" little-endian
inline constexpr std::uint8_t kVersion = ${manifest.header.version}U;
inline constexpr std::size_t kHeaderSize = ${manifest.header.size}U;

#pragma pack(push, 1)

struct AedsFrameHeader
{
    std::uint32_t magic;
    std::uint8_t version;
    std::uint8_t header_length;
    std::uint16_t flags;
    std::uint16_t frame_type;
    std::uint32_t payload_length;
    std::uint16_t payload_crc16;
};

#pragma pack(pop)

static_assert(std::is_standard_layout_v<AedsFrameHeader>, "AedsFrameHeader must remain standard layout");
static_assert(sizeof(AedsFrameHeader) == kHeaderSize, "AedsFrameHeader size mismatch");
static_assert(offsetof(AedsFrameHeader, magic) == 0U, "AedsFrameHeader.magic offset mismatch");
static_assert(offsetof(AedsFrameHeader, version) == 4U, "AedsFrameHeader.version offset mismatch");
static_assert(offsetof(AedsFrameHeader, header_length) == 5U, "AedsFrameHeader.header_length offset mismatch");
static_assert(offsetof(AedsFrameHeader, flags) == 6U, "AedsFrameHeader.flags offset mismatch");
static_assert(offsetof(AedsFrameHeader, frame_type) == 8U, "AedsFrameHeader.frame_type offset mismatch");
static_assert(offsetof(AedsFrameHeader, payload_length) == 10U, "AedsFrameHeader.payload_length offset mismatch");
static_assert(offsetof(AedsFrameHeader, payload_crc16) == 14U, "AedsFrameHeader.payload_crc16 offset mismatch");

enum class FrameType : std::uint16_t
{
${enumLines.join('\n')}
};

[[nodiscard]] constexpr bool IsRetiredFrameType(std::uint16_t raw) noexcept
{
    switch (raw)
    {
${retiredCases.join('\n')}
            return true;
        default:
            return false;
    }
}

[[nodiscard]] constexpr bool IsKnownFrameType(std::uint16_t raw) noexcept
{
    switch (static_cast<FrameType>(raw))
    {
${knownCases.join('\n')}
            return true;
        default:
            return false;
    }
}

} // namespace FsusBlog::Aeds
`;
}

function renderTsFrame(manifest)
{
    const frameTypes = manifest.frameTypes;
    const lines = [];
    for (const frame of frameTypes)
    {
        if (frame.comment)
        {
            lines.push(`  // ${frame.comment}`);
        }
        lines.push(`  ${frame.name}: ${frame.value},`);
    }

    return `// ${generatedNotice}\n\nexport const FrameType = {\n${lines.join('\n')}\n} as const;\n\nexport type FrameType = typeof FrameType[keyof typeof FrameType];\n\nexport const AEDS_HEADER_LENGTH = ${manifest.header.size};\nexport const AEDS_MAGIC = ${manifest.header.magic};\nexport const AEDS_VERSION = ${manifest.header.version};\n\nexport const PUBLIC_SEO_FRAME_TYPES = new Set<FrameType>([\n  FrameType.ArticleList,\n  FrameType.ArticleDetail,\n  FrameType.ArticleFeatured\n]);\n\nexport function isPublicSeoFrameType(frameType: FrameType | undefined): boolean {\n  return frameType !== undefined && PUBLIC_SEO_FRAME_TYPES.has(frameType);\n}\n`;
}

function renderGoldenCatalog(manifest)
{
    const quote = JSON.stringify;
    const evidence = manifest.goldenCatalog.defaultEvidence.map((entry, index, entries) =>
        `    ${quote(entry)}${index + 1 < entries.length ? ',' : ''}`);
    const retired = (manifest.retiredFrameValues ?? []).map((entry, index, entries) =>
        `    { "value": ${entry.value}, "reason": ${quote(entry.reason)} }${index + 1 < entries.length ? ',' : ''}`);
    const frames = [...manifest.frameTypes].sort((left, right) => left.goldenOrder - right.goldenOrder)
        .map((frame, index, entries) =>
            `    { "name": ${quote(frame.name)}, "value": ${frame.value}, "family": ${quote(frame.goldenFamily)} }${index + 1 < entries.length ? ',' : ''}`);
    return [
        '{',
        `  "version": ${quote(manifest.goldenCatalog.version)},`,
        '  "generatedFrom": "src/core/Algorithms/AedsFrameType.cs",',
        '  "defaultEvidence": [',
        ...evidence,
        '  ],',
        '  "retiredFrameValues": [',
        ...retired,
        '  ],',
        '  "frames": [',
        ...frames,
        '  ]',
        '}',
        ''
    ].join('\n');
}

/**
 * Render the complete protocol-owned products without reading an old output.
 * Golden family/order/evidence are explicit source metadata, not payload or ABI guesses.
 */
export function renderAedsProtocolOutputs(manifest)
{
    validateManifest(manifest);
    return [
        ['src/core/Algorithms/AedsFrameType.cs', renderCoreFrameType(manifest.frameTypes)],
        ['src/shared/AedsFrameHeader.cs', renderSharedFrameHeader(manifest)],
        ['src/frontend/wasm/web/protocol/frame.ts', renderTsFrame(manifest)],
        ['src/frontend/wasm/aeds/include/aeds_frame.hpp', renderCppFrameHeader(manifest)],
        ['tests/backend/Fixtures/aeds-golden-catalog.json', renderGoldenCatalog(manifest)]
    ];
}

function formatTsFrameProduct(source)
{
    // Preserve the original renderer oracle; canonical CLI products follow repository style.
    return source.replace(/^ {2}/gmu, '    ')
        .replace(',\n} as const;', '\n} as const;')
        .replace('): boolean {', '): boolean\n{');
}

async function main()
{
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const manifestPath = path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json');
    const checkOnly = process.argv.includes('--check');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const outputs = renderAedsProtocolOutputs(manifest);
    let drift = false;
    for (const [relativePath, rendered] of outputs)
    {
        const expected = relativePath === 'src/frontend/wasm/web/protocol/frame.ts'
            ? formatTsFrameProduct(rendered) : rendered;
        const absolutePath = path.join(root, relativePath);
        const current = await readFile(absolutePath, 'utf8');
        if (current === expected)
        {
            continue;
        }
        if (checkOnly)
        {
            console.error(`[aeds-protocol] ${relativePath} is not in sync with ${path.relative(root, manifestPath)}`);
            drift = true;
            continue;
        }
        await writeFile(absolutePath, expected);
        console.log(`[aeds-protocol] wrote ${relativePath}`);
    }
    if (drift)
    {
        process.exitCode = 1;
        return;
    }
    if (checkOnly)
    {
        console.log('[aeds-protocol] generated files are in sync');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    await main();
}
