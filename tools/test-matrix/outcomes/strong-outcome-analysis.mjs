import { types } from 'node:util';

const { digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
import { validateOutcomeFieldDispositions } from './outcome-contract.mjs';
import {
    aggregateRunOutcomeSchema,
    compareFailureTopology,
    failureTopologyIdentity,
    producerSemanticOutcomeSchema,
    validateAggregateRunOutcomeData,
    validateProducerSemanticOutcomeData
} from './semantic-outcome-contract.mjs';

const excludedCategories = new Set(['evidence-location', 'diagnostic-metadata', 'volatile-metadata']);
const excludedRules = new Set(['content-seal', 'derived-digest']);
const omitted = Symbol('registered non-semantic field');
const recordKeys = {
    'records-by-id': 'id',
    'records-by-semantic-id': 'semanticId',
    'records-by-policy-id': 'policyId',
    'records-by-projection-id': 'projectionId',
    'records-by-producer-id': 'producerId'
};

function require(condition, message)
{
    if (!condition)
    {
        throw new Error(`strong outcome analysis: ${message}`);
    }
}

/** Admit descriptor-safe JSON with mandatory host budgets before hashing or cloning. */
export function assertOutcomeAnalysisData(value, limits)
{
    const limitKeys = ['maxDepth', 'maxNodes', 'maxStringBytes', 'maxArrayItems', 'maxObjectKeys'];
    require(limits && !types.isProxy(limits) && Object.getPrototypeOf(limits) === Object.prototype,
        'host limits must be a plain record');
    const descriptors = Object.getOwnPropertyDescriptors(limits);
    require(Reflect.ownKeys(limits).length === limitKeys.length
        && limitKeys.every((key) => descriptors[key]?.enumerable
            && Object.hasOwn(descriptors[key], 'value')
            && Number.isSafeInteger(descriptors[key].value) && descriptors[key].value > 0),
    'host limits must be exact positive finite data');
    const active = new WeakSet();
    const pending = [{ value, depth: 0 }];
    let nodes = 1;
    let bytes = 0;
    const charge = (text) =>
    {
        bytes += Buffer.byteLength(text);
        require(bytes <= limits.maxStringBytes, 'string byte budget exceeded');
    };
    while (pending.length)
    {
        const frame = pending.pop();
        if (frame.exit)
        {
            active.delete(frame.value);
            continue;
        }
        require(frame.depth <= limits.maxDepth, 'depth budget exceeded');
        const item = frame.value;
        if (item === null || typeof item === 'boolean')
        {
            continue;
        }
        if (typeof item === 'string')
        {
            charge(item);
            continue;
        }
        if (typeof item === 'number')
        {
            require(Number.isFinite(item) && !Object.is(item, -0), 'invalid JSON number');
            continue;
        }
        require(typeof item === 'object' && !types.isProxy(item), 'plain JSON data required');
        require(!active.has(item), 'cyclic data');
        const array = Array.isArray(item);
        require(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype), 'plain JSON prototype required');
        if (array)
        {
            require(item.length <= limits.maxArrayItems && item.length <= limits.maxNodes - nodes,
                'array/node budget exceeded');
        }
        const keys = Reflect.ownKeys(item).filter((key) => !array || key !== 'length');
        require(keys.length <= limits.maxObjectKeys && (!array || keys.length === item.length),
            'object budget or dense array shape invalid');
        nodes += keys.length;
        require(nodes <= limits.maxNodes, 'node budget exceeded');
        active.add(item);
        pending.push({ value: item, exit: true });
        for (const key of keys)
        {
            require(typeof key === 'string', 'symbol field forbidden');
            if (array)
            {
                require(/^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < item.length, 'array property forbidden');
            }
            else
            {
                charge(key);
            }
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            require(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'accessor or hidden field forbidden');
            pending.push({ value: descriptor.value, depth: frame.depth + 1 });
        }
    }
}

