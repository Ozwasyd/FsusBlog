import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCatalog, validateCatalog } from '../contracts/behavior-contract-catalog.mjs'
import { digestValue, isPlainObject } from './lib/canonicalize.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const registryRelative = 'config/contracts/behavior-fact-extractors.json'
export const schemaRelative = 'config/schemas/behavior-fact-extractor-registry.schema.json'
export const receiptSchemaRelative = 'config/schemas/fact-observation-receipt.schema.json'

export const registrySchemaId = 'fsusblog.behavior-fact-extractor-registry.v1'
export const receiptSchemaId = 'fsusblog.fact-observation-receipt.v1'
export const digestAlgorithm = 'sha256'
export const canonicalSerialization = 'json-utf8-v1'

export const allowedKinds = Object.freeze([
    'source-ast',
    'compiled-assembly',
    'canonical-catalog',
    'generated-contract',
    'matrix-projection'
])

export const forbiddenKinds = Object.freeze([
    'shell-command',
    'http-endpoint',
    'database-query',
    'browser'
])

export const allowedHermeticPolicies = Object.freeze([
    'source-worktree',
    'exact-build-receipt',
    'declared-inputs'
])

export const extractorFieldKeys = Object.freeze([
    'id',
    'kind',
    'entrypoint',
    'consumedInputs',
    'outputSchema',
    'requiredBuildArtifact',
    'hermeticPolicy',
    'ownedBehaviorIds'
])

const idPattern = /^[a-z][a-z0-9-]*$/u
const fail = (message) =>
{
    throw new Error(`[behavior-fact-extractors] ${message}`)
}

const exactKeys = (value, keys, label) =>
{
    if (!isPlainObject(value)) fail(`${label} must be an object`)
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    if (actual.join('\0') !== expected.join('\0')) fail(`${label} has unsupported or missing fields`)
}

const uniqueStrings = (values, label, { min = 0 } = {}) =>
{
    if (!Array.isArray(values) || values.length < min || values.some((value) => typeof value !== 'string' || value.length === 0) || new Set(values).size !== values.length)
    {
        fail(`${label} must be a unique non-empty string list`)
    }
}

const fileExists = (repositoryRoot, relative) => existsSync(path.join(repositoryRoot, relative))

const isForbiddenInputPath = (relative) =>
{
    const normalized = relative.replaceAll('\\', '/')
    if (normalized.startsWith('docs/') && normalized.endsWith('.md')) return true
    if (/(?:^|\/)(?:fixtures?|golden|baselines?)(?:\/|$)/iu.test(normalized)) return true
    if (/\.(?:expected|golden|baseline|snap|snapshot)(?:\.|$)/iu.test(normalized)) return true
    if (/(?:^|\/)(?:history|historical)(?:\/|$)/iu.test(normalized) && /evidence/iu.test(normalized)) return true
    if (/lastVerifiedCommit/iu.test(normalized)) return true
    if (/release[-_]?notes?/iu.test(normalized)) return true
    return false
}

export function loadRegistry(registryPath = path.join(root, registryRelative))
{
    return JSON.parse(readFileSync(registryPath, 'utf8'))
}

