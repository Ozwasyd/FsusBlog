const { digestCanonical, TemporalContractError } = await import(new URL('../test/temporal-context.mjs', import.meta.url));
const {
    projectTemporalRolesForBrowser,
    projectTemporalRolesForDotNet,
    projectTemporalRolesForPostgres,
    resolveTemporalRoles,
    verifyResolvedTemporalArtifact
} = await import(new URL('../test/temporal-role-resolver.mjs', import.meta.url));

const verifiedBindings = new WeakSet();
const verifiedEntityBindings = new WeakSet();
const verifiedEntityTransports = new WeakMap();

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

function entityFieldKey(coordinate, field)
{
    return JSON.stringify([coordinate?.entityKind, coordinate?.semanticIdentity, coordinate?.operationIdentity, field]);
}

/** Consume the sole resolver's complete entity history, including explicit absence. */
export function bindTemporalEntityBusinessFields({ temporalContext, artifact, expected, fieldMappings })
{
    if (artifact?.schema !== 'fsusblog.resolved-temporal-entities.v1'
        || !/^sha256:[a-f0-9]{64}$/u.test(expected?.artifactDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(expected?.entityPlanDigest ?? ''))
    {
        fail('entity consumption requires independently held artifact and entity plan digests');
    }
    const snapshot = structuredClone(artifact);
    // Entity verification re-resolves the whole ordinary plan through the sole
    // authority. Index its verified result once; never re-resolve per field.
    verifyResolvedTemporalArtifact(snapshot, { temporalContext });
    if (snapshot.contentDigest !== expected.artifactDigest
        || snapshot.entityPlanDigest !== expected.entityPlanDigest
        || snapshot.shape.id !== expected.shapeId)
    {
        fail('entity artifact does not match held artifact, plan or shape identity');
    }
    for (const name of ['producerId', 'runId', 'namespace', 'fixtureId', 'planDigest'])
    {
        if (typeof expected[name] !== 'string' || !expected[name]
            || snapshot.fixtureIdentity[name] !== expected[name])
        {
            fail(`entity artifact does not match held ${name}`);
        }
    }
    if (!Array.isArray(fieldMappings) || fieldMappings.length === 0 || fieldMappings.length > 1000)
    {
        fail('a bounded nonempty entity field mapping is required');
    }
    const unsupported = new Set(snapshot.unsupportedFields.map((item) => item.field));
    const names = new Set();
    for (const mapping of fieldMappings)
    {
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(mapping?.field ?? '') || names.has(mapping.field)
            || !unsupported.has(mapping.field) && !['article', 'comment', 'audit'].includes(mapping.entityKind))
        {
            fail('entity fields require unique stable names and explicit source kinds');
        }
        names.add(mapping.field);
    }
    const revisions = new Map();
    for (const entity of snapshot.entities)
    {
        if (entity.coordinate.entityKind === 'article' && entity.coordinate.revisionNumber !== null)
        {
            revisions.set(JSON.stringify([entity.coordinate.semanticIdentity, entity.coordinate.revisionNumber]),
                entity.roles.find((role) => role.roleId === 'article.revision'));
        }
    }
    const fields = new Map();
    for (const entity of snapshot.entities)
    {
        const roles = new Map(entity.roles.map((role) => [role.roleId, role]));
        const coordinate = Object.freeze({ ...entity.coordinate });
        for (const mapping of fieldMappings)
        {
            if (unsupported.has(mapping.field) || mapping.entityKind !== coordinate.entityKind)
            {
                continue;
            }
            let role = roles.get(mapping.roleId);
            if (!role)
            {
                fail(`${mapping.field} requires an exact resolved entity role ${mapping.roleId}`);
            }
            let rowGenerated = true;
            if (mapping.rowPresence)
            {
                if (typeof entity.stateFacts[mapping.rowPresence] !== 'boolean')
                {
                    fail(`${mapping.field} requires its explicit generated-row state fact`);
                }
                rowGenerated = entity.stateFacts[mapping.rowPresence];
            }
            if (rowGenerated && mapping.publicationRevision)
            {
                role = revisions.get(JSON.stringify([coordinate.semanticIdentity, coordinate.publicationRevisionNumber]));
                if (!role)
                {
                    fail(`${mapping.field} requires its publication's referenced revision`);
                }
            }
            if (rowGenerated && mapping.creationRevision && coordinate.revisionNumber !== 1)
            {
                fail(`${mapping.field} has no supplied creation-only revision mapping for this history`);
            }
            const value = Object.freeze({ coordinate, field: mapping.field, roleId: mapping.roleId, state: entity.state,
                applicability: rowGenerated ? role.applicability : 'not-generated',
                instantUtc: rowGenerated ? role.instantUtc : null,
                epochMilliseconds: rowGenerated ? role.epochMilliseconds : null });
            fields.set(entityFieldKey(coordinate, mapping.field), value);
        }
    }
    const values = Object.freeze([...fields.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, value]) => value));
    const unsupportedFields = Object.freeze(snapshot.unsupportedFields.map((item) => Object.freeze({ ...item })));
    const binding = Object.freeze({ artifactDigest: snapshot.contentDigest, entityPlanDigest: snapshot.entityPlanDigest,
        contextDigest: snapshot.contextIdentity.contextDigest, catalogDigest: snapshot.catalog.digest,
        shapeDigest: snapshot.shape.digest, fields: values, unsupportedFields, qualificationEligible: false,
        semanticDigest: digestCanonical({ temporal: snapshot.semanticDigest, fields: values, unsupportedFields }),
        requireField(coordinate, field)
        {
            const value = fields.get(entityFieldKey(coordinate, field));
            if (!value)
            {
                fail(`unbound or unsupported entity business field ${field}`);
            }
            return value;
        } });
    verifiedEntityBindings.add(binding);
    verifiedEntityTransports.set(binding, { entities: snapshot.entities, rootNested: snapshot.entityPlan.distribution.rootNested });
    return binding;
}

