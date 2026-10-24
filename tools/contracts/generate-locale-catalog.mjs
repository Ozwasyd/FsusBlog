import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogRelative = 'src/shared/Contracts/Localization/locale-catalog.json';
const catalogPath = process.argv.includes('--catalog') ? path.resolve(process.argv[process.argv.indexOf('--catalog') + 1]) : path.join(root, catalogRelative);
const checkOnly = process.argv.includes('--check');
const requiredFields = ['code', 'bcp47', 'documentLanguage', 'intlLocale', 'openGraphLocale', 'nativeName', 'englishName', 'direction', 'script', 'status', 'aliases'];
const authorityFields = ['schema', 'digestAlgorithm', 'canonicalSerialization', 'defaultCode', 'locales'];
const localeFontScripts = Object.freeze({
    Hans: Object.freeze({
        family: 'Noto Sans SC',
        facePrefix: 'noto-sans-sc',
        assetEntry: 'font-script-hans',
        assetFile: 'hans.css',
        representativeText: '汉语字形'
    }),
    Hant: Object.freeze({
        family: 'Noto Sans TC',
        facePrefix: 'noto-sans-tc',
        assetEntry: 'font-script-hant',
        assetFile: 'hant.css',
        representativeText: '漢語字形'
    }),
    Jpan: Object.freeze({
        family: 'Noto Sans JP',
        facePrefix: 'noto-sans-jp',
        assetEntry: 'font-script-jpan',
        assetFile: 'jpan.css',
        representativeText: '日本語字形'
    }),
    Kore: Object.freeze({
        family: 'Noto Sans KR',
        facePrefix: 'noto-sans-kr',
        assetEntry: 'font-script-kore',
        assetFile: 'kore.css',
        representativeText: '한국어글꼴'
    }),
    Latn: Object.freeze({
        family: 'Google Sans',
        facePrefix: 'google-sans-latin-ext',
        assetEntry: 'font-script-latn',
        assetFile: 'latn.css',
        representativeText: 'Àéñçõ'
    }),
    Cyrl: Object.freeze({
        family: 'Google Sans',
        facePrefix: 'google-sans-cyrillic',
        assetEntry: 'font-script-cyrl',
        assetFile: 'cyrl.css',
        representativeText: 'Привет'
    })
});
const localeFontWeights = Object.freeze([400, 500, 700]);
const fail = (message) =>
{
    throw new Error(`[locale-catalog] ${message}`);
};
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog.schema !== 'fsusblog.locale-catalog.v1' || catalog.digestAlgorithm !== 'sha256' || catalog.canonicalSerialization !== 'json-utf8-v1')
{
    fail('unsupported catalog authority contract');
}
for (const field of Object.keys(catalog))
{
    if (!authorityFields.includes(field))
    {
        fail(`catalog authority contains unsupported field ${field}`);
    }
}
if (!Array.isArray(catalog.locales) || catalog.locales.length !== 10)
{
    fail('catalog must contain exactly ten locales');
}
const codes = new Set();
const aliases = new Set();
for (const locale of catalog.locales)
{
    for (const field of Object.keys(locale))
    {
        if (!requiredFields.includes(field))
        {
            fail(`${locale.code ?? '<unknown>'} contains unsupported field ${field}`);
        }
    }
    for (const field of requiredFields)
    {
        if (!(field in locale) || locale[field] === '' || locale[field] == null)
        {
            fail(`${locale.code ?? '<unknown>'} is missing ${field}`);
        }
    }
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/u.test(locale.code) || codes.has(locale.code))
    {
        fail(`invalid or duplicate code ${locale.code}`);
    }
    if (locale.direction !== 'ltr' && locale.direction !== 'rtl')
    {
        fail(`${locale.code} has invalid direction`);
    }
    if (locale.status !== 'enabled')
    {
        fail(`${locale.code} must be enabled`);
    }
    if (!localeFontScripts[locale.script])
    {
        fail(`${locale.code} has unsupported font script ${locale.script}`);
    }
    if (!Array.isArray(locale.aliases) || locale.aliases.some((alias) => typeof alias !== 'string' || alias.length === 0))
    {
        fail(`${locale.code} has invalid aliases`);
    }
    codes.add(locale.code);
    for (const alias of [locale.code, ...locale.aliases].map((value) => value.toLowerCase()))
    {
        if (aliases.has(alias))
        {
            fail(`duplicate alias ${alias}`);
        }
        aliases.add(alias);
    }
}
if (!codes.has(catalog.defaultCode))
{
    fail('defaultCode must identify an enabled locale');
}
const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const localeFontCatalog = Object.fromEntries(catalog.locales.map((locale) =>
{
    const script = localeFontScripts[locale.script];
    return [locale.code, {
        locale: locale.code,
        script: locale.script,
        family: script.family,
        faceIds: localeFontWeights.map((weight) => `${script.facePrefix}:${weight}`),
        weights: localeFontWeights,
        assetEntry: script.assetEntry,
        assetFile: script.assetFile,
        representativeText: script.representativeText
    }];
}));
const localeFontCatalogDigest = createHash('sha256').update(JSON.stringify({
    localeCatalogDigest: digest,
    scripts: localeFontScripts,
    locales: localeFontCatalog
})).digest('hex');
const notice = `Generated from ${catalogRelative}; digest ${digest}; do not edit by hand.`;
const q = (value) => JSON.stringify(value);
const indentJson = (value, level = 0) =>
{
    if (Array.isArray(value))
    {
        if (value.length === 0)
        {
            return '[]';
        }
        const pad = '    '.repeat(level + 1);
        const close = '    '.repeat(level);
        return `[\n${value.map((item) => `${pad}${indentJson(item, level + 1)}`).join(',\n')}\n${close}]`;
    }
    if (value && typeof value === 'object')
    {
        const entries = Object.entries(value);
        if (entries.length === 0)
        {
            return '{}';
        }
        const pad = '    '.repeat(level + 1);
        const close = '    '.repeat(level);
        return `{\n${entries.map(([key, item]) => `${pad}${q(key)}: ${indentJson(item, level + 1)}`).join(',\n')}\n${close}}`;
    }
    return q(value);
};
const ts = `// ${notice}

export const LOCALE_CATALOG_DIGEST = '${digest}' as const;
export const DEFAULT_LOCALE = ${q(catalog.defaultCode)} as const;
export const LOCALE_CATALOG = ${JSON.stringify(catalog.locales, null, 4)} as const;
export const ENABLED_LOCALES = LOCALE_CATALOG.filter((locale) => locale.status === 'enabled');
export type SupportedLocale = typeof ENABLED_LOCALES[number]['code'];
export type LocaleDescriptor = typeof ENABLED_LOCALES[number];
const descriptorByCode: ReadonlyMap<string, LocaleDescriptor> = new Map(ENABLED_LOCALES.map((locale) => [locale.code, locale]));
const codeByAlias: ReadonlyMap<string, SupportedLocale> = new Map(ENABLED_LOCALES.flatMap((locale) => [locale.code, ...locale.aliases].map((alias) => [alias.toLowerCase(), locale.code] as const)));
export function parseSupportedLocale(value: unknown): SupportedLocale | undefined
{
    return typeof value === 'string' ? codeByAlias.get(value.toLowerCase()) : undefined;
}
export function isSupportedLocale(value: unknown): value is SupportedLocale
{
    return typeof value === 'string' && descriptorByCode.has(value);
}
export function getLocaleDescriptor(value: SupportedLocale): LocaleDescriptor
{
    return descriptorByCode.get(value)!;
}
`;

