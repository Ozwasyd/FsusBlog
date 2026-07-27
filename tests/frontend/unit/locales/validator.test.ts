// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { ENABLED_LOCALES, LOCALE_DOMAINS, type SupportedLocale } from '@/locales'
import { LOCALE_DOMAIN_LOADERS } from '@/locales/localeDomainBundleStore'
import {
    enumeratePlaceholders,
    extractInterpolationParams,
    parseMigrationPlaceholder,
    validateLeafValue,
    validateLocaleMessages
} from '@/locales/validator'

const loadValidationTree = async (locale: SupportedLocale): Promise<Record<string, unknown>> => {
    const entries = await Promise.all(LOCALE_DOMAINS.map(async (domain) => {
        const loader = LOCALE_DOMAIN_LOADERS[locale][domain]
        const module = await loader.importModule()
        return [domain, module[loader.exportName]] as const
    }))
    return Object.fromEntries(entries)
}

const validate = (locale: SupportedLocale, schema: unknown, candidate: unknown) =>
    validateLocaleMessages(schema, candidate, {
        locale,
        file: `src/frontend/src/locales/${locale}/fixture.ts`
    })

const pluralSchema = {
    ordinary: '普通 {name}',
    plural: {
        kind: 'plural',
        forms: {
            other: '{count} items for {name}'
        }
    }
} as const

describe('locale schema and plural contract (#1533)', () => {
    it('runs all ten catalog locales through the same strict validator', async () => {
        const zhCN = await loadValidationTree('zh-CN')
        for (const { code: locale } of ENABLED_LOCALES) {
            const bundle = await loadValidationTree(locale)
            expect(validate(locale, zhCN, bundle).errors, locale).toEqual([])
        }
    })

    it('accepts valid minimal zh-CN, en-US, and ru-RU plural fixtures', () => {
        expect(validate('zh-CN', pluralSchema, {
            ordinary: '普通 {name}',
            plural: { kind: 'plural', forms: { other: '{count} 个项目，{name}' } }
        }).isValid).toBe(true)
        expect(validate('en-US', pluralSchema, {
            ordinary: 'Hello {name}',
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} item for {name}',
                    other: '{count} items for {name}'
                }
            }
        }).isValid).toBe(true)
        expect(validate('ru-RU', pluralSchema, {
            ordinary: 'Привет, {name}',
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} элемент для {name}',
                    few: '{count} элемента для {name}',
                    many: '{count} элементов для {name}',
                    other: '{count} элемента для {name}'
                }
            }
        }).isValid).toBe(true)
    })

    it('rejects a locale outside the catalog before constructing Intl.PluralRules', () => {
        const pluralRules = vi.spyOn(Intl, 'PluralRules')
        try {
            const result = validateLocaleMessages(pluralSchema, pluralSchema, {
                locale: 'en-GB',
                file: 'src/frontend/src/locales/en-GB/fixture.ts'
            })

            expect(result.isValid).toBe(false)
            expect(result.errors).toEqual([
                expect.stringContaining(
                    'locale=en-GB file=src/frontend/src/locales/en-GB/fixture.ts'
                )
            ])
            expect(result.errors[0]).toContain('unsupported locale is not enabled by locale catalog')
            expect(pluralRules).not.toHaveBeenCalled()
        } finally {
            pluralRules.mockRestore()
        }
    })

    it('rejects ordinary/plural kind drift in both directions', () => {
        const ordinaryBecamePlural = validate('de-DE', pluralSchema, {
            ordinary: { kind: 'plural', forms: { one: '{count}', other: '{count}' } },
            plural: { kind: 'plural', forms: { one: '{count} for {name}', other: '{count} for {name}' } }
        })
        expect(ordinaryBecamePlural.errors[0]).toContain('locale=de-DE')
        expect(ordinaryBecamePlural.errors[0]).toContain('key=ordinary')
        expect(ordinaryBecamePlural.errors[0]).toContain('expectedKind=string actualKind=plural')

        const pluralBecameString = validate('ja-JP', pluralSchema, {
            ordinary: '普通 {name}',
            plural: '{count} items for {name}'
        })
        expect(pluralBecameString.errors).toContainEqual(expect.stringContaining('expectedKind=plural actualKind=string'))
    })

    it('rejects missing other and Russian few/many categories', () => {
        const missingOther = validate('en-US', pluralSchema, {
            ordinary: 'Hello {name}',
            plural: { kind: 'plural', forms: { one: '{count} item for {name}' } }
        })
        expect(missingOther.errors).toContainEqual(expect.stringContaining('missing plural category "other"'))

        const incompleteRussian = validate('ru-RU', pluralSchema, {
            ordinary: 'Привет, {name}',
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} элемент для {name}',
                    other: '{count} элемента для {name}'
                }
            }
        })
        expect(incompleteRussian.errors).toContainEqual(expect.stringContaining('missing plural category "few"'))
        expect(incompleteRussian.errors).toContainEqual(expect.stringContaining('missing plural category "many"'))
    })

    it('rejects plural parameter drift and missing count', () => {
        const parameterDrift = validate('en-US', pluralSchema, {
            ordinary: 'Hello {name}',
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} item for {name}',
                    other: '{count} items'
                }
            }
        })
        expect(parameterDrift.errors).toContainEqual(expect.stringContaining('parameters [count] do not match zh-CN [count, name]'))

        const missingCountSchema = {
            ordinary: '普通',
            plural: { kind: 'plural', forms: { other: '项目 {name}' } }
        }
        const missingCount = validate('zh-CN', missingCountSchema, missingCountSchema)
        expect(missingCount.errors).toContainEqual(expect.stringContaining('must include interpolation parameter "count"'))
        expect(missingCount.errors).toContainEqual(expect.stringContaining('is missing interpolation parameter "count"'))
    })

    it('does not infer plural nodes from one/other-shaped ordinary objects', () => {
        const result = validate('de-DE', { ordinary: '普通' }, {
            ordinary: { one: 'eins', other: 'andere' }
        })
        expect(result.errors[0]).toContain('expectedKind=string actualKind=object')
    })

    it('rejects an unknown plural category with contextual diagnostics', () => {
        const result = validate('en-US', pluralSchema, {
            ordinary: 'Hello {name}',
            plural: {
                kind: 'plural',
                forms: {
                    one: '{count} item for {name}',
                    other: '{count} items for {name}',
                    bogus: '{count} bogus items for {name}'
                }
            }
        })
        const error = result.errors.find((item) => item.includes('unknown plural category'))!
        expect(error).toContain('locale=en-US')
        expect(error).toContain('file=src/frontend/src/locales/en-US/fixture.ts')
        expect(error).toContain('key=plural')
        expect(error).toContain('expectedKind=plural actualKind=plural')
    })
})

