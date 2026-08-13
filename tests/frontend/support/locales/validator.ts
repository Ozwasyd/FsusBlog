import { PLURAL_CATEGORIES, type PluralCategory } from '@/locales/keys'
import { isSupportedLocale } from '@/locales/localeCatalog'

export const MIGRATION_PLACEHOLDER_PREFIX = '__FSUSBLOG_TRANSLATION_PENDING__:'

export interface MigrationPlaceholderInfo {
    isPlaceholder: boolean
    key: string | null
    isValid: boolean
    error?: string
}

export function parseMigrationPlaceholder(value: string, expectedPath?: string): MigrationPlaceholderInfo {
    if (typeof value !== 'string' || !value.startsWith(MIGRATION_PLACEHOLDER_PREFIX)) {
        return { isPlaceholder: false, key: null, isValid: false }
    }
    const key = value.slice(MIGRATION_PLACEHOLDER_PREFIX.length)
    if (!key || key.includes(' ') || key.startsWith('.') || key.endsWith('.')) {
        return { isPlaceholder: true, key, isValid: false, error: 'invalid key format in placeholder' }
    }
    if (expectedPath && key !== expectedPath) {
        return {
            isPlaceholder: true,
            key,
            isValid: false,
            error: `placeholder key mismatch: expected "${expectedPath}", got "${key}"`
        }
    }
    return { isPlaceholder: true, key, isValid: true }
}

export interface EnumeratedPlaceholder {
    path: string
    placeholder: string
    key: string
    isValid: boolean
    error?: string
}

export function enumeratePlaceholders(obj: unknown, path = ''): EnumeratedPlaceholder[] {
    const results: EnumeratedPlaceholder[] = []
    if (!obj || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            const info = parseMigrationPlaceholder(obj, path)
            if (info.isPlaceholder) {
                results.push({
                    path,
                    placeholder: obj,
                    key: info.key ?? '',
                    isValid: info.isValid,
                    error: info.error
                })
            }
        }
        return results
    }

    for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key
        results.push(...enumeratePlaceholders(value, currentPath))
    }

    return results
}

export function extractInterpolationParams(message: string): string[] {
    const matches = message.match(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)
    if (!matches) return []
    return Array.from(new Set(matches.map((match) => match.slice(1, -1)))).sort()
}

const FORBIDDEN_PLACEHOLDER_SUBSTRINGS = ['TODO_TRANSLATE', 'TODO', 'TBD', 'Translation pending']

export function validateLeafValue(value: unknown, path: string): string | null {
    if (typeof value !== 'string') {
        return `Leaf node "${path}" is not a string (type: ${typeof value})`
    }
    if (value.startsWith(MIGRATION_PLACEHOLDER_PREFIX)) {
        return `Leaf node "${path}" contains migration placeholder (forbidden in fail-closed gate)`
    }
    for (const forbidden of FORBIDDEN_PLACEHOLDER_SUBSTRINGS) {
        if (value.includes(forbidden)) {
            return `Leaf node "${path}" contains forbidden placeholder phrase "${forbidden}"`
        }
    }
    const placeholder = parseMigrationPlaceholder(value, path)
    if (placeholder.isPlaceholder) {
        return `Leaf node "${path}" contains migration placeholder (forbidden in fail-closed gate)`
    }
    return null
}

export interface LocaleValidationContext {
    locale: string
    file: string
    domain?: string
}

export interface LocaleValidationResult {
    isValid: boolean
    errors: string[]
}

export interface StructuredLocaleDiagnostic {
    locale: string
    domain: string
    key: string
    file: string
    rule: string
    expected: string
    actual: string
}

export function formatStructuredLocaleDiagnostic(item: StructuredLocaleDiagnostic): string {
    return [
        `locale=${item.locale || '-'}`,
        `domain=${item.domain || '-'}`,
        `key=${item.key || '<root>'}`,
        `source file=${item.file || '-'}`,
        `rule=${item.rule}`,
        `expected=${item.expected}`,
        `actual=${item.actual}`
    ].join(' ')
}

type NodeKind = 'string' | 'plural' | 'object' | 'array' | 'null' | 'undefined' | 'number' | 'boolean' | 'function' | 'symbol' | 'bigint'

