import { allowedInputSet, readDeclaredJson, sortedUniqueStrings } from '../lib/seed-catalog.mjs'

/**
 * Minimal seed extractor for code-intent-governance.
 * Projects structured code-intent registry facts only.
 */
export function extract(context)
{
    const allowed = allowedInputSet(context.extractor)
    const registry = readDeclaredJson(context.repositoryRoot, 'tests/governance/code-intent-registry.json', allowed)
    const entries = Array.isArray(registry.entries) ? registry.entries : (Array.isArray(registry.intents) ? registry.intents : [])
    const ids = sortedUniqueStrings(entries.map((entry) => entry.id ?? entry.symbol ?? entry.name).filter(Boolean))
    if (ids.length === 0)
    {
        return {
            status: 'failed',
            failureReasons: ['code-intent registry has no stable entry ids'],
            observations: {}
        }
    }
    return {
        status: 'ok',
        failureReasons: [],
        observations: {
            intentEntryCount: ids.length,
            intentEntryIds: ids,
            catalogSchema: String(registry.schema ?? 'unknown')
        }
    }
}
