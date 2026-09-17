import { allowedInputSet, readDeclaredJson, sortedUniqueStrings } from '../lib/seed-catalog.mjs'

/**
 * Minimal seed extractor for test-asset-audit-reconciliation.
 * Projects structured coverage-registry facts only; not a full business audit.
 */
export function extract(context)
{
    const allowed = allowedInputSet(context.extractor)
    const catalog = readDeclaredJson(context.repositoryRoot, 'tests/coverage-registry.json', allowed)
    const entries = Array.isArray(catalog.entries) ? catalog.entries : []
    const ids = sortedUniqueStrings(entries.map((entry) => entry.id).filter(Boolean))
    if (ids.length === 0)
    {
        return {
            status: 'failed',
            failureReasons: ['coverage-registry has no entry ids'],
            observations: {}
        }
    }
    return {
        status: 'ok',
        failureReasons: [],
        observations: {
            coverageEntryCount: ids.length,
            coverageEntryIds: ids,
            catalogSchema: String(catalog.schema ?? 'unknown')
        }
    }
}
