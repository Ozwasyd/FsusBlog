#!/usr/bin/env node
/**
 * Fail-closed static gate for catalog × LocaleDomain artifacts (#1537).
 *
 * Check set is derived only from:
 *   locale-catalog.json enabled locales × LOCALE_DOMAINS union
 * Never from directory globs or a second handwritten locale inventory.
 *
 * Each failure prints structured fields:
 *   locale domain key source file rule expected actual
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localesRoot = path.join(root, 'src/frontend/src/locales');
const catalogPath = path.join(root, 'src/shared/Contracts/Localization/locale-catalog.json');
const domainsPath = path.join(localesRoot, 'localeDomains.ts');
const loadersPath = path.join(localesRoot, 'localeDomainBundleStore.ts');
const routeDomainsPath = path.join(localesRoot, 'routeLocaleDomains.ts');
const keysPath = path.join(localesRoot, 'keys.ts');
const globalLoaderPath = path.join(root, 'src/frontend/src/bootstrap/globalLoaderCopy.ts');
const DEFAULT_SCHEMA_LOCALE = 'zh-CN';

const EXPORT_NAMES = Object.freeze({
    common: 'common',
    public: 'publicMessages',
    article: 'article',
    auth: 'auth',
    identity: 'identity',
    layout: 'layout',
    messages: 'messages',
    security: 'security',
    admin: 'admin',
    errors: 'errors'
});

const FORBIDDEN_PLACEHOLDER_SUBSTRINGS = Object.freeze([
    'TODO_TRANSLATE',
    'TODO',
    'TBD',
    'Translation pending',
    '__FSUSBLOG_TRANSLATION_PENDING__:'
]);

const FORBIDDEN_LEGACY_TOKENS = Object.freeze([
    'DeepStringShape',
    'DeepLocaleShape',
    'BOOTSTRAP_BUNDLES',
    'getLocaleMessages',
    'SKIP_I18N_GATE',
    'skipLocale',
    'localeAllowlist',
    'warningOnlyLocale',
    'TranslationKey = string',
    'LocaleMessages = Record<string, unknown>'
]);

const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

/** @typedef {{ locale: string, domain: string, key: string, file: string, rule: string, expected: string, actual: string }} Diagnostic */

/**
 * @param {Partial<Diagnostic> & Pick<Diagnostic, 'rule' | 'expected' | 'actual'>} fields
 * @returns {Diagnostic}
 */
export function diagnostic(fields)
{
    return {
        locale: fields.locale ?? '',
        domain: fields.domain ?? '',
        key: fields.key ?? '',
        file: fields.file ?? '',
        rule: fields.rule,
        expected: fields.expected,
        actual: fields.actual
    };
}

/**
 * @param {Diagnostic} item
 */
export function formatDiagnostic(item)
{
    return [
        `locale=${item.locale || '-'}`,
        `domain=${item.domain || '-'}`,
        `key=${item.key || '<root>'}`,
        `source file=${item.file || '-'}`,
        `rule=${item.rule}`,
        `expected=${item.expected}`,
        `actual=${item.actual}`
    ].join(' ');
}

export function extractInterpolationParams(message)
{
    const matches = String(message).match(/\{([A-Za-z][A-Za-z0-9]*)\}/gu);
    if (!matches)
    {
        return [];
    }
    return Array.from(new Set(matches.map((match) => match.slice(1, -1)))).sort();
}

function sameParameters(left, right)
{
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stripLineComments(source)
{
    return source.replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * Parse a locale domain module object literal into a nested tree.
 * Supports ordinary string leaves and discriminated plural nodes.
 * @param {string} source
 * @param {string} exportName
 */
export function parseDomainTree(source, exportName)
{
    const bodyMatch = source.match(
        new RegExp(`export const ${exportName}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*as const`, 'u')
    );
    if (!bodyMatch)
    {
        throw new Error(`cannot locate export object for ${exportName}`);
    }
    const body = stripLineComments(bodyMatch[1]);
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
            throw new Error(`expected string at ${i}`);
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
        throw new Error('unterminated string');
    };

    const readIdent = () =>
    {
        skipWs();
        const start = i;
        if (!/[A-Za-z_]/u.test(body[i] ?? ''))
        {
            return null;
        }
        i += 1;
        while (/[A-Za-z0-9_]/u.test(body[i] ?? ''))
        {
            i += 1;
        }
        return body.slice(start, i);
    };

    const parseValue = () =>
    {
        skipWs();
        if (body[i] === "'" || body[i] === '"')
        {
            return { kind: 'string', value: readString() };
        }
        if (body[i] !== '{')
        {
            throw new Error(`expected object/string at ${i}`);
        }
        i += 1;
        skipWs();

        const snapshot = i;
        const firstKey = readIdent();
        skipWs();
        if (firstKey === 'kind' && body[i] === ':')
        {
            i += 1;
            skipWs();
            const kindValue = readString();
            if (kindValue !== 'plural')
            {
                throw new Error(`unsupported kind=${kindValue}`);
            }
            skipWs();
            if (body[i] === ',')
            {
                i += 1;
            }
            skipWs();
            const formsKey = readIdent();
            if (formsKey !== 'forms')
            {
                throw new Error('plural node missing forms');
            }
            skipWs();
            if (body[i] !== ':')
            {
                throw new Error('plural forms missing colon');
            }
            i += 1;
            skipWs();
            if (body[i] !== '{')
            {
                throw new Error('plural forms missing object');
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
                    throw new Error('invalid plural category');
                }
                skipWs();
                if (body[i] !== ':')
                {
                    throw new Error('plural category missing colon');
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
            return { kind: 'plural', forms };
        }

        i = snapshot;
        const object = {};
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
                throw new Error('invalid object key');
            }
            skipWs();
            if (body[i] !== ':')
            {
                throw new Error(`missing colon after ${key}`);
            }
            i += 1;
            object[key] = parseValue();
            skipWs();
            if (body[i] === ',')
            {
                i += 1;
            }
        }
        return { kind: 'object', value: object };
    };

    skipWs();
    if (body[i] !== '{')
    {
        throw new Error('domain root must be object');
    }
    return parseValue();
}

/**
 * @param {string} rootDir
 */
