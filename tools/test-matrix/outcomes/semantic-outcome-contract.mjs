import { types } from 'node:util';

const { digestCanonical } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));

export const producerSemanticOutcomeSchema = 'fsusblog.producer-semantic-outcome.v1';
export const aggregateRunOutcomeSchema = 'fsusblog.aggregate-run-outcome.v1';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const categories = new Set([
    'semantic-outcome', 'execution-identity', 'evidence-location',
    'diagnostic-metadata', 'volatile-metadata', 'secret-redacted'
]);

function fail(message)
{
    throw new Error(`semantic outcome contract: ${message}`);
}

function exactKeys(value, fields, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort()))
    {
        fail(`${label} fields must exactly match`);
    }
}

function dataRecord(value, label)
{
    if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
            || !Object.getOwnPropertyDescriptor(value, key).enumerable
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    {
        fail(`${label} must have plain own data properties`);
    }
}

function boundedData(value, limits)
{
    dataRecord(limits, 'host limits');
    exactKeys(limits, ['maxDepth', 'maxNodes', 'maxStringBytes', 'maxArrayItems', 'maxObjectKeys'], 'host limits');
    if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1))
    {
        fail('host limits must be explicit positive finite integers');
    }
    const ancestors = new Set();
    let nodes = 0;
    function visit(item, depth)
    {
        if (types.isProxy(item))
        {
            fail('proxy data is forbidden');
        }
        if (++nodes > limits.maxNodes || depth > limits.maxDepth)
        {
            fail('plain data budget exceeded');
        }
        if (item === null || typeof item === 'boolean')
        {
            return;
        }
        if (typeof item === 'number')
        {
            if (!Number.isFinite(item) || Object.is(item, -0))
            {
                fail('non-finite or negative-zero number');
            }
            return;
        }
        if (typeof item === 'string')
        {
            if (new TextEncoder().encode(item).length > limits.maxStringBytes)
            {
                fail('string byte budget exceeded');
            }
            return;
        }
        if (typeof item !== 'object' || ancestors.has(item))
        {
            fail('data must be plain bounded acyclic JSON');
        }
        const array = Array.isArray(item);
        if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)
            && !(Object.getPrototypeOf(item) === null && !array))
        {
            fail('non-plain data prototype');
        }
        const keys = Reflect.ownKeys(item);
        if (keys.some((key) => typeof key !== 'string'))
        {
            fail('symbol field is forbidden');
        }
        const payloadKeys = array ? keys.filter((key) => key !== 'length') : keys;
        if (payloadKeys.length > limits.maxObjectKeys
            || (array && (item.length > limits.maxArrayItems || payloadKeys.length !== item.length)))
        {
            fail('object or array budget/shape exceeded');
        }
        ancestors.add(item);
        for (const key of payloadKeys)
        {
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
                || (array && !/^(0|[1-9][0-9]*)$/u.test(key)))
            {
                fail('accessor, hidden or non-index data field');
            }
            visit(descriptor.value, depth + 1);
        }
        ancestors.delete(item);
    }
    visit(value, 0);
}

function sameData(left, right)
{
    if (Object.is(left, right))
    {
        return true;
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
        || Array.isArray(left) !== Array.isArray(right))
    {
        return false;
    }
    const keys = Object.keys(left).sort();
    return JSON.stringify(keys) === JSON.stringify(Object.keys(right).sort())
        && keys.every((key) => sameData(left[key], right[key]));
}

function equal(left, right, label)
{
    if (!sameData(left, right))
    {
        fail(`${label} mismatch`);
    }
}

function sortedUnique(values, label, key = (value) => value)
{
    if (!Array.isArray(values))
    {
        fail(`${label} must be an array`);
    }
    const keys = values.map(key);
    if (keys.some((item) => typeof item !== 'string' || !item)
        || JSON.stringify(keys) !== JSON.stringify([...new Set(keys)].sort()))
    {
        fail(`${label} must be sorted and unique`);
    }
    return keys;
}

/** Preserve the four string boundaries in an admitted failure record's identity. */
export function failureTopologyIdentity(value)
{
    return JSON.stringify([value.producerId, value.testId, value.assertionId, value.failureKind]);
}

