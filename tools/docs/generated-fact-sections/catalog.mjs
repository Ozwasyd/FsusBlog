import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    GeneratedSectionErrorCode,
    makeGeneratedSectionError
} from './markers.mjs'
import { allowedRenderers } from './renderers.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const catalogRelative = 'config/contracts/generated-fact-sections.json'
export const catalogSchemaRelative = 'config/schemas/generated-fact-section-catalog.schema.json'
export const catalogSchemaId = 'fsusblog.generated-fact-section-catalog.v1'

const sectionIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u
const extractorIdPattern = /^[a-z][a-z0-9-]*$/u
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u
const documentPathPattern = /^docs\/.+\.md$/u

export const forbiddenCatalogFields = Object.freeze([
    'expectedValue',
    'baselineValue',
    'baselineAllowlist',
    'allowDiff',
    'warningOnly',
    'featureFlag',
    'mergeManualRows',
    'lastVerifiedCommit',
    'compatMarker'
])

export const allowedOrderPolicies = Object.freeze(['ordinal', 'preserve', 'not-applicable'])
export const allowedEmptyPolicies = Object.freeze(['fail', 'render-empty'])

export function loadCatalogSchema(repositoryRoot = root)
{
    const absolute = path.join(repositoryRoot, catalogSchemaRelative)
    return JSON.parse(readFileSync(absolute, 'utf8'))
}

export function validateCatalogSchemaContract(schema = loadCatalogSchema())
{
    if (schema?.$id !== catalogSchemaId || schema?.additionalProperties !== false)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            'generated-fact-section catalog schema identity or fail-closed root drifted'
        )
    }
    const rendererEnum = schema?.$defs?.section?.properties?.renderer?.enum ?? []
    for (const kind of allowedRenderers)
    {
        if (!rendererEnum.includes(kind))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `catalog schema missing renderer ${kind}`
            )
        }
    }
    const forbidden = schema?.$defs?.forbiddenFields?.enum ?? []
    for (const field of ['baselineAllowlist', 'warningOnly', 'featureFlag', 'expectedValue'])
    {
        if (!forbidden.includes(field))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `catalog schema must forbid ${field}`
            )
        }
    }
    return true
}

function assertNoForbiddenKeys(value, label)
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${label}[${index}]`))
        return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value))
    {
        if (forbiddenCatalogFields.includes(key))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.BASELINE_ALLOWLIST,
                `${label} contains forbidden field ${key}`
            )
        }
        assertNoForbiddenKeys(nested, `${label}.${key}`)
    }
}

export function loadCatalog(repositoryRoot = root, relativePath = catalogRelative)
{
    const absolute = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(repositoryRoot, relativePath)
    if (!existsSync(absolute))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `missing generated-fact-section catalog at ${relativePath}`
        )
    }
    const catalog = JSON.parse(readFileSync(absolute, 'utf8'))
    validateCatalog(catalog)
    return catalog
}

export function validateCatalog(catalog)
{
    validateCatalogSchemaContract()
    if (catalog == null || typeof catalog !== 'object' || Array.isArray(catalog))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            'catalog must be an object'
        )
    }
    assertNoForbiddenKeys(catalog, 'catalog')
    if (catalog.schema !== catalogSchemaId)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `unexpected catalog schema ${catalog.schema}`
        )
    }
    if (catalog.digestAlgorithm !== 'sha256' || catalog.canonicalSerialization !== 'json-utf8-v1')
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            'catalog digest/serialization contract drifted'
        )
    }
    if (!Array.isArray(catalog.sections))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            'catalog.sections must be an array'
        )
    }

    const sectionIds = new Set()
    const factOwners = new Map()

    for (const [index, section] of catalog.sections.entries())
    {
        validateSectionEntry(section, index)
        if (sectionIds.has(section.sectionId))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.MARKER_DUPLICATE_ID,
                `duplicate sectionId ${section.sectionId} in catalog`,
                { sectionId: section.sectionId }
            )
        }
        sectionIds.add(section.sectionId)

        const factKey = `${section.extractorId}::${section.factPath}`
        if (factOwners.has(factKey) && factOwners.get(factKey) !== section.sectionId)
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.FACT_DUPLICATE_OWNER,
                `fact ${factKey} is claimed by both ${factOwners.get(factKey)} and ${section.sectionId}`,
                { sectionId: section.sectionId, factPath: section.factPath }
            )
        }
        factOwners.set(factKey, section.sectionId)
    }

    return true
}

function validateSectionEntry(section, index)
{
    if (section == null || typeof section !== 'object' || Array.isArray(section))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `sections[${index}] must be an object`
        )
    }
    assertNoForbiddenKeys(section, `sections[${index}]`)

    const required = [
        'sectionId',
        'documentPath',
        'renderer',
        'extractorId',
        'behaviorId',
        'factPath',
        'orderPolicy',
        'emptyPolicy'
    ]
    for (const field of required)
    {
        if (!Object.hasOwn(section, field))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `sections[${index}] missing ${field}`
            )
        }
    }

    const allowed = new Set([...required, 'columns', 'unit', 'projection'])
    for (const key of Object.keys(section))
    {
        if (!allowed.has(key))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `sections[${index}] has unknown field ${key}`
            )
        }
    }

    if (!sectionIdPattern.test(section.sectionId))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid sectionId ${section.sectionId}`
        )
    }
    if (!documentPathPattern.test(section.documentPath))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid documentPath ${section.documentPath}`
        )
    }
    if (!allowedRenderers.includes(section.renderer))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.RENDERER_UNKNOWN,
            `unknown renderer ${section.renderer}`
        )
    }
    if (!extractorIdPattern.test(section.extractorId))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid extractorId ${section.extractorId}`
        )
    }
    if (!behaviorIdPattern.test(section.behaviorId))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid behaviorId ${section.behaviorId}`
        )
    }
    if (typeof section.factPath !== 'string' || section.factPath.length === 0)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid factPath on ${section.sectionId}`
        )
    }
    if (!allowedOrderPolicies.includes(section.orderPolicy))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid orderPolicy ${section.orderPolicy}`
        )
    }
    if (!allowedEmptyPolicies.includes(section.emptyPolicy))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.CATALOG_INVALID,
            `invalid emptyPolicy ${section.emptyPolicy}`
        )
    }
    if (Object.hasOwn(section, 'columns'))
    {
        if (!Array.isArray(section.columns) || section.columns.length === 0
            || section.columns.some((column) => typeof column !== 'string' || column.length === 0))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `invalid columns on ${section.sectionId}`
            )
        }
    }
}

/**
 * Resolve a fact path against receipt observations.
 * Prefers exact key match (including keys that contain dots), then nested descent.
 */
export function resolveFactPath(observations, factPath)
{
    if (observations == null || typeof observations !== 'object' || Array.isArray(observations))
    {
        return undefined
    }
    if (Object.hasOwn(observations, factPath))
    {
        return observations[factPath]
    }
    const parts = factPath.split('.')
    let current = observations
    for (const part of parts)
    {
        if (current == null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, part))
        {
            return undefined
        }
        current = current[part]
    }
    return current
}

export function sectionsByDocument(catalog)
{
    const map = new Map()
    for (const section of catalog.sections)
    {
        const list = map.get(section.documentPath) ?? []
        list.push(section)
        map.set(section.documentPath, list)
    }
    return map
}

export function findSection(catalog, sectionId)
{
    return catalog.sections.find((section) => section.sectionId === sectionId) ?? null
}
