const { digestCanonical, TemporalContractError } = await import(new URL('../test/temporal-context.mjs', import.meta.url));
const {
    projectTemporalRolesForBrowser,
    projectTemporalRolesForDotNet,
    projectTemporalRolesForPostgres,
    resolveTemporalRoles,
    verifyResolvedTemporalArtifact
} = await import(new URL('../test/temporal-role-resolver.mjs', import.meta.url));

const verifiedBindings = new WeakSet();

function fail(message)
{
    throw new TemporalContractError('temporal.business-binding-invalid', message);
}

/**
 * Bind database fields to an independently held canonical role artifact.
 * Resolve once at ingress; consumers copy exact instants without offset arithmetic.
 * This is a field projection, not a producer execution or qualification receipt.
 */
export function bindTemporalBusinessFields({ temporalContext, artifact, expected, fieldMappings })
{
    if (!expected || !/^sha256:[a-f0-9]{64}$/u.test(expected.artifactDigest ?? ''))
    {
        fail('an independently held resolved artifact digest is required');
    }
    const snapshot = structuredClone(artifact);
    verifyResolvedTemporalArtifact(snapshot, { temporalContext });
    if (snapshot.contentDigest !== expected.artifactDigest)
    {
        fail('resolved artifact does not match the held digest');
    }
    for (const field of ['producerId', 'runId', 'namespace', 'fixtureId', 'planDigest'])
    {
        if (typeof expected[field] !== 'string' || !expected[field]
            || snapshot.fixtureIdentity[field] !== expected[field])
        {
            fail(`resolved artifact does not match held ${field}`);
        }
    }
    if (snapshot.shape.id !== expected.shapeId)
    {
        fail('resolved artifact does not match held shapeId');
    }
    // The canonical verifier checks digests and offsets. Re-resolving also binds
    // owner, state and runtime projection to the catalog rather than caller data.
    const canonical = resolveTemporalRoles({
        temporalContext,
        shapeId: expected.shapeId,
        fixtureIdentity: snapshot.fixtureIdentity,
        roleIds: snapshot.roles.map((role) => role.roleId)
    });
    if (canonical.contentDigest !== snapshot.contentDigest)
    {
        fail('resolved artifact differs from the canonical resolver output');
    }
    if (!Array.isArray(fieldMappings) || fieldMappings.length === 0 || fieldMappings.length > 1000)
    {
        fail('a bounded nonempty business field mapping is required');
    }
    const roles = new Map(canonical.roles.map((role) => [role.roleId, role]));
    const fields = new Map();
    const postgres = new Map(projectTemporalRolesForPostgres(canonical).roles.map((role) => [role.roleId, role]));
    const dotnet = new Map(projectTemporalRolesForDotNet(canonical).roles.map((role) => [role.roleId, role]));
    const browser = new Map(projectTemporalRolesForBrowser(canonical).roles.map((role) => [role.roleId, role]));
    for (const mapping of fieldMappings)
    {
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(mapping?.field ?? '')
            || fields.has(mapping.field))
        {
            fail('business field names must be stable and unique');
        }
        const role = roles.get(mapping.roleId);
        if (!role)
        {
            fail(`${mapping.field} requires unresolved canonical role ${mapping.roleId}`);
        }
        fields.set(mapping.field, Object.freeze({
            field: mapping.field,
            roleId: role.roleId,
            instantUtc: role.instantUtc,
            epochMilliseconds: role.epochMilliseconds,
            expectedBusinessState: role.expectedBusinessState,
            roleDigest: role.digest,
            postgresLiteral: postgres.get(role.roleId).timestamptzLiteral,
            dotnetUtc: dotnet.get(role.roleId).dateTimeOffsetUtc,
            browserUtc: browser.get(role.roleId).instantUtc
        }));
    }
    const values = Object.freeze([...fields.values()].sort((left, right) => left.field < right.field ? -1 : left.field > right.field ? 1 : 0));
    const binding = Object.freeze({
        artifactDigest: canonical.contentDigest,
        contextDigest: canonical.contextIdentity.contextDigest,
        catalogDigest: canonical.catalog.digest,
        shapeDigest: canonical.shape.digest,
        fields: values,
        semanticDigest: digestCanonical({ temporal: canonical.semanticDigest, fields: values }),
        requireField(field)
        {
            const value = fields.get(field);
            if (!value)
            {
                fail(`unbound business field ${field}`);
            }
            return value;
        }
    });
    verifiedBindings.add(binding);
    return binding;
}

/** Verify a complete observed field set; timestamps remain inside its digest. */
export function verifyObservedTemporalBusinessFields(binding, observed)
{
    if (!verifiedBindings.has(binding))
    {
        fail('observation verification requires a binding created by this consumer');
    }
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)
        || digestCanonical(Object.keys(observed).sort()) !== digestCanonical(binding.fields.map((field) => field.field).sort()))
    {
        fail('observed business fields must exact-match the bound field set');
    }
    for (const field of binding.fields)
    {
        if (observed[field.field] !== field.instantUtc)
        {
            fail(`observed business timestamp differs for ${field.field}`);
        }
    }
    return Object.freeze({
        artifactDigest: binding.artifactDigest,
        semanticDigest: binding.semanticDigest,
        observedDigest: digestCanonical(observed),
        fieldCount: binding.fields.length
    });
}