function compare(left, right)
{
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value, schemaPath, declarations, semanticOnly)
{
    const entry = declarations.get(schemaPath);
    require(schemaPath === '$' || entry, `unknown field ${schemaPath}`);
    const rule = entry?.normalizationRule ?? 'schema-object';
    let result;
    if (['schema-object', 'canonical-object', 'nullable-schema-object'].includes(rule))
    {
        if (value === null && rule === 'nullable-schema-object')
        {
            result = null;
        }
        else
        {
            require(value !== null && typeof value === 'object' && !Array.isArray(value), `${schemaPath} must be an object`);
            result = {};
            for (const key of Object.keys(value).sort())
            {
                const child = normalize(value[key], `${schemaPath}.${key}`, declarations, semanticOnly);
                if (child !== omitted)
                {
                    Object.defineProperty(result, key, { value: child, enumerable: true });
                }
            }
        }
    }
    else if (rule === 'ids' || rule === 'canonical-record-set' || Object.hasOwn(recordKeys, rule))
    {
        require(Array.isArray(value), `${schemaPath} must be an array`);
        const records = value.map((item) =>
        {
            const normalized = normalize(item, `${schemaPath}[]`, declarations, semanticOnly);
            const key = rule === 'ids' ? normalized : rule === 'canonical-record-set'
                ? failureTopologyIdentity(item) : item[recordKeys[rule]];
            require(typeof key === 'string' && key.length > 0, `${schemaPath} record identity missing`);
            return { key, value: normalized };
        });
        require(new Set(records.map((item) => item.key)).size === records.length, `${schemaPath} duplicate identity`);
        result = records.sort((left, right) => rule === 'canonical-record-set'
            ? compareFailureTopology(left.value, right.value) : compare(left.key, right.key)).map((item) => item.value);
    }
    else if (['text', 'digest', 'exact', 'positive-integer', 'boolean', 'content-seal', 'derived-digest'].includes(rule))
    {
        require(value === null || ['string', 'boolean', 'number'].includes(typeof value), `${schemaPath} must be scalar`);
        if (rule === 'text')
        {
            require(typeof value === 'string' && value.length > 0, `${schemaPath} must be text`);
        }
        if (['digest', 'content-seal', 'derived-digest'].includes(rule))
        {
            require(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value), `${schemaPath} must be a digest`);
        }
        if (rule === 'positive-integer')
        {
            require(Number.isSafeInteger(value) && value > 0, `${schemaPath} must be positive`);
        }
        if (rule === 'boolean')
        {
            require(typeof value === 'boolean', `${schemaPath} must be boolean`);
        }
        result = value;
    }
    else if (rule === 'nonnegative-number')
    {
        require(typeof value === 'number' && value >= 0, `${schemaPath} must be nonnegative`);
        result = value;
    }
    else if (rule === 'redacted-secret')
    {
        throw new Error('strong outcome analysis: original secret semantic-context authority bridge required');
    }
    else
    {
        throw new Error(`strong outcome analysis: unsupported registry rule ${rule}`);
    }
    if (semanticOnly && (excludedCategories.has(entry?.category) || excludedRules.has(rule)))
    {
        return omitted;
    }
    return result;
}

function freeze(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

/**
 * Canonical strong-schema DATA_ONLY analysis. External expectations bind original
 * data; recomputed fingerprints authenticate neither its producer nor its execution.
 * Aggregate analysis also requires exact member data and original member expectations.
 */
export function analyzeStrongSemanticOutcome(value, options, metadata = {}, members = [])
{
    require(options && !types.isProxy(options), 'external contract options required');
    const limitDescriptor = Object.getOwnPropertyDescriptor(options, 'hostExpectedLimits');
    require(limitDescriptor && Object.hasOwn(limitDescriptor, 'value'), 'external host limits required');
    const limits = limitDescriptor.value;
    assertOutcomeAnalysisData({ value, options, metadata, members }, limits);
    const registry = validateOutcomeFieldDispositions(options.fieldDispositions, limits);
    const declaration = registry.canonicalization.schemas.find((item) => item.schema === value.schema);
    require(declaration && [producerSemanticOutcomeSchema, aggregateRunOutcomeSchema].includes(value.schema),
        'schema version mismatch');
    const map = new Map(declaration.fields.map((item) => [item.schemaPath, item]));
    const metadataMap = new Map(registry.canonicalization.nestedFields
        .filter((item) => item.schemaPath.startsWith('$metadata')).map((item) => [item.schemaPath, item]));
    const canonical = normalize(value, '$', map, false);
    // Verify the supplied raw content seal before reordering any collection.
    const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => map.get(`$.${key}`)?.normalizationRule !== 'content-seal'));
    require(digestCanonical(unsigned) === value.contentDigest, 'input content digest mismatch');
    const canonicalOutcome = sealContentDigest(canonical);
    if (value.schema === producerSemanticOutcomeSchema)
    {
        validateProducerSemanticOutcomeData(canonicalOutcome, options);
    }
    else
    {
        validateAggregateRunOutcomeData(canonicalOutcome, options, members);
    }
    const canonicalMetadata = normalize(metadata, '$metadata', metadataMap, false);
    const semanticPayload = {
        outcome: normalize(canonicalOutcome, '$', map, true),
        metadata: normalize(metadata, '$metadata', metadataMap, true)
    };
    const version = {
        schema: value.schema,
        schemaVersion: canonical.schemaVersion,
        algorithm: canonical.fingerprintAlgorithmVersion,
        registryVersion: registry.schemaVersion,
        registryDigest: options.expectedContractDigests.fieldDispositions,
        producerSchemaDigest: options.expectedContractDigests.producerSchema,
        aggregateSchemaDigest: options.expectedContractDigests.aggregateSchema
    };
    return freeze({
        schema: 'fsusblog.strong-outcome-analysis.v1',
        dataOnly: true,
        producerVerificationPending: true,
        version,
        inputContentDigest: value.contentDigest,
        canonicalOutcome,
        metadata: canonicalMetadata,
        semanticPayload,
        semanticPayloadDigest: digestCanonical(semanticPayload),
        outcomeFingerprint: digestCanonical({ version, semanticPayload })
    });
}