/**
 * Iterate fields from one wholly verified artifact in its original entity order.
 * Packets are transport data, never independently resolved plans or receipts.
 * The canonical whole-plan cap and cross-entity verifier remain unchanged.
 */
export function* iterateTemporalEntityBusinessBatches(binding, { batchSize = 1000, signal } = {})
{
    const source = verifiedEntityTransports.get(binding);
    if (!source || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000_000)
    {
        fail('batch transport requires a verified complete artifact and a bounded positive batch size');
    }
    signal?.throwIfAborted();
    const fields = new Map();
    for (const field of binding.fields)
    {
        signal?.throwIfAborted();
        const key = entityFieldKey(field.coordinate, '');
        if (!fields.has(key))
        {
            fields.set(key, []);
        }
        fields.get(key).push(field);
    }
    const identities = new Map();
    const revisions = new Map();
    for (const [index, entity] of source.entities.entries())
    {
        signal?.throwIfAborted();
        const key = JSON.stringify([entity.coordinate.entityKind, entity.coordinate.semanticIdentity]);
        if (!identities.has(key))
        {
            identities.set(key, index);
        }
        if (entity.coordinate.entityKind === 'article' && entity.coordinate.revisionNumber !== null)
        {
            const revisionKey = JSON.stringify([entity.coordinate.semanticIdentity, entity.coordinate.revisionNumber]);
            if (!revisions.has(revisionKey))
            {
                revisions.set(revisionKey, index);
            }
        }
    }
    const links = new Map(source.rootNested.map((link) => [link.commentIdentity, link]));
    const totalEntityOperations = source.entities.length;
    const batchCount = Math.ceil(totalEntityOperations / batchSize);
    let previousTransportDigest = null;
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++)
    {
        signal?.throwIfAborted();
        const entityStartIndex = batchIndex * batchSize;
        const entities = [];
        for (let index = entityStartIndex; index < Math.min(entityStartIndex + batchSize, totalEntityOperations); index++)
        {
            signal?.throwIfAborted();
            const coordinate = Object.freeze({ ...source.entities[index].coordinate });
            const references = [];
            const reference = (kind, targetIndex) =>
            {
                if (!Number.isSafeInteger(targetIndex))
                {
                    fail('verified global entity reference is missing from transport');
                }
                references.push(Object.freeze({ kind, entityIndex: targetIndex,
                    coordinate: Object.freeze({ ...source.entities[targetIndex].coordinate }) }));
            };
            if (coordinate.entityKind === 'comment')
            {
                reference('article', identities.get(JSON.stringify(['article', coordinate.articleIdentity])));
                const link = links.get(coordinate.semanticIdentity);
                if (link.parentIdentity !== null)
                {
                    reference('parent-comment', identities.get(JSON.stringify(['comment', link.parentIdentity])));
                    reference('root-comment', identities.get(JSON.stringify(['comment', link.rootIdentity])));
                }
            }
            if (coordinate.publicationNumber !== null)
            {
                reference('publication-revision', revisions.get(JSON.stringify([coordinate.semanticIdentity,
                    coordinate.publicationRevisionNumber])));
            }
            entities.push(Object.freeze({ entityIndex: index, coordinate, references: Object.freeze(references),
                fields: Object.freeze(fields.get(entityFieldKey(coordinate, '')) ?? []) }));
        }
        const packet = { transportOnly: true, qualificationEligible: false, artifactDigest: binding.artifactDigest,
            entityPlanDigest: binding.entityPlanDigest, bindingSemanticDigest: binding.semanticDigest,
            contextDigest: binding.contextDigest, catalogDigest: binding.catalogDigest, shapeDigest: binding.shapeDigest,
            batchIndex, batchCount, entityStartIndex, totalEntityOperations, previousTransportDigest,
            unsupportedFields: binding.unsupportedFields,
            entities: Object.freeze(entities) };
        const transportDigest = digestCanonical(packet);
        signal?.throwIfAborted();
        previousTransportDigest = transportDigest;
        yield Object.freeze({ ...packet, transportDigest });
    }
}

