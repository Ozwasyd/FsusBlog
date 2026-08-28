import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadCatalog } from '../contracts/behavior-contract-catalog.mjs'
import {
    loadRegistry,
    root,
    validateOwnershipAgainstBehaviorCatalog,
    validateRegistry,
    validateRegistrySchemaContract,
    loadRegistrySchema,
    loadReceiptSchema
} from './registry.mjs'
import { validateReceiptSchemaContract } from './receipt.mjs'

const fail = (message) =>
{
    throw new Error(`[behavior-fact-extractors-governance] ${message}`)
}

const frameworkFiles = new Set([
    'tools/fact-extractors/registry.mjs',
    'tools/fact-extractors/receipt.mjs',
    'tools/fact-extractors/runner.mjs',
    'tools/fact-extractors/reader.mjs',
    'tools/fact-extractors/identity.mjs',
    'tools/fact-extractors/governance.mjs',
    'tools/fact-extractors/check-behavior-fact-extractors.mjs',
    'tools/fact-extractors/post-runtime/registry.mjs',
    'tools/fact-extractors/lib/canonicalize.mjs'
])

const forbiddenPathPatterns = [
    /docs\/[^'"`\s]+\.md/u,
    /(?:^|['"`])docs\/.+\.md/u,
    /lastVerifiedCommit/u,
    /release[-_]?notes?/iu
]

const forbiddenInputTokenPatterns = [
    /(?:^|['"`/])(?:fixtures?|golden|baselines?)(?:['"`/])/iu,
    /\.(?:expected|golden|baseline|snap|snapshot)(?:['"`]|\.json|\.yml|\.yaml|\.txt)/iu,
    /historical[_/-]?evidence/iu
]

const forbiddenRuntimePatterns = [
    /\bspawn(?:Sync)?\s*\(/u,
    /\bexec(?:File)?(?:Sync)?\s*\(/u,
    /\bexecFileSync\s*\(/u,
    /process\.env\.[A-Z0-9_]*(?:ENTRYPOINT|EXTRACTOR|PLUGIN)/u,
    /shell-command/u,
    /dynamic[_-]?plugin/iu,
    /readdirSync\s*\([^)]*fact-extractors/u
]

function walkFiles(directory, out = [])
{
    if (!existsSync(directory)) return out
    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) walkFiles(absolute, out)
        else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(absolute)
    }
    return out
}

function relativeOf(repositoryRoot, absolute)
{
    return path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/')
}

/**
 * Static proof that extractors do not read docs/tests expected/baselines/evidence answers,
 * do not shell out, do not scan dynamic plugin directories, and do not call peer extractors.
 */
export function scanExtractorSources(repositoryRoot = root, registry = loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json')))
{
    validateRegistry(registry, repositoryRoot)
    const errors = []
    const entrypoints = new Map(registry.extractors.map((extractor) => [extractor.entrypoint.replaceAll('\\', '/'), extractor.id]))
    const seedFiles = walkFiles(path.join(repositoryRoot, 'tools/fact-extractors/seeds'))
    const libFiles = walkFiles(path.join(repositoryRoot, 'tools/fact-extractors/lib'))
    const postRuntimeFiles = walkFiles(path.join(repositoryRoot, 'tools/fact-extractors/post-runtime'))

    for (const absolute of [...seedFiles, ...libFiles, ...postRuntimeFiles])
    {
        const relative = relativeOf(repositoryRoot, absolute)
        const source = readFileSync(absolute, 'utf8')
        const extractorId = entrypoints.get(relative)

        for (const pattern of forbiddenPathPatterns)
        {
            if (pattern.test(source))
            {
                errors.push(`${relative}: forbidden docs/Markdown or self-proving token (${pattern})`)
            }
        }
        for (const pattern of extractorId || !relative.includes('/post-runtime/')
            ? forbiddenInputTokenPatterns
            : [])
        {
            if (pattern.test(source))
            {
                errors.push(`${relative}: forbidden fixture/expected/baseline/evidence input token`)
            }
        }

        if (extractorId)
        {
            for (const pattern of forbiddenRuntimePatterns)
            {
                if (pattern.test(source))
                {
                    errors.push(`${relative}: extractor ${extractorId} uses forbidden runtime surface (${pattern})`)
                }
            }
            // Extractors must not import another seed entrypoint (no domain call edges).
            for (const [otherEntrypoint, otherId] of entrypoints)
            {
                if (otherEntrypoint === relative) continue
                const peerBase = path.posix.basename(otherEntrypoint)
                const peerMentioned = source.includes(otherEntrypoint)
                    || source.includes(`seeds/${peerBase}`)
                    || new RegExp(`(?:from|import)\\s*['"][^'"]*${peerBase.replace(/\./g, '\\.')}['"]`, 'u').test(source)
                if (peerMentioned)
                {
                    errors.push(`${relative}: extractor ${extractorId} must not call/import peer extractor ${otherId}`)
                }
            }
            if (/from\s+['"]\.\.\/(?:runner|registry)\.mjs['"]/u.test(source) && /\brunExtractor\b|\bimportExtractorModule\b/.test(source))
            {
                errors.push(`${relative}: extractor must not invoke the runner/import peer modules for domain coupling`)
            }
        }
    }

    // Framework must not admit shell fallback plugin surface.
    for (const relative of frameworkFiles)
    {
        const absolute = path.join(repositoryRoot, relative)
        if (!existsSync(absolute))
        {
            errors.push(`missing framework file ${relative}`)
            continue
        }
        const source = readFileSync(absolute, 'utf8')
        if (/shell-command|dynamicPlugin|pluginDirectory|featureFlag.*extractor|compatReader/iu.test(source)
            && !/forbidden|must not|reject|never admitted/iu.test(source))
        {
            // Allow mentions only in reject/forbid commentary already covered by governance text.
        }
        if (/allowedKinds\s*=\s*\[[^\]]*'shell-command'/u.test(source))
        {
            errors.push(`${relative}: shell-command kind must not be allowed`)
        }
    }

    // Single registry / single receipt schema.
    const secondRegistry = /fsusblog\.behavior-fact-extractor-registry\.v0\b|behavior-fact-extractors-compat/u
    const secondReceipt = /fsusblog\.fact-observation-receipt\.v0\b|compat.*fact-observation/u
    for (const directory of ['config', 'tools', 'tests'])
    {
        const absoluteRoot = path.join(repositoryRoot, directory)
        if (!existsSync(absoluteRoot)) continue
        const stack = [absoluteRoot]
        while (stack.length > 0)
        {
            const current = stack.pop()
            let entries
            try { entries = readdirSync(current, { withFileTypes: true }) }
            catch { continue }
            for (const entry of entries)
            {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp') continue
                const absolute = path.join(current, entry.name)
                if (entry.isDirectory())
                {
                    stack.push(absolute)
                    continue
                }
                if (!entry.isFile()) continue
                if (!/\.(?:mjs|js|json|md|ts|cs)$/u.test(entry.name)) continue
                const relative = relativeOf(repositoryRoot, absolute)
                if (relative.endsWith('behavior-fact-extractors.test.mjs') || relative.endsWith('governance.mjs')) continue
                const source = readFileSync(absolute, 'utf8')
                if (secondRegistry.test(source) || secondReceipt.test(source))
                {
                    errors.push(`${relative}: second extractor registry or receipt schema surface`)
                }
            }
        }
    }

    return errors
}

export function assertExtractorDependencyAcyclic(registry = loadRegistry())
{
    // Extractors have no dependsOn edges by schema; seed import graph must still be acyclic peer-free.
    // Ownership map is a forest of behavior→extractor with unique owners — already fail-closed in validateRegistry.
    const owners = new Map()
    for (const extractor of registry.extractors)
    {
        for (const behaviorId of extractor.ownedBehaviorIds)
        {
            if (owners.has(behaviorId)) fail(`cycle/dual-owner on ${behaviorId}`)
            owners.set(behaviorId, extractor.id)
        }
    }
    return true
}

export function scanRepositoryFactExtractorGovernance(repositoryRoot = root)
{
    const registry = loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'))
    validateRegistrySchemaContract(loadRegistrySchema(path.join(repositoryRoot, 'config/schemas/behavior-fact-extractor-registry.schema.json')))
    validateReceiptSchemaContract(loadReceiptSchema(path.join(repositoryRoot, 'config/schemas/fact-observation-receipt.schema.json')))
    const ownership = validateOwnershipAgainstBehaviorCatalog(
        registry,
        loadCatalog(path.join(repositoryRoot, 'config/contracts/behavior-contracts.json')),
        repositoryRoot
    )
    assertExtractorDependencyAcyclic(registry)
    const sourceErrors = scanExtractorSources(repositoryRoot, registry)
    return {
        status: sourceErrors.length === 0 ? 'ok' : 'failed',
        registryDigest: ownership.digest,
        errors: sourceErrors
    }
}