export function loadRegistrySchema(schemaPath = path.join(root, schemaRelative))
{
    return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

export function loadReceiptSchema(schemaPath = path.join(root, receiptSchemaRelative))
{
    return JSON.parse(readFileSync(schemaPath, 'utf8'))
}

export function digestRegistry(registry)
{
    return digestValue(registry)
}

export function validateRegistrySchemaContract(schema = loadRegistrySchema())
{
    if (schema?.$id !== registrySchemaId || schema?.additionalProperties !== false)
    {
        fail('registry schema identity or fail-closed root shape drifted')
    }
    const extractor = schema?.$defs?.extractor
    if (extractor?.additionalProperties !== false) fail('extractor records must reject unknown fields')
    const kindEnum = extractor?.properties?.kind?.enum ?? []
    if ([...kindEnum].sort().join('\0') !== [...allowedKinds].sort().join('\0')) fail('kind enum drifted from loader contract')
    for (const kind of forbiddenKinds)
    {
        if (kindEnum.includes(kind)) fail(`forbidden kind ${kind} must not be admitted`)
    }
    const policyEnum = extractor?.properties?.hermeticPolicy?.enum ?? []
    if ([...policyEnum].sort().join('\0') !== [...allowedHermeticPolicies].sort().join('\0')) fail('hermeticPolicy enum drifted')
    const required = extractor?.required ?? []
    if ([...required].sort().join('\0') !== [...extractorFieldKeys].sort().join('\0')) fail('extractor required fields drifted')
    if (extractor?.properties?.outputSchema?.const !== receiptSchemaId) fail('outputSchema must be fixed to fact observation receipt')
    return true
}

function assertKindPolicy(extractor)
{
    if (extractor.kind === 'compiled-assembly')
    {
        if (extractor.hermeticPolicy !== 'exact-build-receipt') fail(`${extractor.id} compiled-assembly requires exact-build-receipt`)
        if (typeof extractor.requiredBuildArtifact !== 'string' || extractor.requiredBuildArtifact.length === 0)
        {
            fail(`${extractor.id} compiled-assembly requires non-null requiredBuildArtifact`)
        }
        return
    }
    if (extractor.requiredBuildArtifact != null) fail(`${extractor.id} non-compiled extractors must set requiredBuildArtifact null`)
    if (extractor.kind === 'source-ast' && extractor.hermeticPolicy !== 'source-worktree')
    {
        fail(`${extractor.id} source-ast requires source-worktree hermeticPolicy`)
    }
    if (extractor.kind !== 'source-ast' && extractor.hermeticPolicy === 'source-worktree')
    {
        fail(`${extractor.id} source-worktree is only valid for source-ast`)
    }
    if (extractor.hermeticPolicy === 'exact-build-receipt')
    {
        fail(`${extractor.id} exact-build-receipt is only valid for compiled-assembly`)
    }
}

export function validateRegistry(registry, repositoryRoot = root)
{
    validateRegistrySchemaContract(loadRegistrySchema(path.join(repositoryRoot, schemaRelative)))
    exactKeys(registry, ['schema', 'digestAlgorithm', 'canonicalSerialization', 'extractors'], 'registry')
    if (registry.schema !== registrySchemaId || registry.digestAlgorithm !== digestAlgorithm || registry.canonicalSerialization !== canonicalSerialization)
    {
        fail('unsupported registry authority contract')
    }
    if (!Array.isArray(registry.extractors) || registry.extractors.length === 0) fail('extractors must be a non-empty list')

    const byId = new Map()
    const behaviorOwners = new Map()
    for (const extractor of registry.extractors)
    {
        exactKeys(extractor, extractorFieldKeys, `extractor ${extractor.id ?? '<unknown>'}`)
        if (!idPattern.test(extractor.id) || byId.has(extractor.id)) fail(`invalid or duplicate extractor id ${extractor.id ?? '<unknown>'}`)
        if (!allowedKinds.includes(extractor.kind)) fail(`${extractor.id} has forbidden or unknown kind ${extractor.kind}`)
        if (forbiddenKinds.includes(extractor.kind)) fail(`${extractor.id} uses forbidden kind ${extractor.kind}`)
        if (typeof extractor.entrypoint !== 'string' || !extractor.entrypoint.startsWith('tools/fact-extractors/'))
        {
            fail(`${extractor.id} entrypoint must live under tools/fact-extractors/`)
        }
        if (extractor.entrypoint.includes('..') || path.isAbsolute(extractor.entrypoint)) fail(`${extractor.id} entrypoint path is invalid`)
        if (!fileExists(repositoryRoot, extractor.entrypoint)) fail(`${extractor.id} entrypoint missing: ${extractor.entrypoint}`)
        uniqueStrings(extractor.consumedInputs, `${extractor.id}.consumedInputs`, { min: 1 })
        for (const input of extractor.consumedInputs)
        {
            if (input.includes('\0') || path.isAbsolute(input) || input.split(/[/\\]/u).includes('..')) fail(`${extractor.id} consumed input path invalid: ${input}`)
            if (isForbiddenInputPath(input)) fail(`${extractor.id} consumedInputs must not include forbidden authority ${input}`)
            if (!fileExists(repositoryRoot, input)) fail(`${extractor.id} consumed input missing: ${input}`)
        }
        if (extractor.outputSchema !== receiptSchemaId) fail(`${extractor.id} outputSchema must be ${receiptSchemaId}`)
        if (!allowedHermeticPolicies.includes(extractor.hermeticPolicy)) fail(`${extractor.id} has invalid hermeticPolicy`)
        assertKindPolicy(extractor)
        uniqueStrings(extractor.ownedBehaviorIds, `${extractor.id}.ownedBehaviorIds`, { min: 1 })
        for (const behaviorId of extractor.ownedBehaviorIds)
        {
            if (!idPattern.test(behaviorId)) fail(`${extractor.id} owns invalid behavior id ${behaviorId}`)
            if (behaviorOwners.has(behaviorId))
            {
                fail(`behavior ${behaviorId} has dual extractor owners: ${behaviorOwners.get(behaviorId)} and ${extractor.id}`)
            }
            behaviorOwners.set(behaviorId, extractor.id)
        }
        byId.set(extractor.id, extractor)
    }

    return {
        digest: digestRegistry(registry),
        byId,
        behaviorOwners
    }
}

/**
 * Each active BehaviorCatalog behavior must map to exactly one extractor owner.
 * Dual-owner / no-owner fail closed. Catalog factExtractorId must match owner.
 */
export function validateOwnershipAgainstBehaviorCatalog(registry, catalog = loadCatalog(), repositoryRoot = root)
{
    const { byId, behaviorOwners, digest } = validateRegistry(registry, repositoryRoot)
    validateCatalog(catalog, repositoryRoot)

    const catalogExtractorIds = new Set((catalog.extractors ?? []).map((entry) => entry.id))
    for (const extractor of registry.extractors)
    {
        if (!catalogExtractorIds.has(extractor.id))
        {
            fail(`registry extractor ${extractor.id} is not declared in BehaviorContractCatalog.extractors`)
        }
    }
    for (const entry of catalog.extractors ?? [])
    {
        if (!byId.has(entry.id))
        {
            fail(`BehaviorContractCatalog extractor ${entry.id} is missing from ExtractorRegistry`)
        }
    }

    for (const contract of catalog.contracts)
    {
        if (contract.status !== 'active')
        {
            const owner = behaviorOwners.get(contract.id)
            if (owner)
            {
                fail(`${contract.status} behavior ${contract.id} must not be owned by extractor ${owner}`)
            }
            continue
        }
        const owner = behaviorOwners.get(contract.id)
        if (!owner) fail(`active behavior ${contract.id} has no extractor owner`)
        if (contract.factExtractorId !== owner)
        {
            fail(`active behavior ${contract.id} factExtractorId=${contract.factExtractorId} but registry owner is ${owner}`)
        }
        if (!byId.has(contract.factExtractorId))
        {
            fail(`active behavior ${contract.id} references unknown factExtractorId ${contract.factExtractorId}`)
        }
    }

    for (const [behaviorId, owner] of behaviorOwners)
    {
        const contract = catalog.contracts.find((entry) => entry.id === behaviorId)
        if (!contract) fail(`extractor ${owner} owns unknown behavior ${behaviorId}`)
    }

    return { digest, byId, behaviorOwners }
}

export function getExtractor(registry, extractorId)
{
    const extractor = registry.extractors.find((entry) => entry.id === extractorId)
    if (!extractor) fail(`unknown extractor ${extractorId}`)
    return extractor
}

export async function importExtractorModule(repositoryRoot, entrypoint)
{
    const absolute = path.resolve(repositoryRoot, entrypoint)
    const rootResolved = path.resolve(repositoryRoot)
    if (!absolute.startsWith(`${rootResolved}${path.sep}`)) fail(`entrypoint escapes repository: ${entrypoint}`)
    if (!entrypoint.startsWith('tools/fact-extractors/')) fail(`entrypoint outside framework root: ${entrypoint}`)
    const module = await import(pathToFileURL(absolute).href)
    if (typeof module.extract !== 'function') fail(`${entrypoint} must export extract(context)`)
    return module
}