/** Retain legacy fingerprint ordering; only slash-key collisions use the tuple tie-break. */
export function compareFailureTopology(left, right)
{
    const legacyKey = (value) => `${value.producerId}/${value.testId}/${value.assertionId}/${value.failureKind}`;
    const leftKey = legacyKey(left);
    const rightKey = legacyKey(right);
    if (leftKey !== rightKey)
    {
        return leftKey < rightKey ? -1 : 1;
    }
    const leftIdentity = failureTopologyIdentity(left);
    const rightIdentity = failureTopologyIdentity(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function sortedFailureTopology(values)
{
    if (!Array.isArray(values)
        || new Set(values.map(failureTopologyIdentity)).size !== values.length
        || values.some((value, index) => index > 0 && compareFailureTopology(values[index - 1], value) > 0))
    {
        fail('failure topology must be sorted and unique');
    }
}

function resolveSchema(rule, contracts, seen = new Set(), traversal = null, depth = 0)
{
    if (traversal && (++traversal.nodes > traversal.limits.maxNodes || depth > traversal.limits.maxDepth))
    {
        fail('schema traversal node/depth budget exceeded');
    }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || seen.has(rule))
    {
        fail('invalid or cyclic schema reference');
    }
    if (!Object.hasOwn(rule, '$ref'))
    {
        return { rule, contracts, depth };
    }
    if (typeof rule.$ref !== 'string'
        || !/^(?:producer-semantic-outcome\.schema\.json)?#(?:\/\$defs\/[A-Za-z][A-Za-z0-9]*)?$/u.test(rule.$ref))
    {
        fail('unknown schema reference');
    }
    seen.add(rule);
    const [file, pointer] = rule.$ref.split('#');
    const document = file ? contracts.producerSchema : contracts.activeSchema;
    if (file && file !== 'producer-semantic-outcome.schema.json')
    {
        fail('unknown schema reference');
    }
    const resolved = pointer.split('/').slice(1).reduce((item, key) =>
        item && Object.hasOwn(item, key) ? item[key] : undefined, document);
    if (!resolved)
    {
        fail('unresolved schema reference');
    }
    return resolveSchema(resolved, { ...contracts, activeSchema: document }, seen, traversal, depth + 1);
}

function validateShape(value, rule, contracts, label = '$')
{
    ({ rule, contracts } = resolveSchema(rule, contracts));
    if (rule.anyOf)
    {
        for (const alternative of rule.anyOf)
        {
            try
            {
                validateShape(value, alternative, contracts, label);
                return;
            }
            catch (error)
            {
                if (!(error instanceof Error))
                {
                    throw error;
                }
            }
        }
        fail(`${label} has no allowed type`);
    }
    if (Object.hasOwn(rule, 'const') && value !== rule.const)
    {
        fail(`${label} version/value mismatch`);
    }
    if (rule.enum && !rule.enum.includes(value))
    {
        fail(`${label} unknown enum`);
    }
    if (!rule.type)
    {
        return;
    }
    const matches = rule.type === 'null' ? value === null
        : rule.type === 'array' ? Array.isArray(value)
        : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type;
    if (!matches || (rule.minimum !== undefined && value < rule.minimum))
    {
        fail(`${label} has invalid type/value`);
    }
    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value))
    {
        fail(`${label} grammar mismatch`);
    }
    if (rule.type === 'object')
    {
        const required = rule.required ?? [];
        const properties = rule.properties ?? {};
        if (required.some((key) => !Object.hasOwn(value, key))
            || (rule.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))))
        {
            fail(`${label} missing or unknown field`);
        }
        for (const [key, item] of Object.entries(value))
        {
            validateShape(item, properties[key] ?? rule.additionalProperties, contracts, `${label}.${key}`);
        }
    }
    if (rule.type === 'array')
    {
        if (rule.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
        {
            fail(`${label} duplicate member`);
        }
        value.forEach((item) => validateShape(item, rule.items, contracts, `${label}[]`));
    }
}

function schemaPaths(rule, contracts, traversal, label = '$', result = new Set(), ancestors = new Set(), depth = 0)
{
    ({ rule, contracts, depth } = resolveSchema(rule, contracts, new Set(), traversal, depth));
    if (ancestors.has(rule))
    {
        fail('cyclic resolved schema traversal');
    }
    if (new TextEncoder().encode(label).length > traversal.limits.maxStringBytes)
    {
        fail('schema path byte budget exceeded');
    }
    if (label !== '$')
    {
        result.add(label);
        if (result.size > traversal.limits.maxArrayItems)
        {
            fail('schema path count budget exceeded');
        }
    }
    ancestors.add(rule);
    for (const alternative of rule.anyOf ?? [])
    {
        schemaPaths(alternative, contracts, traversal, label, result, ancestors, depth + 1);
    }
    for (const [key, child] of Object.entries(rule.properties ?? {}))
    {
        schemaPaths(child, contracts, traversal, `${label}.${key}`, result, ancestors, depth + 1);
    }
    if (rule.items)
    {
        schemaPaths(rule.items, contracts, traversal, `${label}[]`, result, ancestors, depth + 1);
    }
    ancestors.delete(rule);
    return result;
}

