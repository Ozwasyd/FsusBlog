import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the canonical closed loader parser and exactness rules.
import { validateLocaleDomainLoaderMap } from '../frontend/check-locale-domain-static.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(await readFile(path.join(root, 'src/shared/Contracts/Localization/locale-catalog.json'), 'utf8'));
const expectedKeys = new Set(catalog.locales.filter((locale) => locale.status === 'enabled').map((locale) => locale.code));

export function assertExactKeys(name, actualKeys)
{
    const actual = new Set(actualKeys);
    const missing = [...expectedKeys].filter((key) => !actual.has(key));
    const extra = [...actual].filter((key) => !expectedKeys.has(key));
    if (missing.length || extra.length)
    {
        throw new Error(`${name} drift: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
    }
}

const extractObjectKeys = (source, symbol) =>
{
    const match = source.match(new RegExp(
        `(?:const|export const)\\s+${symbol}\\s*=\\s*(?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\}\\s*(?:\\)\\s*)?as const`,
        'u'
    ));
    if (!match)
    {
        throw new Error(`cannot locate ${symbol}`);
    }
    // Prefer shallowest object entries (`    "zh-CN": {` / `  'zh-CN': {`); fall back to flat maps.
    const nestedMatches = [...match[1].matchAll(/^[ \t]*(?:'([^']+)'|"([^"]+)")\s*:\s*\{/gmu)];
    if (nestedMatches.length > 0)
    {
        const minIndent = Math.min(...nestedMatches.map((item) => item[0].match(/^[ \t]*/u)[0].length));
        return nestedMatches
            .filter((item) => item[0].match(/^[ \t]*/u)[0].length === minIndent)
            .map((item) => item[1] ?? item[2]);
    }
    return [...match[1].matchAll(/^[ \t]*(?:'([^']+)'|"([^"]+)")\s*:/gmu)]
        .map((item) => item[1] ?? item[2]);
};

const assertIncludes = (source, token, message) =>
{
    if (!source.includes(token))
    {
        throw new Error(message);
    }
};

const extractLocaleDomains = (source) =>
{
    const match = source.match(/export const LOCALE_DOMAINS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u);
    if (!match)
    {
        throw new Error('cannot locate LOCALE_DOMAINS');
    }
    const domains = [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1]);
    if (domains.length === 0 || domains.length !== new Set(domains).size)
    {
        throw new Error('LOCALE_DOMAINS must be a non-empty exact union');
    }
    return domains;
};

const assertLocaleDomainLoaders = (source, expectedDomainList) =>
{
    const diagnostics = validateLocaleDomainLoaderMap(source, [...expectedKeys], expectedDomainList);
    if (diagnostics.length > 0)
    {
        throw new Error(`locale domain loader contract rejected: ${JSON.stringify(diagnostics)}`);
    }
};

const assertLocaleDomainFiles = async (expectedDomainList) =>
{
    const localeRoot = path.join(root, 'src/frontend/src/locales');
    // Non-catalog runtime composition lives under locales/runtime and is not a
    // locale dictionary directory.
    const allowedNonLocaleDirectories = new Set(['runtime']);
    const localeDirectories = (await readdir(localeRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !allowedNonLocaleDirectories.has(name));
    assertExactKeys('locale domain directories', localeDirectories);
    for (const locale of localeDirectories)
    {
        const files = (await readdir(path.join(localeRoot, locale), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
            .map((entry) => entry.name.slice(0, -3));
        const actual = new Set(files);
        const missing = expectedDomainList.filter((domain) => !actual.has(domain));
        const extra = files.filter((domain) => !expectedDomainList.includes(domain));
        if (missing.length || extra.length || files.length !== expectedDomainList.length)
        {
            throw new Error(`locale domain file drift for ${locale}: missing=[${missing}] extra=[${extra}]`);
        }
        for (const domain of expectedDomainList)
        {
            const source = await readFile(path.join(localeRoot, locale, `${domain}.ts`), 'utf8');
            const expectedIdentity =
                `export const localeDomainIdentity = Object.freeze({ locale: '${locale}', domain: '${domain}' } as const)`;
            if (!source.includes(expectedIdentity))
            {
                throw new Error(`locale domain module identity drift: ${locale}/${domain}`);
            }
        }
    }
};

const productionLocaleAssertionFiles = async (directory) =>
{
    const entries = await readdir(directory, { withFileTypes: true });
    const children = await Promise.all(entries.map(async (entry) =>
    {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            return productionLocaleAssertionFiles(target);
        }
        return /\.(?:ts|tsx|vue)$/u.test(entry.name) ? [target] : [];
    }));
    return children.flat();
};

const assertNoForcedSupportedLocale = async () =>
{
    for (const file of await productionLocaleAssertionFiles(path.join(root, 'src/frontend/src')))
    {
        if (/\bas\s+(?:Readonly<)?SupportedLocale\b/u.test(await readFile(file, 'utf8')))
        {
            throw new Error(`production locale assertion bypass: ${path.relative(root, file)}`);
        }
    }
};

export async function checkLocaleCatalog()
{
    execFileSync('node', ['tools/contracts/generate-locale-catalog.mjs', '--check'], { cwd: root, stdio: 'inherit' });
    const [loaders, domains, fonts, runtime, metadata, serverFonts, serverAot, keys, fontPort, nonCritical] = await Promise.all([
        readFile(path.join(root, 'src/frontend/src/locales/localeDomainBundleStore.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/locales/localeDomains.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/locales/localeFontCatalog.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/locales/index.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/locales/documentMetadata.ts'), 'utf8'),
        readFile(path.join(root, 'src/backend/Infrastructure/Fonts/FontLoadingPlanner.cs'), 'utf8'),
        readFile(path.join(root, 'src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/locales/keys.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/bootstrap/fontPreparationPort.ts'), 'utf8'),
        readFile(path.join(root, 'src/frontend/src/bootstrap/nonCriticalResources.ts'), 'utf8')
    ]);
    const expectedDomainList = extractLocaleDomains(domains);
    assertLocaleDomainLoaders(loaders, expectedDomainList);
    await assertLocaleDomainFiles(expectedDomainList);
    assertExactKeys('locale font mapping', extractObjectKeys(fonts, 'LOCALE_FONT_CATALOG'));
    if (fonts.includes("'zh-TW'") || fonts.includes('"zh-TW"') || fonts.includes('zh-TW:'))
    {
        throw new Error('locale font catalog must not declare zh-TW');
    }
    for (const [locale, script, family] of [
        ['zh-CN', 'Hans', 'Noto Sans SC'],
        ['zh-Hant', 'Hant', 'Noto Sans TC'],
        ['ja-JP', 'Jpan', 'Noto Sans JP'],
        ['ko-KR', 'Kore', 'Noto Sans KR'],
        ['en-US', 'Latn', 'Google Sans'],
        ['ru-RU', 'Cyrl', 'Google Sans']
    ])
    {
        assertIncludes(fonts, `"locale": "${locale}"`, `locale font catalog missing ${locale}`);
        assertIncludes(fonts, `"script": "${script}"`, `locale font catalog ${locale} must use script ${script}`);
        assertIncludes(fonts, `"family": "${family}"`, `locale font catalog ${locale} must use family ${family}`);
    }
    assertIncludes(fontPort, 'prepareLocaleFonts', 'fontPreparationPort must expose prepareLocaleFonts');
    assertIncludes(fontPort, 'peekPreparedLocaleFonts', 'fontPreparationPort must expose peekPreparedLocaleFonts');
    if (/from\s+['"]@\/locales(?:\/index)?['"]/u.test(fontPort) || /prepareLocaleDomains|syncLocaleDocumentMetadata|vue-router|localStorage|sessionStorage/u.test(fontPort))
    {
        throw new Error('fontPreparationPort must remain independent of locale runtime, router, vue, and storage');
    }
    if (/fsus:font-loading-evidence|BUNDLED_FONT_LOADING_PLAN|loadBundledFonts|LOCALE_FACES|trigger\s*[:=]\s*['"]idle['"]/u.test(`${fontPort}\n${nonCritical}\n${fonts}`))
    {
        throw new Error('legacy font planner / idle full-locale preload / CustomEvent evidence surfaces must remain deleted');
    }
    if (/prepareLocaleFonts|hans\.css|hant\.css|jpan\.css|kore\.css/u.test(nonCritical))
    {
        throw new Error('nonCriticalResources idle path must not prepare locale CJK fonts');
    }
    assertIncludes(runtime, "export { ENABLED_LOCALES } from './localeCatalog'", 'locale selector inventory must project catalog enabled locales');
    if (/from\s+['"]\.\/zh-CN\//u.test(runtime))
    {
        throw new Error('locale runtime must not statically import zh-CN initial domains');
    }
    assertIncludes(serverAot, 'resolvedLocale.DocumentLanguage', 'server document language must consume resolved generated catalog metadata');
    assertIncludes(serverAot, 'resolvedLocale.OpenGraphLocale', 'server OpenGraph locale must consume resolved generated catalog metadata');
    assertIncludes(metadata, 'descriptor.openGraphLocale', 'document metadata must consume descriptor OpenGraph locale');
    if (/\.replace\s*\(/u.test(metadata))
    {
        throw new Error('documentMetadata must not derive OpenGraph locale by string replacement');
    }
    assertIncludes(serverFonts, 'LocaleCatalog.Enabled.ToDictionary(', 'server font mapping must project the generated enabled inventory');
    if (/\["(?:zh-CN|en-US|zh-Hant|ja-JP|ko-KR|es-419|fr-FR|de-DE|pt-BR|ru-RU)"\]/u.test(serverFonts))
    {
        throw new Error('server font mapping must not maintain a second locale inventory');
    }
    const traditional = catalog.locales.find((locale) => locale.code === 'zh-Hant');
    if (!traditional || traditional.openGraphLocale !== 'zh_TW' || traditional.code === 'zh-TW')
    {
        throw new Error('zh-Hant must remain distinct from OpenGraph zh_TW metadata');
    }
    const forbidden = [
        ['LOCALE', 'REGISTRY'].join('_'), ['REGISTRY', 'BY', 'CODE'].join('_'), ['ACTIVE', 'LOCALES'].join('_'),
        ['AVAILABLE', 'LOCALES'].join('_'), ['cast', 'Supported'].join(''), ['Deep', 'LocaleShape'].join(''),
        ['TranslationKey', 'string'].join(' = '), ['LocaleMessages', 'Record<string, unknown>'].join(' = '),
        ['Plural', 'Message'].join(''), ['isPlural', 'Message'].join(''), ['translate', 'Unsafe'].join(''),
        ['domains', 'ByLocale'].join('')
    ];
    const haystack = `${loaders}\n${runtime}\n${metadata}\n${keys}`;
    for (const token of forbidden)
    {
        if (haystack.includes(token))
        {
            throw new Error(`forbidden legacy locale surface: ${token}`);
        }
    }
    await assertNoForcedSupportedLocale();
}

await checkLocaleCatalog();
console.log('[locale-catalog] consumer projections are in sync');