/** Refuse unsupported requests before any producer cleanup or business write. */
export function requireCompleteTemporalEntityBinding(binding)
{
    if (!verifiedEntityBindings.has(binding) || binding.unsupportedFields.length > 0)
    {
        fail('complete entity binding requires every requested source field; unsupported fields remain OPEN');
    }
    return binding;
}

/** Preserve NULL versus an ungenerated row in complete, coordinate-bound observations. */
export function verifyObservedTemporalEntityBusinessFields(binding, observed)
{
    if (!verifiedEntityBindings.has(binding) || !Array.isArray(observed) || observed.length !== binding.fields.length)
    {
        fail('entity observations must exact-match a binding created by this consumer');
    }
    const rows = new Map();
    for (const row of observed)
    {
        const key = entityFieldKey(row?.coordinate, row?.field);
        if (rows.has(key))
        {
            fail('duplicate observed entity business coordinate');
        }
        rows.set(key, row);
    }
    for (const field of binding.fields)
    {
        const row = rows.get(entityFieldKey(field.coordinate, field.field));
        if (!row || row.applicability !== field.applicability || row.instantUtc !== field.instantUtc
            || digestCanonical(row.coordinate) !== digestCanonical(field.coordinate)
            || digestCanonical(Object.keys(row).sort()) !== digestCanonical(['applicability', 'coordinate', 'field', 'instantUtc']))
        {
            fail(`observed entity timestamp or applicability differs for ${field.field}`);
        }
    }
    return Object.freeze({ artifactDigest: binding.artifactDigest, semanticDigest: binding.semanticDigest,
        observedDigest: digestCanonical(binding.fields.map((field) => ({ coordinate: field.coordinate,
            field: field.field, applicability: field.applicability, instantUtc: field.instantUtc }))),
        fieldCount: binding.fields.length, qualificationEligible: false });
}