/** Returns bounded DATA_ONLY schema metadata, not producer or execution authority. */
export function getSemanticOutcomeSchemaPaths(schemaId, schemas, hostExpectedLimits)
{
    dataRecord(schemas, 'schema query materials');
    exactKeys(schemas, ['producerSchema', 'aggregateSchema'], 'schema query materials');
    boundedData(schemas, hostExpectedLimits);
    if (schemaId !== producerSemanticOutcomeSchema && schemaId !== aggregateRunOutcomeSchema)
    {
        fail('schema query identity mismatch');
    }
    if (schemas.producerSchema.properties?.schema?.const !== producerSemanticOutcomeSchema
        || schemas.aggregateSchema.properties?.schema?.const !== aggregateRunOutcomeSchema)
    {
        fail('schema query materials identity mismatch');
    }
    const contracts = { producerSchema: schemas.producerSchema,
        activeSchema: schemaId === producerSemanticOutcomeSchema ? schemas.producerSchema : schemas.aggregateSchema };
    return [...schemaPaths(contracts.activeSchema, contracts, { limits: hostExpectedLimits, nodes: 0 })].sort();
}

function context(options, schema)
{
    dataRecord(options, 'contract options');
    exactKeys(options, [
        'producerSchema', 'aggregateSchema', 'fieldDispositions', 'failureTaxonomy',
        'producerCatalog', 'expectedContractDigests', 'hostExpectedLimits', 'expected'
    ], 'contract options');
    boundedData(options, options.hostExpectedLimits);
    const bindingNames = ['producerSchema', 'aggregateSchema', 'fieldDispositions', 'failureTaxonomy', 'producerCatalog'];
    exactKeys(options.expectedContractDigests, bindingNames, 'expected contract digests');
    for (const name of bindingNames)
    {
        if (!digestPattern.test(options.expectedContractDigests[name])
            || digestCanonical(options[name]) !== options.expectedContractDigests[name])
        {
            fail(`${name} expected digest mismatch`);
        }
    }
    const contracts = { producerSchema: options.producerSchema, activeSchema: schema === producerSemanticOutcomeSchema
        ? options.producerSchema : options.aggregateSchema };
    if (contracts.activeSchema.properties?.schema?.const !== schema)
    {
        fail('schema identity mismatch');
    }
    const registry = options.fieldDispositions;
    if (registry.schema !== 'fsusblog.outcome-field-dispositions.v2'
        || registry.schemaVersion !== '2'
        || registry.fingerprintAlgorithmVersion !== 'registry-canonical-json-sha256-v2')
    {
        fail('field registry version mismatch');
    }
    const declarations = registry.canonicalization?.schemas;
    if (!Array.isArray(declarations) || new Set(declarations.map((entry) => entry.schema)).size !== declarations.length)
    {
        fail('schema dispositions must be unique and registered');
    }
    const declaration = declarations.find((entry) => entry.schema === schema);
    if (!declaration || !Array.isArray(declaration.fields))
    {
        fail('schema dispositions missing');
    }
    declarations.forEach((entry) => exactKeys(entry, ['schema', 'fields'], 'schema disposition declaration'));
    declaration.fields.forEach((entry) => exactKeys(entry, [
        'schemaPath', 'category', 'normalizationRule', 'owner', 'proofTestId', 'reasonCode'
    ], 'field disposition'));
    const paths = declaration.fields.map((entry) => entry.schemaPath);
    if (new Set(paths).size !== paths.length
        || declaration.fields.some((entry) => !categories.has(entry.category)
            || ['owner', 'proofTestId', 'normalizationRule', 'reasonCode'].some((field) =>
                typeof entry[field] !== 'string' || !entry[field].trim())))
    {
        fail('unknown, duplicate or unowned disposition');
    }
    equal([...paths].sort(), getSemanticOutcomeSchemaPaths(schema, {
        producerSchema: options.producerSchema, aggregateSchema: options.aggregateSchema
    }, options.hostExpectedLimits), 'schema disposition coverage');
    if (options.failureTaxonomy.schema !== 'fsusblog.outcome-failure-taxonomy.v1')
    {
        fail('taxonomy version mismatch');
    }
    exactKeys(options.failureTaxonomy, ['schema', 'kinds'], 'failure taxonomy');
    options.failureTaxonomy.kinds.forEach((entry) => exactKeys(entry, [
        'kind', 'requiredIdentity', 'owner', 'proofTestId'
    ], 'failure taxonomy kind'));
    const kinds = sortedUnique(options.failureTaxonomy.kinds, 'failure taxonomy', (entry) => entry.kind);
    if (options.failureTaxonomy.kinds.some((entry) => ['owner', 'proofTestId'].some((field) =>
        typeof entry[field] !== 'string' || !entry[field].trim())
        || !Array.isArray(entry.requiredIdentity) || entry.requiredIdentity.length === 0
        || new Set(entry.requiredIdentity).size !== entry.requiredIdentity.length
        || entry.requiredIdentity.some((field) => typeof field !== 'string' || !field.trim())))
    {
        fail('failure kind missing identity/owner/proof');
    }
    const taxonomy = new Map(kinds.map((kind, index) => [kind, options.failureTaxonomy.kinds[index]]));
    if (options.producerCatalog.schema !== 'fsusblog.correctness-attempt-producers.v1')
    {
        fail('producer catalog version mismatch');
    }
    const producerIds = sortedUnique(options.producerCatalog.entries, 'producer catalog', (entry) => entry.producerId);
    if (options.producerCatalog.entries.some((entry) => ['sourceAuthority', 'artifactOwner', 'executionOwner'].some((field) =>
        typeof entry[field] !== 'string' || !entry[field].trim())))
    {
        fail('producer catalog missing owner');
    }
    return { contracts, taxonomy, producerIds };
}

