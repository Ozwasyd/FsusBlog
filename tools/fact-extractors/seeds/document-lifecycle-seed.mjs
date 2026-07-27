import { allowedInputSet, readDeclaredJson, sortedUniqueStrings } from '../lib/seed-catalog.mjs'

/**
 * Minimal seed extractor for document-lifecycle-governance.
 * Projects formal lifecycle catalog structure only; does not read Markdown bodies.
 */
export function extract(context)
{
    const allowed = allowedInputSet(context.extractor)
    const lifecycle = readDeclaredJson(context.repositoryRoot, 'config/development/document-lifecycle.json', allowed)
    const documents = Array.isArray(lifecycle.documents) ? lifecycle.documents : []
    const paths = sortedUniqueStrings(documents.map((entry) => entry.path).filter(Boolean))
    const statuses = sortedUniqueStrings(documents.map((entry) => entry.status).filter(Boolean))
    if (paths.length === 0)
    {
        return {
            status: 'failed',
            failureReasons: ['document lifecycle catalog has no document paths'],
            observations: {}
        }
    }
    return {
        status: 'ok',
        failureReasons: [],
        observations: {
            documentCount: paths.length,
            documentStatuses: statuses,
            catalogSchema: String(lifecycle.schema ?? 'unknown')
        }
    }
}