export function loadEnabledLocales(rootDir = root)
{
    const catalog = JSON.parse(readFileSync(path.join(rootDir, 'src/shared/Contracts/Localization/locale-catalog.json'), 'utf8'));
    if (catalog.schema !== 'fsusblog.locale-catalog.v1')
    {
        throw new Error(`unsupported locale catalog schema: ${catalog.schema}`);
    }
    const locales = catalog.locales
        .filter((locale) => locale.status === 'enabled')
        .map((locale) => locale.code);
    if (locales.length === 0 || locales.length !== new Set(locales).size)
    {
        throw new Error('enabled locale catalog must be a non-empty unique list');
    }
    return Object.freeze({
        locales: Object.freeze([...locales]),
        digest: catalog.digest ?? null,
        catalog
    });
}

/**
 * @param {string} rootDir
 */
export function loadLocaleDomains(rootDir = root)
{
    const source = readFileSync(path.join(rootDir, 'src/frontend/src/locales/localeDomains.ts'), 'utf8');
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
    return Object.freeze([...domains]);
}

/**
 * Fixed check set: catalog enabled locales × LocaleDomain union.
 * @param {{ locales?: readonly string[], domains?: readonly string[], rootDir?: string }} [options]
 */
export function buildLocaleDomainArtifacts(options = {})
{
    const rootDir = options.rootDir ?? root;
    const locales = options.locales ?? loadEnabledLocales(rootDir).locales;
    const domains = options.domains ?? loadLocaleDomains(rootDir);
    return Object.freeze(
        locales.flatMap((locale) =>
            domains.map((domain) => Object.freeze({
                locale,
                domain,
                exportName: EXPORT_NAMES[domain],
                relativeFile: `src/frontend/src/locales/${locale}/${domain}.ts`,
                absoluteFile: path.join(rootDir, 'src/frontend/src/locales', locale, `${domain}.ts`)
            })))
    );
}

/**
 * @param {unknown} node
 * @param {string} key
 * @param {{ locale: string, domain: string, file: string }} context
 * @param {Diagnostic[]} errors
 * @param {unknown} [schemaNode]
 */
function validateLeafAgainstSchema(node, key, context, errors, schemaNode)
{
    if (!node || typeof node !== 'object')
    {
        errors.push(diagnostic({
            ...context,
            key,
            rule: 'node-kind',
            expected: 'string|plural|object',
            actual: String(node)
        }));
        return;
    }

    if (node.kind === 'string')
    {
        const value = node.value;
        if (typeof value !== 'string')
        {
            errors.push(diagnostic({
                ...context,
                key,
                rule: 'node-kind',
                expected: 'string',
                actual: typeof value
            }));
            return;
        }
        const schemaValue = schemaNode && schemaNode.kind === 'string' ? schemaNode.value : undefined;
        if (value.length === 0 && typeof schemaValue === 'string' && schemaValue.length > 0)
        {
            errors.push(diagnostic({
                ...context,
                key,
                rule: 'non-empty-string',
                expected: 'non-empty string matching zh-CN content presence',
                actual: 'empty string'
            }));
        }
        for (const forbidden of FORBIDDEN_PLACEHOLDER_SUBSTRINGS)
        {
            if (value.includes(forbidden))
            {
                errors.push(diagnostic({
                    ...context,
                    key,
                    rule: 'placeholder-forbidden',
                    expected: 'translated non-placeholder string',
                    actual: `contains "${forbidden}"`
                }));
            }
        }
        // Unregistered source-language dump: long zh-CN Han segment copied verbatim.
        // Shared product nouns (ASCII "Recovery Key", etc.) are not dumps.
        if (
            context.locale !== DEFAULT_SCHEMA_LOCALE
      && context.locale !== 'zh-Hant'
      && typeof schemaValue === 'string'
      && schemaValue.length >= 12
      && value === schemaValue
      && /\p{Script=Han}/u.test(schemaValue)
        )
        {
            errors.push(diagnostic({
                ...context,
                key,
                rule: 'source-language-copy',
                expected: 'locale-specific translation',
                actual: 'exact zh-CN Han segment copy'
            }));
        }
        if (typeof schemaValue === 'string')
        {
            const expectedParams = extractInterpolationParams(schemaValue);
            const actualParams = extractInterpolationParams(value);
            if (!sameParameters(expectedParams, actualParams))
            {
                errors.push(diagnostic({
                    ...context,
                    key,
                    rule: 'interpolation-params',
                    expected: `[${expectedParams.join(', ')}]`,
                    actual: `[${actualParams.join(', ')}]`
                }));
            }
        }
        return;
    }

    if (node.kind === 'plural')
    {
        const expectedCategories = new Set(
            new Intl.PluralRules(context.locale).resolvedOptions().pluralCategories
        );
        const actualCategories = Object.keys(node.forms ?? {});
        for (const category of expectedCategories)
        {
            if (!Object.prototype.hasOwnProperty.call(node.forms, category))
            {
                errors.push(diagnostic({
                    ...context,
                    key,
                    rule: 'plural-category',
                    expected: `category "${category}"`,
                    actual: 'missing'
                }));
            }
        }
        for (const category of actualCategories)
        {
            if (!PLURAL_CATEGORIES.includes(category))
            {
                errors.push(diagnostic({
                    ...context,
                    key,
                    rule: 'plural-category',
                    expected: `known category in [${PLURAL_CATEGORIES.join(', ')}]`,
                    actual: category
                }));
            }
            else if (!expectedCategories.has(category))
            {
                errors.push(diagnostic({
                    ...context,
                    key,
                    rule: 'plural-category',
                    expected: `Intl categories for ${context.locale}`,
                    actual: `unexpected "${category}"`
                }));
            }
        }

        const schemaForms = schemaNode && schemaNode.kind === 'plural' ? schemaNode.forms : null;
        const schemaOther = schemaForms?.other;
        const expectedParameters = typeof schemaOther === 'string'
            ? extractInterpolationParams(schemaOther)
            : extractInterpolationParams(node.forms?.other ?? '');
        if (!expectedParameters.includes('count'))
        {
            errors.push(diagnostic({
                ...context,
                key,
                rule: 'plural-params',
                expected: 'count in interpolation parameters',
                actual: `[${expectedParameters.join(', ')}]`
            }));
        }
        for (const [category, value] of Object.entries(node.forms ?? {}))
        {
            if (typeof value !== 'string')
            {
                errors.push(diagnostic({
                    ...context,
                    key: `${key}.forms.${category}`,
                    rule: 'node-kind',
                    expected: 'string',
                    actual: typeof value
                }));
                continue;
            }
            if (value.length === 0)
            {
                errors.push(diagnostic({
                    ...context,
                    key: `${key}.forms.${category}`,
                    rule: 'non-empty-string',
                    expected: 'non-empty string',
                    actual: 'empty string'
                }));
            }
            for (const forbidden of FORBIDDEN_PLACEHOLDER_SUBSTRINGS)
            {
                if (value.includes(forbidden))
                {
                    errors.push(diagnostic({
                        ...context,
                        key: `${key}.forms.${category}`,
                        rule: 'placeholder-forbidden',
                        expected: 'translated non-placeholder string',
                        actual: `contains "${forbidden}"`
                    }));
                }
            }
            const parameters = extractInterpolationParams(value);
            if (!sameParameters(parameters, expectedParameters))
            {
                errors.push(diagnostic({
                    ...context,
                    key: `${key}.forms.${category}`,
                    rule: 'plural-params',
                    expected: `[${expectedParameters.join(', ')}]`,
                    actual: `[${parameters.join(', ')}]`
                }));
            }
        }
        return;
    }

    if (node.kind === 'object')
    {
        const schemaObject = schemaNode && schemaNode.kind === 'object' ? schemaNode.value : null;
        const actualKeys = new Set(Object.keys(node.value ?? {}));
        const schemaKeys = schemaObject ? new Set(Object.keys(schemaObject)) : actualKeys;
        for (const childKey of schemaKeys)
        {
            const childPath = key ? `${key}.${childKey}` : childKey;
            if (!actualKeys.has(childKey))
            {
                errors.push(diagnostic({
                    ...context,
                    key: childPath,
                    rule: 'missing-key',
                    expected: 'present',
                    actual: 'missing'
                }));
                continue;
            }
            const schemaChild = schemaObject ? schemaObject[childKey] : undefined;
            const actualChild = node.value[childKey];
            if (schemaChild && schemaChild.kind !== actualChild.kind)
            {
                errors.push(diagnostic({
                    ...context,
                    key: childPath,
                    rule: 'node-kind',
                    expected: schemaChild.kind,
                    actual: actualChild.kind
                }));
                continue;
            }
            validateLeafAgainstSchema(actualChild, childPath, context, errors, schemaChild);
        }
        for (const childKey of actualKeys)
        {
            if (!schemaKeys.has(childKey))
            {
                errors.push(diagnostic({
                    ...context,
                    key: key ? `${key}.${childKey}` : childKey,
                    rule: 'extra-key',
                    expected: 'absent',
                    actual: 'present'
                }));
            }
        }
    }
}