function testSets(value)
{
    const names = ['plannedTestIds', 'executedTestIds', 'passedTestIds', 'failedTestIds', 'skippedTestIds', 'blockedTestIds'];
    names.forEach((name) => sortedUnique(value[name], name));
    function partition(whole, left, right, label)
    {
        if (left.some((id) => right.includes(id)))
        {
            fail(`${label} overlapping sets`);
        }
        equal(whole, [...left, ...right].sort(), label);
    }
    partition(value.executedTestIds, value.passedTestIds, value.failedTestIds, 'executed partition');
    partition(value.plannedTestIds, value.executedTestIds, [...value.skippedTestIds, ...value.blockedTestIds].sort(), 'planned partition');
    if (value.skippedTestIds.some((id) => value.blockedTestIds.includes(id)))
    {
        fail('skipped and blocked overlap');
    }
}

function failure(value, taxonomy, producerId, assertions)
{
    const rule = taxonomy.get(value.failureKind);
    if (!rule || value.failureClass !== value.failureKind.split('.')[0] || value.producerId !== producerId)
    {
        fail('unknown failure kind/class or producer');
    }
    const required = [...new Set(['producerId', 'testId', 'assertionId', ...rule.requiredIdentity])].sort();
    exactKeys(value.identity, required, 'failure identity');
    if (value.identity.producerId !== producerId || value.identity.testId !== value.testId
        || value.identity.assertionId !== value.assertionId
        || !assertions.some((item) => item.id === value.assertionId && item.testId === value.testId
            && item.status !== 'passed' && item.failureClass === value.failureClass
            && item.failureKind === value.failureKind
            && sameData(item.failureIdentity, value.identity)))
    {
        fail('failure assertion/test identity mismatch');
    }
}

function bindings(value, options)
{
    for (const [field, name] of [
        ['fieldDispositionDigest', 'fieldDispositions'], ['failureTaxonomyDigest', 'failureTaxonomy'],
        ['producerCatalogDigest', 'producerCatalog']
    ])
    {
        if (value[field] !== options.expectedContractDigests[name])
        {
            fail(`${field} mismatch`);
        }
    }
    const unsigned = { ...value };
    delete unsigned.contentDigest;
    if (digestCanonical(unsigned) !== value.contentDigest)
    {
        fail('content digest mismatch');
    }
}

/**
 * Validates DATA_ONLY values against explicit external expectations.
 * This does not canonicalize/fingerprint, verify a producer capability or authorize qualification.
 */