const localeFontTs = `// ${notice}
// Font projection digest ${localeFontCatalogDigest}; generated with the locale catalog.

import type { SupportedLocale } from './localeCatalog';

export const LOCALE_FONT_CATALOG_SCHEMA = 'fsusblog.locale-font-catalog.v1' as const;
export const LOCALE_FONT_CATALOG_DIGEST = '${localeFontCatalogDigest}' as const;
export const LOCALE_FONT_WEIGHTS = Object.freeze(${indentJson([...localeFontWeights])} as const);
export type LocaleFontWeight = typeof LOCALE_FONT_WEIGHTS[number];
export const SCRIPT_FONT_CATALOG = Object.freeze(${indentJson(localeFontScripts)} as const);
export type LocaleFontScript = keyof typeof SCRIPT_FONT_CATALOG;
export type LocaleFontDescriptor = Readonly<{
    locale: SupportedLocale;
    script: LocaleFontScript;
    family: string;
    faceIds: readonly string[];
    weights: readonly LocaleFontWeight[];
    assetEntry: string;
    assetFile: string;
    representativeText: string;
}>;
export const LOCALE_FONT_CATALOG = Object.freeze(${indentJson(localeFontCatalog)} as const satisfies Readonly<Record<SupportedLocale, LocaleFontDescriptor>>);
export function getLocaleFontDescriptor(locale: SupportedLocale): LocaleFontDescriptor
{
    return LOCALE_FONT_CATALOG[locale];
}
`;
const csEnum = (code) => code
    .split(/[^A-Za-z0-9]+/u)
    .map((segment) => `${segment[0].toUpperCase()}${segment.slice(1)}`)
    .join('');
