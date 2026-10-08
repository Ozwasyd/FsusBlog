const {verifyGeneratedContentShape} = await import(new URL('../test-fixtures/content-shape-generator.mjs', import.meta.url));
const {contentShapeCatalogDigest} = await import(new URL('../testing/content-shape-catalog.mjs', import.meta.url));
const {resolveTemporalRoles, verifyResolvedTemporalArtifact} = await import(new URL('../test/temporal-role-resolver.mjs', import.meta.url));

function requireText(value, name)
{
    if (typeof value !== 'string' || value.trim().length === 0)
    {
        throw new Error(`[comment-scale-artifact-adapters] ${name} is required`);
    }
    return value;
}

function requireReference(reference, name)
{
    requireText(reference?.schema, `${name}.schema`);
    requireText(reference?.contentDigest, `${name}.contentDigest`);
}

function requireEqual(actual, expected, name)
{
    if (actual !== expected)
    {
        throw new Error(`[comment-scale-artifact-adapters] ${name} does not match independently supplied expectation`);
    }
}

function freezeSnapshot(value)
{
    if (value !== null && typeof value === 'object')
    {
        for (const child of Object.values(value))
        {
            freezeSnapshot(child);
        }
        Object.freeze(value);
    }
    return value;
}

/**
 * Verifies the original generated content artifact against caller-owned role,
 * shape and artifact/catalog references. The caller supplies the original
 * content authority and independent expectations; deriving them from document
 * at admission would only check self-consistency. Content roles are caller
 * bindings, not a new role catalog. Returns the original artifact format only;
 * this does not qualify a comment graph, credentials or native admission.
 */
export function verifyCommentScaleContentArtifact({document, contentRole, authority, expected} = {})
{
    requireText(contentRole, 'contentRole');
    requireText(expected?.contentRole, 'expected.contentRole');
    requireText(expected?.shapeId, 'expected.shapeId');
    requireReference(expected?.contentReference, 'expected.contentReference');
    requireReference(expected?.catalogReference, 'expected.catalogReference');
    if (!authority || typeof authority !== 'object')
    {
        throw new Error('[comment-scale-artifact-adapters] original content authority is required');
    }
    requireEqual(contentRole, expected.contentRole, 'contentRole');

    const verified = verifyGeneratedContentShape(structuredClone(document), { authority });
    requireEqual(verified.fieldId, 'comment.content', 'content field');
    requireEqual(verified.shapeId, expected.shapeId, 'content shape');
    requireEqual(verified.eligibility, 'positive', 'content eligibility');
    requireEqual(verified.expectedValidity, true, 'content validity');
    requireEqual(verified.schema, expected.contentReference.schema, 'content schema');
    requireEqual(verified.outputDigest, expected.contentReference.contentDigest, 'content artifact digest');
    requireEqual(authority.catalog.schema, expected.catalogReference.schema, 'content catalog schema');
    requireEqual(contentShapeCatalogDigest(authority), expected.catalogReference.contentDigest, 'content catalog digest');
    requireEqual(verified.contentShapeCatalogDigest, expected.catalogReference.contentDigest, 'artifact content catalog digest');
    return freezeSnapshot(structuredClone(verified));
}

/**
 * Verifies an original resolved temporal artifact with an independently supplied
 * original context, fixture identity, shape, nonempty role roster and reference.
 * Re-resolution belongs to the original resolver; unavailable comment shapes or
 * roles fail there. This generic artifact binding check supplies no comment
 * producer qualification, graph completeness, runtime clock or admission proof.
 */
export function verifyCommentScaleTemporalArtifact({artifact, temporalContext, expected} = {})
{
    if (!temporalContext || typeof temporalContext !== 'object')
    {
        throw new Error('[comment-scale-artifact-adapters] original temporalContext is required');
    }
    if (!expected?.fixtureIdentity || typeof expected.fixtureIdentity !== 'object')
    {
        throw new Error('[comment-scale-artifact-adapters] expected.fixtureIdentity is required');
    }
    requireText(expected?.shapeId, 'expected.shapeId');
    if (!Array.isArray(expected?.roleIds) || expected.roleIds.length === 0)
    {
        throw new Error('[comment-scale-artifact-adapters] expected.roleIds must be an explicit nonempty roster');
    }
    requireReference(expected?.artifactReference, 'expected.artifactReference');

    const snapshot = structuredClone(artifact);
    const context = structuredClone(temporalContext);
    verifyResolvedTemporalArtifact(snapshot, { temporalContext: context });
    requireEqual(snapshot.schema, expected.artifactReference.schema, 'temporal artifact schema');
    requireEqual(snapshot.contentDigest, expected.artifactReference.contentDigest, 'temporal artifact digest');
    const resolved = resolveTemporalRoles({
        temporalContext: context,
        fixtureIdentity: structuredClone(expected.fixtureIdentity),
        shapeId: expected.shapeId,
        roleIds: structuredClone(expected.roleIds)
    });
    requireEqual(snapshot.contentDigest, resolved.contentDigest, 'temporal fixture/context/shape/role binding');
    return freezeSnapshot(snapshot);
}
