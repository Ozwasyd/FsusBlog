#!/usr/bin/env node
/**
 * Deterministic plural-sensitive inventory gate (#1535).
 *
 * Inventory is derived only from the zh-CN locale schema (plural leaves + any
 * remaining ordinary quantity placeholders) and production consumers under
 * src/frontend/src. Hand-written inventories and dual-key/compat paths fail.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localesRoot = path.join(root, 'src/frontend/src/locales');
const domains = [
    'common',
    'public',
    'article',
    'auth',
    'identity',
    'layout',
    'messages',
    'security',
    'admin',
    'errors'
];

const QUANTITY_PARAM_NAMES = new Set(['count', 'n', 'total', 'remaining', 'selected', 'unread']);
const BANNED_CONSUMER_PATTERNS = [
    { id: 'item(s)', re: /item\(s\)/u },
    { id: 'replace-{n}', re: /\.replace\(\s*['"]\{n\}['"]/u },
    { id: 'replace-{count}', re: /\.replace\(\s*['"]\{count\}['"]/u },
    { id: 'retired-wordsPrefix', re: /\bwordsPrefix\b/u },
    { id: 'retired-wordsSuffix', re: /\bwordsSuffix\b/u },
    { id: 'retired-readingMinutesPrefix', re: /\breadingMinutesPrefix\b/u },
    { id: 'retired-readingMinutesSuffix', re: /\breadingMinutesSuffix\b/u },
    { id: 'retired-viewsUnit', re: /\bviewsUnit\b/u },
    { id: 'retired-activeCountPrefix', re: /\bactiveCountPrefix\b/u }
];

const REQUIRED_PLURAL_KEYS = [
    'public.archive.publishedCount',
    'identity.overview.passkeyDeviceCount',
    'identity.sessions.activeCount',
    'messages.conversationList.showMoreLabel',
    'article.metadata.wordCount',
    'article.metadata.readingMinuteCount',
    'layout.recommendations.viewCount'
];

function extractInterpolationParams(message)
{
    const matches = message.match(/\{([A-Za-z][A-Za-z0-9]*)\}/gu);
    if (!matches)
    {
        return [];
    }
    return Array.from(new Set(matches.map((match) => match.slice(1, -1)))).sort();
}

function stripLineComments(source)
{
    return source.replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * Lightweight structural walk of a locale domain object literal.
 * Expects the production style used by zh-CN domain modules.
 */