describe('migration placeholder contract (#1479)', () => {
    it('parses valid and invalid migration placeholders', () => {
        const valid = parseMigrationPlaceholder(
            '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyEnabled',
            'identity.overview.passkeyEnabled'
        )
        expect(valid).toMatchObject({ isPlaceholder: true, isValid: true, key: 'identity.overview.passkeyEnabled' })

        const keyMismatch = parseMigrationPlaceholder(
            '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyEnabled',
            'identity.overview.wrongPath'
        )
        expect(keyMismatch.error).toContain('placeholder key mismatch')

        const invalidFormat = parseMigrationPlaceholder('__FSUSBLOG_TRANSLATION_PENDING__:invalid key with spaces')
        expect(invalidFormat.error).toContain('invalid key format')
    })

    it('verifies no migration placeholders remain in en-US', async () => {
        const enUS = await loadValidationTree('en-US')
        expect(enumeratePlaceholders(enUS)).toEqual([])
    })

    it('extracts interpolation parameters and rejects forbidden placeholder phrases', () => {
        expect(extractInterpolationParams('Hello {name}, you have {count} messages.')).toEqual(['count', 'name'])
        expect(extractInterpolationParams('No params here.')).toEqual([])
        expect(validateLeafValue('TODO: translate', 'test.path')).toContain('forbidden placeholder phrase "TODO"')
        expect(validateLeafValue('TODO_TRANSLATE', 'test.path')).toContain('forbidden placeholder phrase "TODO_TRANSLATE"')
        expect(validateLeafValue('TBD', 'test.path')).toContain('forbidden placeholder phrase "TBD"')
    })
})