export function validateProducerSemanticOutcomeData(value, options)
{
    const { contracts, taxonomy, producerIds } = context(options, producerSemanticOutcomeSchema);
    boundedData(value, options.hostExpectedLimits);
    validateShape(value, contracts.activeSchema, contracts);
    bindings(value, options);
    const expected = options.expected;
    exactKeys(expected, [
        'identity', 'plannedTestIds', 'assertionIds', 'scenarioIds', 'coverageIds', 'policyDigests',
        'artifactSemanticDigests', 'stateSemanticDigests', 'projectionReceipts', 'redactedSecrets',
        'semanticPayloadDigest', 'outcomeFingerprint'
    ], 'producer expectations');
    const identityKeys = [
        'producerId', 'producerAuthorityId', 'sourceCommit', 'worktreeFingerprint', 'schedulerRunId',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'
    ];
    exactKeys(expected.identity, identityKeys, 'expected producer identity');
    if (!producerIds.includes(value.producerId))
    {
        fail('producer absent from original catalog');
    }
    identityKeys.forEach((field) => equal(value[field], expected.identity[field], field));
    for (const field of [
        'plannedTestIds', 'scenarioIds', 'coverageIds', 'policyDigests', 'artifactSemanticDigests',
        'stateSemanticDigests', 'projectionReceipts', 'redactedSecrets', 'semanticPayloadDigest', 'outcomeFingerprint'
    ])
    {
        equal(value[field], expected[field], `expected ${field}`);
    }
    testSets(value);
    sortedUnique(value.scenarioIds, 'scenario IDs');
    sortedUnique(value.coverageIds, 'coverage IDs');
    for (const [field, key] of [
        ['policyDigests', 'policyId'], ['artifactSemanticDigests', 'semanticId'],
        ['stateSemanticDigests', 'semanticId'], ['projectionReceipts', 'projectionId'], ['redactedSecrets', 'semanticId']
    ])
    {
        sortedUnique(value[field], field, (item) => item[key]);
    }
    equal(sortedUnique(value.assertions, 'assertions', (item) => item.id), expected.assertionIds, 'assertion membership');
    for (const item of value.assertions)
    {
        if (!value.plannedTestIds.includes(item.testId)
            || !value[`${item.status}TestIds`].includes(item.testId))
        {
            fail('assertion status/test partition mismatch');
        }
        if (item.status === 'passed')
        {
            if (item.failureClass !== null || item.failureKind !== null || item.failureIdentity !== null)
            {
                fail('passed assertion carries failure');
            }
        }
        else
        {
            const material = { producerId: value.producerId, testId: item.testId, assertionId: item.id,
                failureClass: item.failureClass, failureKind: item.failureKind, identity: item.failureIdentity };
            failure(material, taxonomy, value.producerId, value.assertions);
            if (!value.failures.some((entry) => sameData(entry, material)))
            {
                fail('assertion failure missing from topology');
            }
        }
    }
    if (value.plannedTestIds.some((id) => !value.assertions.some((item) => item.testId === id)))
    {
        fail('test missing assertion identities');
    }
    sortedFailureTopology(value.failures);
    value.failures.forEach((entry) => failure(entry, taxonomy, value.producerId, value.assertions));
    value.redactedSecrets.forEach((entry) =>
    {
        if (entry.present === (entry.type === 'absent'))
        {
            fail('secret presence/type mismatch');
        }
    });
    const cleanSuccess = value.failedTestIds.length === 0 && value.skippedTestIds.length === 0
        && value.blockedTestIds.length === 0 && value.failures.length === 0
        && value.cleanFirstAttempt === true && value.qualificationEligible === true;
    if (value.producerStatus === 'success' ? !cleanSuccess
        : value.qualificationEligible !== false || value.failures.length === 0)
    {
        fail('producer status/eligibility/failure conflict');
    }
    if ((value.producerStatus === 'failed' && value.failedTestIds.length === 0)
        || (value.producerStatus === 'blocked' && value.blockedTestIds.length === 0)
        || (value.producerStatus === 'partial' && value.failedTestIds.length === 0
            && value.skippedTestIds.length === 0 && value.blockedTestIds.length === 0))
    {
        fail('producer status/test partition conflict');
    }
    return value;
}

/**
 * Checks aggregate DATA_ONLY relationships; required IDs are NOT_AUTHORITY expectations.
 * Actual run applicability and independent held producer verification remain separate mandatory owners.
 */