/**
 * Validate one domain artifact tree against the zh-CN schema domain tree.
 * @param {unknown} schemaTree
 * @param {unknown} candidateTree
 * @param {{ locale: string, domain: string, file: string }} context
 */
export function validateDomainArtifact(schemaTree, candidateTree, context)
{
    /** @type {Diagnostic[]} */
    const errors = [];
    if (!schemaTree || schemaTree.kind !== 'object')
    {
        errors.push(diagnostic({
            ...context,
            key: '',
            rule: 'schema-root',
            expected: 'object',
            actual: String(schemaTree?.kind ?? schemaTree)
        }));
        return errors;
    }
    if (!candidateTree || candidateTree.kind !== 'object')
    {
        errors.push(diagnostic({
            ...context,
            key: '',
            rule: 'node-kind',
            expected: 'object',
            actual: String(candidateTree?.kind ?? candidateTree)
        }));
        return errors;
    }
    validateLeafAgainstSchema(candidateTree, '', context, errors, schemaTree);
    return errors;
}

/**
 * @param {string} source
 * @param {string} locale
 * @param {string} domain
 * @param {string} file
 * @param {Diagnostic[]} errors
 */
function assertModuleIdentity(source, locale, domain, file, errors)
{
    const expectedIdentity =
        `export const localeDomainIdentity = Object.freeze({ locale: '${locale}', domain: '${domain}' } as const)`;
    if (!source.includes(expectedIdentity))
    {
        const identityMatch = source.match(
            /export const localeDomainIdentity = Object\.freeze\(\{\s*locale:\s*'([^']+)',\s*domain:\s*'([^']+)'/
        );
        errors.push(diagnostic({
            locale,
            domain,
            key: 'localeDomainIdentity',
            file,
            rule: 'module-identity',
            expected: `${locale}/${domain}`,
            actual: identityMatch
                ? `${identityMatch[1]}/${identityMatch[2]}`
                : 'missing or malformed localeDomainIdentity'
        }));
    }

    const exportName = EXPORT_NAMES[domain];
    if (!exportName || !new RegExp(`export const ${exportName}\\s*=`, 'u').test(source))
    {
        errors.push(diagnostic({
            locale,
            domain,
            key: exportName ?? '<export>',
            file,
            rule: 'export-identity',
            expected: `export const ${exportName}`,
            actual: 'missing export'
        }));
    }

    if (locale !== DEFAULT_SCHEMA_LOCALE)
    {
        const valueImport = source.match(
            /^\s*import\s+(?!type\b)[^;]*from\s+['"]\.\.\/zh-CN\/[^'"]+['"]/mu
        );
        if (valueImport)
        {
            errors.push(diagnostic({
                locale,
                domain,
                key: '<import>',
                file,
                rule: 'type-only-schema-import',
                expected: 'import type from zh-CN schema domain',
                actual: valueImport[0].trim()
            }));
        }
        if (!/import\s+type\s+\{[^}]+\}\s+from\s+['"]\.\.\/zh-CN\//u.test(source))
        {
            errors.push(diagnostic({
                locale,
                domain,
                key: '<import>',
                file,
                rule: 'type-only-schema-import',
                expected: 'import type { ... } from ../zh-CN/<domain>',
                actual: 'missing type-only schema import'
            }));
        }
    }
}

/**
 * @param {string} rootDir
 * @param {readonly string[]} locales
 * @param {readonly string[]} domains
 * @param {Diagnostic[]} errors
 */
function assertLoaderMap(rootDir, locales, domains, errors)
{
    const source = readFileSync(path.join(rootDir, 'src/frontend/src/locales/localeDomainBundleStore.ts'), 'utf8');
    errors.push(...validateLocaleDomainLoaderMap(source, locales, domains));
}

// A lexical/structural parser for the closed loader declaration grammar, not a
// line/indentation matcher. Keep property lists (rather than objects) so duplicate
// keys remain observable. Never evaluate the TypeScript or install a parser to
// run this prebuild admission check.
function tokenizeLoaderSource(source)
{
    const tokens = [];
    let i = 0;
    const emit = (kind, value, start) => tokens.push({ kind, value, start });
    const scan = (closing = '') =>
    {
        while (i < source.length)
        {
            const start = i;
            const ch = source[i];
            if (/\s/u.test(ch))
            {
                i += 1;
                continue;
            }
            if (source.startsWith('//', i))
            {
                while (i < source.length && !/[\r\n]/u.test(source[i]))
                {
                    i += 1;
                }
                continue;
            }
            if (source.startsWith('/*', i))
            {
                const end = source.indexOf('*/', i + 2);
                if (end < 0)
                {
                    throw new Error(`unterminated comment at ${i}`);
                }
                i = end + 2;
                continue;
            }
            if (ch === "'" || ch === '"')
            {
                i += 1;
                let value = '';
                while (i < source.length && source[i] !== ch)
                {
                    if (/[\r\n]/u.test(source[i]))
                    {
                        throw new Error(`newline in string at ${i}`);
                    }
                    if (source[i] !== '\\')
                    {
                        value += source[i++];
                        continue;
                    }
                    i += 1;
                    const escape = source[i++];
                    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
                    if (escape === 'u' || escape === 'x')
                    {
                        const width = escape === 'u' ? 4 : 2;
                        const hex = source.slice(i, i + width);
                        if (hex.length !== width || !/^[\da-f]+$/iu.test(hex))
                        {
                            throw new Error(`unsupported string escape at ${i}`);
                        }
                        value += String.fromCharCode(Number.parseInt(hex, 16));
                        i += width;
                    }
                    else if (escape === '\n' || escape === '\r')
                    {
                        if (escape === '\r' && source[i] === '\n')
                        {
                            i += 1;
                        }
                    }
                    else
                    {
                        value += simple[escape] ?? escape;
                    }
                }
                if (source[i] !== ch)
                {
                    throw new Error(`unterminated string at ${start}`);
                }
                i += 1;
                emit('string', value, start);
                continue;
            }
            if (ch === '`')
            {
                // Template text is not code. Its interpolations are, including
                // any extra import calls hidden outside the registry.
                emit('template', '`', i++);
                while (i < source.length && source[i] !== '`')
                {
                    if (source[i] === '\\')
                    {
                        i += 2;
                    }
                    else if (source.startsWith('${', i))
                    {
                        emit('template', '${', i);
                        i += 2;
                        scan('}');
                    }
                    else
                    {
                        i += 1;
                    }
                }
                if (source[i] !== '`')
                {
                    throw new Error(`unterminated template at ${start}`);
                }
                emit('template', '`', i++);
                continue;
            }
            if (/[A-Za-z_$]/u.test(ch))
            {
                i += 1;
                while (/[A-Za-z0-9_$]/u.test(source[i] ?? ''))
                {
                    i += 1;
                }
                emit('identifier', source.slice(start, i), start);
                continue;
            }
            const punctuation = source.startsWith('=>', i) ? '=>' : ch;
            i += punctuation.length;
            emit('punctuation', punctuation, start);
            if (ch === closing)
            {
                return;
            }
            if ('([{'.includes(ch))
            {
                scan({ '(': ')', '[': ']', '{': '}' }[ch]);
            }
            else if (')]}'.includes(ch))
            {
                throw new Error(`unmatched ${ch} at ${start}`);
            }
        }
        if (closing)
        {
            throw new Error(`missing ${closing}`);
        }
    };
    scan();
    return tokens;
}

/** Validate the one authoritative loader registry, including all import calls. */
export function validateLocaleDomainLoaderMap(source, locales, domains)
{
    const errors = [];
    const file = 'src/frontend/src/locales/localeDomainBundleStore.ts';
    const report = (rule, expected, actual, locale = '', domain = '') =>
        errors.push(diagnostic({ file, rule, expected, actual, locale, domain }));
    try
    {
        const tokens = tokenizeLoaderSource(source);
        const is = (index, value) => tokens[index]?.value === value && tokens[index]?.kind !== 'string';
        const declarations = tokens.flatMap((token, index) =>
            token.kind === 'identifier' && token.value === 'LOCALE_DOMAIN_LOADERS'
                && is(index - 1, 'const') && is(index - 2, 'export') ? [index] : []);
        if (declarations.length !== 1)
        {
            throw new Error(`expected one exported registry, found ${declarations.length}`);
        }
        let cursor = declarations[0] + 1;
        if (!is(cursor, ':') && !is(cursor, '='))
        {
            throw new Error('expected type annotation or registry initializer');
        }
        // Skip the optional type annotation structurally; '=' inside a nested
        // object/function type is not the declaration initializer.
        const typeClosers = [];
        while (cursor < tokens.length && !(typeClosers.length === 0 && is(cursor, '=')))
        {
            const value = tokens[cursor++].value;
            if (['(', '[', '{', '<'].includes(value))
            {
                typeClosers.push({ '(': ')', '[': ']', '{': '}', '<': '>' }[value]);
            }
            else if (value === typeClosers.at(-1))
            {
                typeClosers.pop();
            }
            else if (value === ';' && typeClosers.length === 0)
            {
                throw new Error('registry initializer missing');
            }
        }
        const take = (value) =>
        {
            if (!is(cursor, value))
            {
                throw new Error(`expected ${value} at token ${cursor}`);
            }
            cursor += 1;
        };
        const parseList = (closing, parseItem) =>
        {
            const items = [];
            while (!is(cursor, closing))
            {
                items.push(parseItem());
                if (!is(cursor, closing))
                {
                    take(',');
                }
            }
            take(closing);
            return items;
        };
        const parseExpression = () =>
        {
            const token = tokens[cursor++];
            if (!token)
            {
                throw new Error('unexpected end of registry');
            }
            if (token.kind === 'string')
            {
                return { kind: 'string', value: token.value };
            }
            if (token.value === '(')
            {
                if (is(cursor, ')'))
                {
                    take(')');
                    take('=>');
                    return { kind: 'arrow', body: parseExpression() };
                }
                const expression = parseExpression();
                take(')');
                return expression;
            }
            if (token.value === '{')
            {
                return { kind: 'object', properties: parseList('}', () =>
                {
                    const key = tokens[cursor++];
                    if (!key || !['string', 'identifier'].includes(key.kind))
                    {
                        throw new Error('expected literal property key');
                    }
                    take(':');
                    return { key: key.value, value: parseExpression() };
                }) };
            }
            if (token.kind !== 'identifier')
            {
                throw new Error(`unsupported registry expression ${token.value}`);
            }
            let name = token.value;
            while (is(cursor, '.'))
            {
                take('.');
                const member = tokens[cursor++];
                if (member?.kind !== 'identifier')
                {
                    throw new Error('expected member name');
                }
                name += `.${member.value}`;
            }
            take('(');
            return { kind: 'call', name, start: token.start, arguments: parseList(')', parseExpression) };
        };
        take('=');
        const registry = parseExpression();
        if (cursor < tokens.length && ![';', 'export', 'const', 'function', 'class'].some((value) => is(cursor, value)))
        {
            throw new Error('unsupported expression after registry initializer');
        }
        const isCall = (node, name, count) => node?.kind === 'call' && node.name === name && node.arguments.length === count;
        if (!isCall(registry, 'Object.freeze', 1) || registry.arguments[0].kind !== 'object')
        {
            throw new Error('registry must be Object.freeze of an object literal');
        }
        const exactKeys = (properties, expected, locale = '') =>
        {
            const keys = properties.map((property) => property.key);
            for (const key of expected)
            {
                if (!keys.includes(key))
                {
                    report('loader-map-keyset', 'loader entry present', 'missing', locale || key, locale ? key : '');
                }
            }
            const seen = new Set();
            for (const key of keys)
            {
                if (seen.has(key))
                {
                    report('loader-map-keyset', 'unique loader key', `duplicate ${key}`, locale || key, locale ? key : '');
                }
                if (!expected.includes(key))
                {
                    report('loader-map-keyset', 'only catalog locales / declared domains', `extra ${key}`, locale || key, locale ? key : '');
                }
                seen.add(key);
            }
        };
        const properties = registry.arguments[0].properties;
        exactKeys(properties, locales);
        const acceptedImports = new Set();
        for (const { key: locale, value: entry } of properties)
        {
            if (!isCall(entry, 'loadersFor', 2) || entry.arguments[0].kind !== 'string' || entry.arguments[1].kind !== 'object')
            {
                throw new Error(`expected loadersFor(locale, object) for ${locale}`);
            }
            if (entry.arguments[0].value !== locale)
            {
                report('loader-import-identity', locale, entry.arguments[0].value, locale);
            }
            const imports = entry.arguments[1].properties;
            exactKeys(imports, domains, locale);
            for (const { key: domain, value: importer } of imports)
            {
                const call = importer.kind === 'arrow' ? importer.body : null;
                if (!isCall(call, 'import', 1) || call.arguments[0].kind !== 'string')
                {
                    throw new Error(`expected () => import(literal) for ${locale}/${domain}`);
                }
                acceptedImports.add(call.start);
                const module = call.arguments[0].value;
                if (module !== `./${locale}/${domain}`)
                {
                    report('loader-import-identity', `${locale}/${domain}`, module, locale, domain);
                }
            }
        }
        for (let index = 0; index < tokens.length; index += 1)
        {
            if (!is(index, 'import'))
            {
                continue;
            }
            if (!is(index + 1, '('))
            {
                // Infrastructure imports (localeCatalog/localeDomains) are
                // allowed; dictionary side-effect/value/type imports are not
                // alternative owners for the closed dynamic loader map.
                let module = tokens[index + 1];
                if (module?.kind !== 'string')
                {
                    for (let end = index + 1; end < tokens.length && !is(end, ';'); end += 1)
                    {
                        if (is(end, 'from'))
                        {
                            module = tokens[end + 1];
                            break;
                        }
                    }
                }
                if (module?.kind === 'string' && /^\.\/[^/]+\//u.test(module.value))
                {
                    report('loader-import-identity', 'dictionary modules owned by declared dynamic importers', `extra static import ${module.value}`);
                }
                continue;
            }
            const module = tokens[index + 2];
            if (module?.kind === 'string' && /^\.\/[^/]+$/u.test(module.value))
            {
                report('whole-bundle-forbidden', 'per-domain dynamic import only', 'whole-locale dynamic import');
            }
            if (!acceptedImports.has(tokens[index].start))
            {
                report('loader-import-identity', 'only declared locale/domain importer calls', `extra import at ${tokens[index].start}`);
            }
        }
    }
    catch (error)
    {
        report('loader-map-keyset', 'parseable closed loader registry structure', error instanceof Error ? error.message : String(error));
    }
    return errors;
}

/**
 * @param {string} rootDir
 * @param {readonly string[]} domains
 * @param {Diagnostic[]} errors
 */
function assertRouteDomainManifest(rootDir, domains, errors)
{
    const file = 'src/frontend/src/locales/routeLocaleDomains.ts';
    const source = readFileSync(path.join(rootDir, file), 'utf8');
    const domainSet = new Set(domains);
    const referenced = new Set();
    for (const match of source.matchAll(/'([a-z]+)'/gu))
    {
        const token = match[1];
        if ([
            'common', 'public', 'article', 'auth', 'identity',
            'layout', 'messages', 'security', 'admin', 'errors',
            'future', 'unknown', 'invalid'
        ].includes(token) || domainSet.has(token))
        {
            if (domainSet.has(token))
            {
                referenced.add(token);
            }
            else if (!domainSet.has(token) && ['future', 'unknown', 'invalid'].includes(token))
            {
                errors.push(diagnostic({
                    locale: '',
                    domain: token,
                    key: '',
                    file,
                    rule: 'route-domain-exists',
                    expected: `domain in LOCALE_DOMAINS [${domains.join(', ')}]`,
                    actual: token
                }));
            }
        }
    }
    // Domain literals used as route requirements must all be known.
    for (const match of source.matchAll(/(?:append\([^)]*|DOMAINS\s*=\s*Object\.freeze\(\[[^\]]*|'([a-z]+)'(?:\s*,|\s*\]))/gu))
    {
        void match;
    }
    const domainLiterals = [...source.matchAll(/'(common|public|article|auth|identity|layout|messages|security|admin|errors|future|unknown|[a-z]+)'/gu)]
        .map((item) => item[1])
        .filter((token, index, all) => all.indexOf(token) === index);
    for (const token of domainLiterals)
    {
        if (!domainSet.has(token) && token.length > 0)
        {
            // Only flag tokens that look like domain identifiers used in domain arrays.
            if (/^[a-z]+$/u.test(token) && !['self', 'manage', 'public'].includes(token))
            {
                // 'public' is both a domain and a meta token; domainSet covers it.
            }
            if (!domainSet.has(token) && Object.values(EXPORT_NAMES).includes(token) === false)
            {
                // Route name strings and meta values are not domains; only check freezes/append lists.
            }
        }
    }

    // Precise: only tokens inside Object.freeze([...]) domain arrays and append(...) calls.
    const domainArrayBlocks = [
        ...source.matchAll(/Object\.freeze\(\[([^\]]+)\]\s*as const\)/gu),
        ...source.matchAll(/append\([^,]+((?:,\s*'[a-z]+')+)\)/gu)
    ];
    for (const block of domainArrayBlocks)
    {
        for (const match of block[1].matchAll(/'([a-z]+)'/gu))
        {
            const domain = match[1];
            if (!domainSet.has(domain))
            {
                errors.push(diagnostic({
                    locale: '',
                    domain,
                    key: '',
                    file,
                    rule: 'route-domain-exists',
                    expected: `domain in LOCALE_DOMAINS [${domains.join(', ')}]`,
                    actual: domain
                }));
            }
            else
            {
                referenced.add(domain);
            }
        }
    }
    void referenced;
}

/**
 * @param {string} rootDir
 * @param {Diagnostic[]} errors
 */
function assertDependencyBoundaries(rootDir, errors)
{
    const storeFile = 'src/frontend/src/locales/localeDomainBundleStore.ts';
    const store = readFileSync(path.join(rootDir, storeFile), 'utf8');
    for (const banned of [
        "from './runtime/",
        "from '../runtime/",
        "from '@/router",
        "from 'vue-router",
        "from 'vue'",
        'from "vue"',
        "from 'pinia",
        '@/components/'
    ])
    {
        if (store.includes(banned))
        {
            errors.push(diagnostic({
                locale: '',
                domain: '',
                key: '',
                file: storeFile,
                rule: 'bundle-store-isolation',
                expected: 'no runtime/router/component dependency',
                actual: banned
            }));
        }
    }

    const tracked = execFileSync('git', ['ls-files', 'src/frontend/src'], {
        cwd: rootDir,
        encoding: 'utf8'
    })
        .split('\n')
        .filter(Boolean)
        .filter((file) => /\.(?:vue|[cm]?[jt]sx?)$/u.test(file))
        .filter((file) => !file.startsWith('src/frontend/src/locales/'));

    const dictImport = /from\s+['"]@\/locales\/(?:zh-CN|en-US|zh-Hant|ja-JP|ko-KR|es-419|fr-FR|de-DE|pt-BR|ru-RU)\//u;
    const relativeDictImport = /from\s+['"](?:\.\.\/)+locales\/(?:zh-CN|en-US|zh-Hant|ja-JP|ko-KR|es-419|fr-FR|de-DE|pt-BR|ru-RU)\//u;
    for (const file of tracked)
    {
        const source = readFileSync(path.join(rootDir, file), 'utf8');
        if (dictImport.test(source) || relativeDictImport.test(source))
        {
            errors.push(diagnostic({
                locale: '',
                domain: '',
                key: '',
                file,
                rule: 'no-direct-dictionary-import',
                expected: 'typed translate/translatePlural or locale runtime ports',
                actual: 'direct locale dictionary module import'
            }));
        }
    }

    // Entry-reachable static imports of non-bootstrap-safe locale domain modules.
    const globalLoader = readFileSync(path.join(rootDir, 'src/frontend/src/bootstrap/globalLoaderCopy.ts'), 'utf8');
    if (/from\s+['"]@\/locales\/(?:zh-CN|en-US|zh-Hant|ja-JP|ko-KR|es-419|fr-FR|de-DE|pt-BR|ru-RU)\//u.test(globalLoader))
    {
        errors.push(diagnostic({
            locale: '',
            domain: '',
            key: '',
            file: 'src/frontend/src/bootstrap/globalLoaderCopy.ts',
            rule: 'initial-entry-locale-static',
            expected: 'no static locale domain dictionary imports from bootstrap entry graph',
            actual: 'static import of locale domain module(s)'
        }));
    }

    // Loader copy table must cover exact catalog locales and stay equal to common.loading.
    assertGlobalLoaderParity(rootDir, errors);
}

/**
 * @param {string} rootDir
 * @param {Diagnostic[]} errors
 */
function assertGlobalLoaderParity(rootDir, errors)
{
    const file = 'src/frontend/src/bootstrap/globalLoaderCopy.ts';
    const source = readFileSync(path.join(rootDir, file), 'utf8');
    const { locales } = loadEnabledLocales(rootDir);
    for (const locale of locales)
    {
        const commonSource = readFileSync(
            path.join(rootDir, 'src/frontend/src/locales', locale, 'common.ts'),
            'utf8'
        );
        const tree = parseDomainTree(commonSource, 'common');
        const status = tree.value?.loading?.value?.status?.value;
        const statusWithSite = tree.value?.loading?.value?.statusWithSite?.value;
        if (typeof status !== 'string' || typeof statusWithSite !== 'string')
        {
            errors.push(diagnostic({
                locale,
                domain: 'common',
                key: 'loading',
                file: `src/frontend/src/locales/${locale}/common.ts`,
                rule: 'global-loader-parity',
                expected: 'common.loading.status and statusWithSite strings',
                actual: 'missing loading leaves'
            }));
            continue;
        }
        const escapedStatus = status.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const escapedStatusWithSite = statusWithSite.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const localeBlock = new RegExp(
            `['"]${locale}['"]\\s*:\\s*Object\\.freeze\\(\\{[^}]*status:\\s*['"]${escapedStatus}['"][^}]*statusWithSite:\\s*['"]${escapedStatusWithSite}['"]`,
            'su'
        );
        const localeBlockAlt = new RegExp(
            `['"]${locale}['"]\\s*:\\s*Object\\.freeze\\(\\{[^}]*statusWithSite:\\s*['"]${escapedStatusWithSite}['"][^}]*status:\\s*['"]${escapedStatus}['"]`,
            'su'
        );
        if (!localeBlock.test(source) && !localeBlockAlt.test(source))
        {
            // Fallback: both string literals present next to locale key.
            const localeIndex = source.indexOf(`'${locale}'`) >= 0 ? source.indexOf(`'${locale}'`) : source.indexOf(`"${locale}"`);
            if (localeIndex < 0)
            {
                errors.push(diagnostic({
                    locale,
                    domain: 'common',
                    key: 'loading',
                    file,
                    rule: 'global-loader-parity',
                    expected: `GLOBAL_LOADER_COPY entry for ${locale}`,
                    actual: 'missing'
                }));
                continue;
            }
            const window = source.slice(localeIndex, localeIndex + 400);
            if (!window.includes(status) || !window.includes(statusWithSite))
            {
                errors.push(diagnostic({
                    locale,
                    domain: 'common',
                    key: 'loading',
                    file,
                    rule: 'global-loader-parity',
                    expected: `status=${JSON.stringify(status)}; statusWithSite=${JSON.stringify(statusWithSite)}`,
                    actual: 'bootstrap table drift vs common.loading'
                }));
            }
        }
    }
}

/**
 * @param {string} rootDir
 * @param {readonly string[]} locales
 * @param {Diagnostic[]} errors
 */
function assertDirectoryInventory(rootDir, locales, domains, errors)
{
    const localeRoot = path.join(rootDir, 'src/frontend/src/locales');
    const allowedNonLocaleDirectories = new Set(['runtime']);
    const directories = readdirSync(localeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !allowedNonLocaleDirectories.has(name));
    const expected = new Set(locales);
    for (const locale of expected)
    {
        if (!directories.includes(locale))
        {
            errors.push(diagnostic({
                locale,
                domain: '',
                key: '',
                file: `src/frontend/src/locales/${locale}`,
                rule: 'directory-inventory',
                expected: 'catalog locale directory present',
                actual: 'missing'
            }));
        }
    }
    for (const directory of directories)
    {
        if (!expected.has(directory))
        {
            errors.push(diagnostic({
                locale: directory,
                domain: '',
                key: '',
                file: `src/frontend/src/locales/${directory}`,
                rule: 'directory-inventory',
                expected: 'directory only for catalog enabled locales',
                actual: 'untracked locale directory (not in catalog)'
            }));
        }
    }

    for (const locale of locales)
    {
        for (const domain of domains)
        {
            const relative = `src/frontend/src/locales/${locale}/${domain}.ts`;
            if (!existsSync(path.join(rootDir, relative)))
            {
                errors.push(diagnostic({
                    locale,
                    domain,
                    key: '',
                    file: relative,
                    rule: 'artifact-file-exists',
                    expected: 'domain module file present',
                    actual: 'missing file'
                }));
            }
        }
    }
}

/**
 * @param {string} rootDir
 * @param {Diagnostic[]} errors
 */
function assertLegacyResidue(rootDir, errors)
{
    const targets = [
        'src/frontend/src/locales',
        'tools/frontend',
        'tools/contracts',
        'tests/frontend/unit/locales',
        'tests/tools'
    ];
    for (const relative of targets)
    {
        const absolute = path.join(rootDir, relative);
        if (!existsSync(absolute))
        {
            continue;
        }
        walkFiles(absolute, (file) =>
        {
            if (!/\.(?:[cm]?[jt]sx?|mjs|vue|md)$/u.test(file))
            {
                return;
            }
            // Allow gate owners to mention forbidden tokens only as explicit ban checks.
            const relative = path.relative(rootDir, file).replaceAll('\\', '/');
            if (
                relative === 'tools/frontend/check-locale-domain-static.mjs'
        || relative === 'tools/frontend/check-locale-domain-bundles.mjs'
        || relative === 'tests/tools/locale-domain-static.test.mjs'
            )
            {
                return;
            }
            const source = readFileSync(file, 'utf8');
            for (const token of FORBIDDEN_LEGACY_TOKENS)
            {
                if (source.includes(token))
                {
                    errors.push(diagnostic({
                        locale: '',
                        domain: '',
                        key: '',
                        file: relative,
                        rule: 'legacy-surface-forbidden',
                        expected: '0 occurrences',
                        actual: token
                    }));
                }
            }
            if (/SKIP_I18N|skip.*i18n.*gate|i18n.*allowlist/iu.test(source))
            {
                errors.push(diagnostic({
                    locale: '',
                    domain: '',
                    key: '',
                    file: relative,
                    rule: 'release-bypass-forbidden',
                    expected: 'no i18n gate skip/allowlist',
                    actual: 'skip/allowlist surface detected'
                }));
            }
        });
    }
}

/**
 * @param {string} directory
 * @param {(file: string) => void} visit
 */
function walkFiles(directory, visit)
{
    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            walkFiles(target, visit);
        }
        else
        {
            visit(target);
        }
    }
}

/**
 * @param {{ rootDir?: string }} [options]
 */
export function checkLocaleDomainStatic(options = {})
{
    const rootDir = options.rootDir ?? root;
    /** @type {Diagnostic[]} */
    const errors = [];

    const { locales } = loadEnabledLocales(rootDir);
    const domains = loadLocaleDomains(rootDir);
    const artifacts = buildLocaleDomainArtifacts({ rootDir, locales, domains });
    const expectedCount = locales.length * domains.length;
    if (artifacts.length !== expectedCount)
    {
        errors.push(diagnostic({
            locale: '',
            domain: '',
            key: '',
            file: 'src/shared/Contracts/Localization/locale-catalog.json',
            rule: 'artifact-set-size',
            expected: String(expectedCount),
            actual: String(artifacts.length)
        }));
    }

    assertDirectoryInventory(rootDir, locales, domains, errors);
    assertLoaderMap(rootDir, locales, domains, errors);
    assertRouteDomainManifest(rootDir, domains, errors);
    assertDependencyBoundaries(rootDir, errors);
    assertLegacyResidue(rootDir, errors);

    /** @type {Map<string, ReturnType<typeof parseDomainTree>>} */
    const schemaByDomain = new Map();
    for (const domain of domains)
    {
        const schemaFile = path.join(rootDir, 'src/frontend/src/locales', DEFAULT_SCHEMA_LOCALE, `${domain}.ts`);
        if (!existsSync(schemaFile))
        {
            errors.push(diagnostic({
                locale: DEFAULT_SCHEMA_LOCALE,
                domain,
                key: '',
                file: `src/frontend/src/locales/${DEFAULT_SCHEMA_LOCALE}/${domain}.ts`,
                rule: 'artifact-file-exists',
                expected: 'zh-CN schema domain present',
                actual: 'missing'
            }));
            continue;
        }
        const schemaSource = readFileSync(schemaFile, 'utf8');
        assertModuleIdentity(
            schemaSource,
            DEFAULT_SCHEMA_LOCALE,
            domain,
            `src/frontend/src/locales/${DEFAULT_SCHEMA_LOCALE}/${domain}.ts`,
            errors
        );
        try
        {
            schemaByDomain.set(domain, parseDomainTree(schemaSource, EXPORT_NAMES[domain]));
        }
        catch (error)
        {
            errors.push(diagnostic({
                locale: DEFAULT_SCHEMA_LOCALE,
                domain,
                key: '',
                file: `src/frontend/src/locales/${DEFAULT_SCHEMA_LOCALE}/${domain}.ts`,
                rule: 'parse-domain-tree',
                expected: 'parseable domain object literal',
                actual: error instanceof Error ? error.message : String(error)
            }));
        }
    }

    for (const artifact of artifacts)
    {
        if (!existsSync(artifact.absoluteFile))
        {
            // Already reported by directory inventory / file existence.
            continue;
        }
        const source = readFileSync(artifact.absoluteFile, 'utf8');
        assertModuleIdentity(source, artifact.locale, artifact.domain, artifact.relativeFile, errors);
        const schemaTree = schemaByDomain.get(artifact.domain);
        if (!schemaTree)
        {
            continue;
        }
        try
        {
            const tree = parseDomainTree(source, artifact.exportName);
            errors.push(...validateDomainArtifact(schemaTree, tree, {
                locale: artifact.locale,
                domain: artifact.domain,
                file: artifact.relativeFile
            }));
        }
        catch (error)
        {
            errors.push(diagnostic({
                locale: artifact.locale,
                domain: artifact.domain,
                key: '',
                file: artifact.relativeFile,
                rule: 'parse-domain-tree',
                expected: 'parseable domain object literal',
                actual: error instanceof Error ? error.message : String(error)
            }));
        }
    }

    // Typed consumer surface: keys.ts must keep exact TranslationKey/PluralTranslationKey exports.
    const keysSource = readFileSync(path.join(rootDir, 'src/frontend/src/locales/keys.ts'), 'utf8');
    if (!/export type TranslationKey = /u.test(keysSource) || !/export type PluralTranslationKey = /u.test(keysSource))
    {
        errors.push(diagnostic({
            locale: '',
            domain: '',
            key: '',
            file: 'src/frontend/src/locales/keys.ts',
            rule: 'typed-consumer-keys',
            expected: 'TranslationKey and PluralTranslationKey exact exports',
            actual: 'missing typed key exports'
        }));
    }
    if (/export type TranslationKey = string/u.test(keysSource))
    {
        errors.push(diagnostic({
            locale: '',
            domain: '',
            key: '',
            file: 'src/frontend/src/locales/keys.ts',
            rule: 'typed-consumer-keys',
            expected: 'exact leaf union',
            actual: 'TranslationKey = string'
        }));
    }

    return {
        ok: errors.length === 0,
        artifactCount: artifacts.length,
        locales: [...locales],
        domains: [...domains],
        errors
    };
}

/**
 * Validate a synthetic initial-graph violation for build-gate fixtures.
 * @param {{ locale: string, domain: string, isInitial: boolean, entryName?: string }} entry
 */
export function evaluateInitialGraphEntry(entry)
{
    /** @type {Diagnostic[]} */
    const errors = [];
    if (entry.isInitial)
    {
        errors.push(diagnostic({
            locale: entry.locale,
            domain: entry.domain,
            key: '',
            file: entry.entryName ?? `locale-${entry.locale}-${entry.domain}`,
            rule: 'initial-entry-locale-static',
            expected: 'locale domain chunk resolved before render, not static initial',
            actual: 'present in initial entry graph'
        }));
    }
    return errors;
}

function main()
{
    if (process.env.SKIP_I18N_GATE === '1' || process.env.SKIP_LOCALE_DOMAIN_STATIC === '1')
    {
        console.error('[locale-domain-static] skip/bypass environment variables are forbidden');
        process.exit(1);
    }

    const result = checkLocaleDomainStatic();
    if (!result.ok)
    {
        console.error(
            `[locale-domain-static] failed artifacts=${result.artifactCount} `
      + `locales=${result.locales.length} domains=${result.domains.length} `
      + `errors=${result.errors.length}`
        );
        for (const item of result.errors)
        {
            console.error(formatDiagnostic(item));
        }
        process.exit(1);
    }

    console.log(
        `[locale-domain-static] ok artifacts=${result.artifactCount} `
    + `locales=${result.locales.length} domains=${result.domains.length}`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