const cs = `// <auto-generated />\n// ${notice}\n\n#nullable enable\n\nnamespace FsusBlog.Shared.Contracts.Localization;\n\npublic enum SupportedLocale : byte\n{\n${catalog.locales.map((locale, index) => `    ${csEnum(locale.code)} = ${index + 1}`).join(',\n')}\n}\n\npublic sealed record LocaleDescriptor(\n    SupportedLocale Locale, string Code, string Bcp47, string DocumentLanguage, string IntlLocale, string OpenGraphLocale,\n    string NativeName, string EnglishName, string Direction, string Script, string Status, IReadOnlyList<string> Aliases);\n\npublic static class LocaleCatalog\n{\n    public const string Digest = "${digest}";\n    public static readonly IReadOnlyList<LocaleDescriptor> Enabled =\n    [\n${catalog.locales.map((locale) => `        new(SupportedLocale.${csEnum(locale.code)}, ${q(locale.code)}, ${q(locale.bcp47)}, ${q(locale.documentLanguage)}, ${q(locale.intlLocale)}, ${q(locale.openGraphLocale)}, ${q(locale.nativeName)}, ${q(locale.englishName)}, ${q(locale.direction)}, ${q(locale.script)}, ${q(locale.status)}, [${locale.aliases.map(q).join(', ')}]),`).join('\n')}\n    ];\n    public static LocaleDescriptor Default { get; } = Enabled.Single(locale => locale.Code == ${q(catalog.defaultCode)});\n    public static bool TryParse(string? value, out LocaleDescriptor descriptor)\n    {\n        if (!string.IsNullOrWhiteSpace(value))\n        {\n            descriptor = Enabled.FirstOrDefault(locale => string.Equals(locale.Code, value, StringComparison.OrdinalIgnoreCase) || locale.Aliases.Any(alias => string.Equals(alias, value, StringComparison.OrdinalIgnoreCase)))!;\n            if (descriptor is not null) return true;\n        }\n        descriptor = null!;\n        return false;\n    }\n}\n`;
const outputs = [
    ['src/frontend/src/locales/localeCatalog.ts', ts],
    ['src/frontend/src/locales/localeFontCatalog.ts', localeFontTs],
    ['src/shared/Contracts/Localization/LocaleCatalog.g.cs', cs]
];
let drift = false;
for (const [relative, expected] of outputs)
{
    const target = path.join(root, relative);
    let current = '';
    try
    {
        current = await readFile(target, 'utf8');
    }
    catch
    {
        // Unreadable or absent generated output is treated as drift.
    }
    if (current === expected)
    {
        continue;
    }
    if (checkOnly)
    {
        console.error(`[locale-catalog] ${relative} is stale`);
        drift = true;
    }
    else
    {
        await writeFile(target, expected);
        console.log(`[locale-catalog] wrote ${relative}`);
    }
}
if (drift)
{
    process.exitCode = 1;
}
else if (checkOnly)
{
    console.log('[locale-catalog] generated surfaces are in sync');
}
