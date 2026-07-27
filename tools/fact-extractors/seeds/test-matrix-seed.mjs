import { allowedInputSet, readDeclaredText, sortedUniqueStrings } from '../lib/seed-catalog.mjs'

/**
 * Minimal seed extractor for browserless-production-correctness.
 * Projects matrix tier identifiers from the formal matrix file only.
 */
export function extract(context)
{
    const allowed = allowedInputSet(context.extractor)
    const text = readDeclaredText(context.repositoryRoot, 'tests/matrix.yml', allowed)
    const tierMatches = [...text.matchAll(/^\s{2}([a-z][a-z0-9-]*)\s*:/gmu)].map((match) => match[1])
    const tiers = sortedUniqueStrings(tierMatches)
    if (tiers.length === 0)
    {
        return {
            status: 'failed',
            failureReasons: ['matrix.yml exposes no tier identifiers'],
            observations: {}
        }
    }
    return {
        status: 'ok',
        failureReasons: [],
        observations: {
            matrixTierCount: tiers.length,
            matrixTier: tiers,
            matrixByteLength: Buffer.byteLength(text, 'utf8')
        }
    }
}