function parseDomainLeaves(source, domain)
{
    const bodyMatch = source.match(/export const \w+\s*=\s*(\{[\s\S]*\})\s*as const/u);
    if (!bodyMatch)
    {
        throw new Error(`cannot locate domain object for ${domain}`);
    }
    const body = stripLineComments(bodyMatch[1]);

    const leaves = [];
    const stack = [];
    let i = 0;

    const skipWs = () =>
    {
        while (i < body.length && /\s/u.test(body[i]))
        {
            i += 1;
        }
    };

    const readString = () =>
    {
        const quote = body[i];
        if (quote !== "'" && quote !== '"')
        {
            throw new Error(`expected string at ${domain}:${i}`);
        }
        i += 1;
        let out = '';
        while (i < body.length)
        {
            const ch = body[i];
            if (ch === '\\')
            {
                out += body[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (ch === quote)
            {
                i += 1;
                return out;
            }
            out += ch;
            i += 1;
        }
        throw new Error(`unterminated string in ${domain}`);
    };

    const readIdent = () =>
    {
        skipWs();
        const start = i;
        if (!/[A-Za-z_]/.test(body[i] ?? ''))
        {
            return null;
        }
        i += 1;
        while (/[A-Za-z0-9_]/.test(body[i] ?? ''))
        {
            i += 1;
        }
        return body.slice(start, i);
    };

    const parseValue = (pathSegments) =>
    {
        skipWs();
        if (body[i] === "'" || body[i] === '"')
        {
            const value = readString();
            leaves.push({ path: pathSegments.join('.'), kind: 'string', value });
            return;
        }
        if (body[i] !== '{')
        {
            throw new Error(`expected object/string at ${pathSegments.join('.')} in ${domain}`);
        }
        i += 1; // {
        skipWs();

        // Detect plural node: { kind: 'plural', forms: { ... } }
        const snapshot = i;
        const firstKey = readIdent();
        skipWs();
        if (firstKey === 'kind' && body[i] === ':')
        {
            i += 1;
            skipWs();
            const kindValue = readString();
            if (kindValue === 'plural')
            {
                skipWs();
                if (body[i] === ',')
                {
                    i += 1;
                }
                skipWs();
                const formsKey = readIdent();
                if (formsKey !== 'forms')
                {
                    throw new Error(`plural node missing forms at ${pathSegments.join('.')}`);
                }
                skipWs();
                if (body[i] !== ':')
                {
                    throw new Error(`plural forms missing colon at ${pathSegments.join('.')}`);
                }
                i += 1;
                skipWs();
                if (body[i] !== '{')
                {
                    throw new Error(`plural forms missing object at ${pathSegments.join('.')}`);
                }
                i += 1;
                const forms = {};
                while (true)
                {
                    skipWs();
                    if (body[i] === '}')
                    {
                        i += 1;
                        break;
                    }
                    const category = readIdent();
                    if (!category)
                    {
                        throw new Error(`invalid plural category at ${pathSegments.join('.')}`);
                    }
                    skipWs();
                    if (body[i] !== ':')
                    {
                        throw new Error(`plural category missing colon at ${pathSegments.join('.')}`);
                    }
                    i += 1;
                    skipWs();
                    forms[category] = readString();
                    skipWs();
                    if (body[i] === ',')
                    {
                        i += 1;
                    }
                }
                skipWs();
                if (body[i] === '}')
                {
                    i += 1;
                }
                leaves.push({ path: pathSegments.join('.'), kind: 'plural', forms });
                return;
            }
            // Not a plural kind — fall through is unsupported for production locale trees.
            throw new Error(`unsupported object starting with kind=${kindValue} at ${pathSegments.join('.')}`);
        }

        // Nested ordinary object: rewound first key parse.
        i = snapshot;
        while (true)
        {
            skipWs();
            if (body[i] === '}')
            {
                i += 1;
                break;
            }
            if (body[i] === ',')
            {
                i += 1;
                continue;
            }
            const key = readIdent();
            if (!key)
            {
                throw new Error(`invalid object key near ${pathSegments.join('.')} in ${domain}`);
            }
            skipWs();
            if (body[i] !== ':')
            {
                throw new Error(`missing colon after ${[...pathSegments, key].join('.')}`);
            }
            i += 1;
            parseValue([...pathSegments, key]);
            skipWs();
            if (body[i] === ',')
            {
                i += 1;
            }
        }
    };

    skipWs();
    if (body[i] !== '{')
    {
        throw new Error(`domain root must be object: ${domain}`);
    }
    // parse root by consuming keys under domain prefix
    i += 1;
    while (true)
    {
        skipWs();
        if (body[i] === '}')
        {
            i += 1;
            break;
        }
        if (body[i] === ',')
        {
            i += 1;
            continue;
        }
        const key = readIdent();
        if (!key)
        {
            throw new Error(`invalid root key in ${domain}`);
        }
        skipWs();
        if (body[i] !== ':')
        {
            throw new Error(`missing colon after ${domain}.${key}`);
        }
        i += 1;
        parseValue([domain, key]);
        skipWs();
        if (body[i] === ',')
        {
            i += 1;
        }
    }

    void stack;
    return leaves;
}

function inventorySemantic(key)
{
    if (key.includes('publishedCount'))
    {
        return 'archive published article total';
    }
    if (key.includes('passkeyDeviceCount'))
    {
        return 'registered passkey credential devices';
    }
    if (key.includes('activeCount'))
    {
        return 'active device sessions';
    }
    if (key.includes('showMoreLabel'))
    {
        return 'hidden conversation remainder';
    }
    if (key.includes('wordCount'))
    {
        return 'article body word/character count';
    }
    if (key.includes('readingMinuteCount'))
    {
        return 'estimated reading minutes';
    }
    if (key.includes('viewCount'))
    {
        return 'article open/view count';
    }
    return 'quantity copy';
}

function listConsumerFiles()
{
    return execFileSync('git', ['ls-files', 'src/frontend/src'], {
        cwd: root,
        encoding: 'utf8'
    })
        .split('\n')
        .filter(Boolean)
        .filter((file) => /\.(?:vue|[cm]?[jt]sx?)$/u.test(file))
        .filter((file) => !file.startsWith('src/frontend/src/locales/'));
}

function collectTranslatePluralCalls(source)
{
    const keys = new Set();
    const re = /translatePlural\(\s*['"]([^'"]+)['"]/gu;
    let match;
    while ((match = re.exec(source)) !== null)
    {
        keys.add(match[1]);
    }
    return keys;
}

function buildInventory()
{
    const pluralKeys = [];
    const ordinaryQuantityKeys = [];

    for (const domain of domains)
    {
        const file = path.join(localesRoot, 'zh-CN', `${domain}.ts`);
        const source = readFileSync(file, 'utf8');
        const leaves = parseDomainLeaves(source, domain);
        for (const leaf of leaves)
        {
            if (leaf.kind === 'plural')
            {
                const other = leaf.forms.other;
                if (typeof other !== 'string')
                {
                    throw new Error(`plural leaf missing other: ${leaf.path}`);
                }
                const params = extractInterpolationParams(other);
                if (!params.includes('count'))
                {
                    throw new Error(`plural leaf missing count parameter: ${leaf.path}`);
                }
                pluralKeys.push({
                    localeKey: leaf.path,
                    domain,
                    semanticMeaning: inventorySemantic(leaf.path),
                    zeroBehavior: 'render zero-category form; empty-state copy stays ordinary',
                    pluralSensitive: 'yes',
                    currentManualBranch: 'none',
                    parameters: params,
                    requiredCategoriesByLocale:
            'Intl.PluralRules(descriptor.intlLocale).resolvedOptions().pluralCategories',
                    countSource: 'runtime numeric argument to translatePlural (business source unchanged)'
                });
                continue;
            }

            const params = extractInterpolationParams(leaf.value);
            const quantityParameters = params.filter((name) => QUANTITY_PARAM_NAMES.has(name));
            if (quantityParameters.length > 0)
            {
                ordinaryQuantityKeys.push({
                    localeKey: leaf.path,
                    domain,
                    parameters: params,
                    quantityParameters,
                    pluralSensitive: 'no-or-unresolved',
                    value: leaf.value
                });
            }
        }
    }

    const consumerFiles = listConsumerFiles();
    const consumerByKey = new Map(pluralKeys.map((entry) => [entry.localeKey, []]));
    const bannedHits = [];
    const translatePluralKeysSeen = new Set();

    for (const file of consumerFiles)
    {
        const source = readFileSync(path.join(root, file), 'utf8');
        for (const key of collectTranslatePluralCalls(source))
        {
            translatePluralKeysSeen.add(key);
            if (!consumerByKey.has(key))
            {
                consumerByKey.set(key, []);
            }
            consumerByKey.get(key).push(file);
        }
        for (const pattern of BANNED_CONSUMER_PATTERNS)
        {
            if (pattern.re.test(source))
            {
                bannedHits.push({ file, pattern: pattern.id });
            }
        }
    }

    const inventory = pluralKeys
        .map((entry) => ({
            ...entry,
            consumerFiles: [...new Set(consumerByKey.get(entry.localeKey) ?? [])].sort()
        }))
        .sort((left, right) => left.localeKey.localeCompare(right.localeKey));

    return { inventory, ordinaryQuantityKeys, bannedHits, translatePluralKeysSeen };
}

function fail(message)
{
    console.error(`[plural-consumer-inventory] ${message}`);
    process.exitCode = 1;
}

function main()
{
    const checkOnly = process.argv.includes('--check');
    const { inventory, ordinaryQuantityKeys, bannedHits, translatePluralKeysSeen } = buildInventory();

    const reportDir = path.join(root, '.tmp/gate-logs');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, 'plural-consumer-inventory.json');
    writeFileSync(
        reportPath,
        `${JSON.stringify({
            generatedFrom: 'zh-CN schema + src/frontend/src consumers',
            pluralKeyCount: inventory.length,
            inventory,
            ordinaryQuantityKeys,
            bannedHits
        }, null, 2)}\n`
    );

    for (const entry of ordinaryQuantityKeys)
    {
        fail(
            `ordinary quantity key must migrate to plural node or drop quantity placeholder: ${entry.localeKey} params=[${entry.quantityParameters.join(',')}]`
        );
    }

    for (const entry of inventory)
    {
        if (entry.consumerFiles.length === 0)
        {
            fail(`plural key has no translatePlural consumer: ${entry.localeKey}`);
        }
    }

    for (const key of translatePluralKeysSeen)
    {
        if (!inventory.some((entry) => entry.localeKey === key))
        {
            fail(`translatePlural consumer references unknown/non-plural key: ${key}`);
        }
    }

    for (const hit of bannedHits)
    {
        fail(`banned quantity grammar pattern ${hit.pattern} in ${hit.file}`);
    }

    for (const key of REQUIRED_PLURAL_KEYS)
    {
        if (!inventory.some((entry) => entry.localeKey === key))
        {
            fail(`required inventory key missing: ${key}`);
        }
    }

    if (process.exitCode && process.exitCode !== 0)
    {
        console.error(`[plural-consumer-inventory] failed; report=${path.relative(root, reportPath)}`);
        return;
    }

    console.log(
        `[plural-consumer-inventory] ok keys=${inventory.length} report=${path.relative(root, reportPath)}`
    );
    if (!checkOnly)
    {
        for (const entry of inventory)
        {
            console.log(`- ${entry.localeKey} consumers=${entry.consumerFiles.join(',')}`);
        }
    }
}

main();