export function validateAggregateRunOutcomeData(value, options, members)
{
    const { contracts, producerIds } = context(options, aggregateRunOutcomeSchema);
    boundedData(value, options.hostExpectedLimits);
    boundedData(members, options.hostExpectedLimits);
    validateShape(value, contracts.activeSchema, contracts);
    bindings(value, options);
    const expected = options.expected;
    exactKeys(expected, [
        'runId', 'sourceCommit', 'worktreeFingerprint', 'requiredProducerIds', 'requiredCoverageIds',
        'stateSemanticDigests', 'artifactSemanticDigests', 'aggregateOutcomeFingerprint'
    ], 'aggregate expectations');
    sortedUnique(expected.requiredProducerIds, 'external expected required producer IDs');
    if (expected.requiredProducerIds.length === 0
        || expected.requiredProducerIds.some((id) => !producerIds.includes(id)))
    {
        fail('required producer IDs missing or unregistered');
    }
    for (const field of Object.keys(expected))
    {
        equal(value[field], expected[field], `expected ${field}`);
    }
    testSets(value);
    sortedUnique(value.producerOutcomeRefs, 'producer references', (entry) => entry.producerId);
    sortedUnique(value.producerStatusVector, 'producer status vector', (entry) => entry.producerId);
    sortedUnique(members, 'producer members', (entry) => entry.outcome.producerId);
    for (const collection of [value.producerOutcomeRefs, value.producerStatusVector, members.map((entry) => entry.outcome)])
    {
        equal(collection.map((entry) => entry.producerId), value.requiredProducerIds, 'required producer exactness');
    }
    for (const member of members)
    {
        exactKeys(member, ['outcome', 'options'], 'member data');
        equal(member.options.expectedContractDigests, options.expectedContractDigests, 'member contract sources');
        validateProducerSemanticOutcomeData(member.outcome, member.options);
        const outcome = member.outcome;
        for (const field of ['sourceCommit', 'worktreeFingerprint', 'fieldDispositionDigest', 'failureTaxonomyDigest', 'producerCatalogDigest'])
        {
            equal(outcome[field], value[field], `member ${field}`);
        }
        equal(outcome.schedulerRunId, value.runId, 'member run');
        const reference = value.producerOutcomeRefs.find((entry) => entry.producerId === outcome.producerId);
        for (const field of Object.keys(reference))
        {
            equal(reference[field], outcome[field], `producer ref ${field}`);
        }
        equal(value.producerStatusVector.find((entry) => entry.producerId === outcome.producerId).status,
            outcome.producerStatus, 'producer status');
    }
    for (const field of ['plannedTestIds', 'executedTestIds', 'passedTestIds', 'failedTestIds', 'skippedTestIds', 'blockedTestIds', 'coverageIds'])
    {
        const union = [...new Set(members.flatMap((entry) => entry.outcome[field]))].sort();
        equal(value[field === 'coverageIds' ? 'observedCoverageIds' : field], union, `member union ${field}`);
    }
    for (const field of ['stateSemanticDigests', 'artifactSemanticDigests'])
    {
        sortedUnique(value[field], field, (entry) => entry.semanticId);
        const entries = new Map();
        for (const item of members.flatMap((entry) => entry.outcome[field]))
        {
            if (entries.has(item.semanticId))
            {
                equal(entries.get(item.semanticId), item, `semantic owner/digest ${item.semanticId}`);
            }
            entries.set(item.semanticId, item);
        }
        equal(value[field], [...entries.values()].sort((a, b) => a.semanticId < b.semanticId ? -1 : a.semanticId > b.semanticId ? 1 : 0),
            `semantic member union ${field}`);
    }
    sortedUnique(value.requiredCoverageIds, 'required coverage');
    sortedUnique(value.observedCoverageIds, 'observed coverage');
    const topology = members.flatMap((entry) => entry.outcome.failures)
        .sort(compareFailureTopology);
    equal(value.failureTopology, topology, 'failure topology');
    const complete = members.every((entry) => entry.outcome.producerStatus === 'success'
        && entry.outcome.cleanFirstAttempt && entry.outcome.qualificationEligible)
        && value.requiredCoverageIds.every((id) => value.observedCoverageIds.includes(id))
        && value.skippedTestIds.length === 0 && value.blockedTestIds.length === 0;
    equal(value.completenessStatus, complete ? 'complete' : 'incomplete', 'completeness');
    return value;
}