function isObject(value: unknown): value is object {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPluralNode(value: unknown): boolean {
    return isObject(value) && Reflect.get(value, 'kind') === 'plural'
}

function nodeKind(value: unknown): NodeKind {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    if (typeof value !== 'object') return typeof value
    return isPluralNode(value) ? 'plural' : 'object'
}

function entries(value: object): [string, unknown][] {
    return Object.entries(value)
}

function property(value: object, key: string): unknown {
    return Reflect.get(value, key)
}

function diagnostic(
    context: LocaleValidationContext,
    key: string,
    expectedKind: NodeKind,
    actualKind: NodeKind,
    message: string,
    rule = 'node-kind'
): string {
    return formatStructuredLocaleDiagnostic({
        locale: context.locale,
        domain: context.domain ?? '',
        key: key || '<root>',
        file: context.file,
        rule,
        expected: expectedKind,
        actual: `${actualKind}: ${message}`
    })
}

function sameParameters(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

function validatePluralNode(
    schema: object,
    candidate: object,
    key: string,
    context: LocaleValidationContext,
    errors: string[]
): void {
    const schemaForms = property(schema, 'forms')
    const candidateForms = property(candidate, 'forms')
    if (!isObject(schemaForms)) {
        errors.push(diagnostic(context, key, 'plural', 'plural', 'zh-CN schema plural node must contain an object forms field'))
        return
    }
    if (!isObject(candidateForms)) {
        errors.push(diagnostic(context, key, 'plural', nodeKind(candidateForms), 'plural node must contain an object forms field'))
        return
    }

    const expectedCategories = new Set(
        new Intl.PluralRules(context.locale).resolvedOptions().pluralCategories as PluralCategory[]
    )
    const actualCategories = Object.keys(candidateForms)
    for (const category of expectedCategories) {
        if (!Object.prototype.hasOwnProperty.call(candidateForms, category)) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `missing plural category "${category}"`, 'plural-category'))
        }
    }
    for (const category of actualCategories) {
        if (!PLURAL_CATEGORIES.includes(category as PluralCategory)) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `unknown plural category "${category}"`, 'plural-category'))
        } else if (!expectedCategories.has(category as PluralCategory)) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `unexpected plural category "${category}" for target locale`, 'plural-category'))
        }
    }

    const schemaOther = property(schemaForms, 'other')
    if (typeof schemaOther !== 'string') {
        errors.push(diagnostic(context, key, 'plural', 'plural', 'zh-CN schema plural node requires string form "other"'))
        return
    }
    const expectedParameters = extractInterpolationParams(schemaOther)
    if (!expectedParameters.includes('count')) {
        errors.push(diagnostic(context, key, 'plural', 'plural', 'plural forms must include interpolation parameter "count"'))
    }
    for (const [category, value] of entries(schemaForms)) {
        if (typeof value !== 'string') {
            errors.push(diagnostic(context, key, 'plural', 'plural', `zh-CN schema form "${category}" must be a string`))
            continue
        }
        const parameters = extractInterpolationParams(value)
        if (!sameParameters(parameters, expectedParameters)) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `zh-CN schema form "${category}" parameters [${parameters.join(', ')}] do not match "other" [${expectedParameters.join(', ')}]`))
        }
    }

    for (const [category, value] of entries(candidateForms)) {
        if (typeof value !== 'string') {
            errors.push(diagnostic(context, key, 'plural', 'plural', `plural form "${category}" must be a string`))
            continue
        }
        const leafError = validateLeafValue(value, `${key}.forms.${category}`)
        if (leafError) errors.push(diagnostic(context, key, 'plural', 'plural', leafError))
        const parameters = extractInterpolationParams(value)
        if (!sameParameters(parameters, expectedParameters)) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `plural form "${category}" parameters [${parameters.join(', ')}] do not match zh-CN [${expectedParameters.join(', ')}]`))
        }
        if (!parameters.includes('count')) {
            errors.push(diagnostic(context, key, 'plural', 'plural', `plural form "${category}" is missing interpolation parameter "count"`))
        }
    }
}

function validateNode(
    schema: unknown,
    candidate: unknown,
    key: string,
    context: LocaleValidationContext,
    errors: string[]
): void {
    const expectedKind = nodeKind(schema)
    const actualKind = nodeKind(candidate)
    if (expectedKind !== actualKind) {
        errors.push(diagnostic(context, key, expectedKind, actualKind, 'locale node kind differs from zh-CN schema'))
        return
    }

    if (expectedKind === 'string') {
        const leafError = validateLeafValue(candidate, key)
        if (leafError) errors.push(diagnostic(context, key, 'string', 'string', leafError))
        const expectedParameters = extractInterpolationParams(schema as string)
        const actualParameters = extractInterpolationParams(candidate as string)
        if (!sameParameters(expectedParameters, actualParameters)) {
            errors.push(diagnostic(
                context,
                key,
                'string',
                'string',
                `interpolation parameters [${actualParameters.join(', ')}] do not match zh-CN [${expectedParameters.join(', ')}]`,
                'interpolation-params'
            ))
        }
        return
    }

    if (expectedKind === 'plural') {
        validatePluralNode(schema as object, candidate as object, key, context, errors)
        return
    }

    if (expectedKind !== 'object') {
        errors.push(diagnostic(context, key, expectedKind, actualKind, 'locale tree nodes must be strings, plural nodes, or objects'))
        return
    }

    const schemaObject = schema as object
    const candidateObject = candidate as object
    const schemaKeys = new Set(Object.keys(schemaObject))
    const candidateKeys = new Set(Object.keys(candidateObject))
    for (const childKey of schemaKeys) {
        const childPath = key ? `${key}.${childKey}` : childKey
        if (!candidateKeys.has(childKey)) {
            errors.push(diagnostic(context, childPath, nodeKind(property(schemaObject, childKey)), 'undefined', 'missing locale key'))
            continue
        }
        validateNode(property(schemaObject, childKey), property(candidateObject, childKey), childPath, context, errors)
    }
    for (const childKey of candidateKeys) {
        if (!schemaKeys.has(childKey)) {
            const childPath = key ? `${key}.${childKey}` : childKey
            errors.push(diagnostic(context, childPath, 'undefined', nodeKind(property(candidateObject, childKey)), 'extra locale key'))
        }
    }
}

export function validateLocaleMessages(
    zhCNSchema: unknown,
    candidate: unknown,
    context: LocaleValidationContext
): LocaleValidationResult {
    if (!isSupportedLocale(context.locale)) {
        return {
            isValid: false,
            errors: [
                formatStructuredLocaleDiagnostic({
                    locale: context.locale,
                    domain: context.domain ?? '',
                    key: '<root>',
                    file: context.file,
                    rule: 'catalog-enabled-locale',
                    expected: 'locale enabled by locale catalog',
                    actual: 'unsupported locale is not enabled by locale catalog'
                })
            ]
        }
    }
    const errors: string[] = []
    validateNode(zhCNSchema, candidate, '', context, errors)
    return { isValid: errors.length === 0, errors }
}
