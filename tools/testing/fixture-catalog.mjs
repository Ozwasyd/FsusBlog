import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

import {
    contentShapeCatalogDigest,
    readContentShapeAuthority,
    validateContentShapeAuthority
} from './content-shape-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = (name) => path.join(root, 'config/testing', name);
const fixtureVariantSchemaFile = path.join(root, 'config/schemas/fixture-variant-catalog.schema.json');
const stableId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const sortedUnique = (values) => Array.isArray(values) && values.every((value, index) => typeof value === 'string' && stableId.test(value) && (!index || values[index - 1] < value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const profileSources = new Set(['dev-cli', 'matrix']);
const sha256Json = (value) => `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;

function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

const requiredFixtureSourceFiles = Object.freeze([
    'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs',
    'src/backend/Modules/Endpoints/LocalAuthFixtureRefreshRunner.cs',
    'src/backend/Modules/Endpoints/LocalMessagingFixtureEndpoints.cs',
    'src/backend/Services/Fixtures/MessagingFixtureSeeder.cs',
    'tools/test-fixtures/producers/account-messaging-producer.mjs',
    'tests/browser-contract/default-fixture-provider.mjs',
    'tests/browser-contract/fixture.mjs',
    'tests/browser-contract/prepare-fixture.mjs',
    'tests/browser-contract/run.mjs',
    'src/backend/Modules/Endpoints/LocalPublicContentFixtureEndpoints.cs',
    'src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs',
    'tools/test-fixtures/producers/public-content-producer.mjs',
    'tests/frontend/fixtures/prepare-auth-smoke-users.mjs',
    'tests/frontend/fixtures/prepare-playwright-sessions.mjs',
    'tests/frontend/support/playwright/global-setup.ts',
    'tests/frontend/support/session-fixtures.mjs',
    'tools/bootstrap-acceptance-env.sh',
    'tools/data-scale/cleanup.sh',
    'tools/data-scale/probe.sh',
    'tools/data-scale/seed.sh',
    'tools/test/lanes/data-scale.sh'
]);

const fixtureDeclarationScanRoots = Object.freeze(['src', 'tests', 'tools']);
const fixtureDeclarationScanExtensions = /\.(?:cs|mjs|sh|sql|ts)$/u;
const fixtureDeclarationScanExclusions = new Set([
    'tests/tools/fixture-catalog.test.mjs',
    'tools/testing/fixture-catalog.mjs',
    'tools/testing/generate-fixture-catalog-artifacts.mjs'
]);

const forbiddenInventoryPhrases = Object.freeze([
    /默认由环境提供/u,
    /已有数据即可/u,
    /\bprovided by (?:the )?environment by default\b/iu,
    /\bexisting data is enough\b/iu,
    /\benvironment provides data by default\b/iu
]);

export const fixtureCatalogFiles = Object.freeze({
    capability: config('fixture-capability-catalog.json'),
    profile: config('fixture-profile-catalog.json'),
    producer: config('fixture-producer-registry.json'),
    inventory: config('fixture-consumer-inventory.generated.json'),
    variant: config('fixture-variant-catalog.json')
});


/**
 * Closed validity vocabulary. This must remain independent from the candidate
 * catalog being validated so a whole-catalog rename cannot validate itself.
 */
export const FIXTURE_VALIDITY_CLASSES = Object.freeze([
    'canonical-positive',
    'diagnostic-only',
    'migration-legacy',
    'negative-invalid',
    'scale-synthetic'
]);

const fixtureExecutionClasses = Object.freeze([
    'acceptance',
    'browser',
    'development',
    'diagnostic',
    'load',
    'runtime',
    'security'
]);
const nonQualificationExecutionClasses = new Set(['acceptance', 'browser', 'runtime']);

function idsFrom(catalog, property)
{
    return new Set((catalog[property] ?? []).map((item) => item.id));
}

function validateExactReferences(values, known, label, errors, { required = true } = {})
{
    if (!Array.isArray(values) || (required && values.length === 0))
    {
        errors.push(`${label} must be a ${required ? 'non-empty ' : ''}array`);
        return;
    }
    if (!sortedUnique(values))
    {
        errors.push(`${label} must be sorted unique stable IDs`);
    }
    validateReferences(values, known, label, errors);
}

function resolveSchemaReference(schemaRoot, reference)
{
    if (typeof reference !== 'string' || !reference.startsWith('#/'))
    {
        return null;
    }
    return reference
        .slice(2)
        .split('/')
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
        .reduce((current, part) => current?.[part], schemaRoot);
}

function validateJsonSchemaValue(schemaRoot, schema, value, location = '$')
{
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    {
        return [`${location} has an invalid schema definition`];
    }
    if (schema.$ref)
    {
        const target = resolveSchemaReference(schemaRoot, schema.$ref);
        return target
            ? validateJsonSchemaValue(schemaRoot, target, value, location)
            : [`${location} has unresolved schema ref ${schema.$ref}`];
    }
    if (schema.anyOf)
    {
        const matches = schema.anyOf
            .map((candidate) => validateJsonSchemaValue(schemaRoot, candidate, value, location))
            .filter((candidateErrors) => candidateErrors.length === 0);
        return matches.length > 0 ? [] : [`${location} must match at least one schema variant`];
    }
    if (schema.oneOf)
    {
        const matches = schema.oneOf
            .map((candidate) => validateJsonSchemaValue(schemaRoot, candidate, value, location))
            .filter((candidateErrors) => candidateErrors.length === 0);
        return matches.length === 1 ? [] : [`${location} must match exactly one schema variant`];
    }

    const errors = [];
    if (schema.const !== undefined && stableStringify(value) !== stableStringify(schema.const))
    {
        errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => stableStringify(candidate) === stableStringify(value)))
    {
        errors.push(`${location} has invalid enum value ${JSON.stringify(value)}`);
    }

    if (schema.type === 'object')
    {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
        {
            return [`${location} must be an object`];
        }
        for (const key of schema.required ?? [])
        {
            if (!Object.hasOwn(value, key))
            {
                errors.push(`${location} missing required property ${key}`);
            }
        }
        if (schema.additionalProperties === false)
        {
            for (const key of Object.keys(value))
            {
                if (!Object.hasOwn(schema.properties ?? {}, key))
                {
                    errors.push(`${location} has additional property ${key}`);
                }
            }
        }
        for (const [key, childSchema] of Object.entries(schema.properties ?? {}))
        {
            if (Object.hasOwn(value, key))
            {
                errors.push(...validateJsonSchemaValue(schemaRoot, childSchema, value[key], `${location}.${key}`));
            }
        }
    }
    else if (schema.type === 'array')
    {
        if (!Array.isArray(value))
        {
            return [`${location} must be an array`];
        }
        if (schema.minItems != null && value.length < schema.minItems)
        {
            errors.push(`${location} requires at least ${schema.minItems} items`);
        }
        if (schema.uniqueItems === true
      && new Set(value.map((item) => stableStringify(item))).size !== value.length)
        {
            errors.push(`${location} must contain unique items`);
        }
        value.forEach((item, index) =>
        {
            errors.push(...validateJsonSchemaValue(schemaRoot, schema.items ?? {}, item, `${location}[${index}]`));
        });
    }
    else if (schema.type === 'string')
    {
        if (typeof value !== 'string')
        {
            return [`${location} must be a string`];
        }
        if (schema.minLength != null && value.length < schema.minLength)
        {
            errors.push(`${location} requires at least ${schema.minLength} characters`);
        }
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
        {
            errors.push(`${location} does not match ${schema.pattern}`);
        }
    }
    else if (schema.type === 'boolean')
    {
        if (typeof value !== 'boolean')
        {
            errors.push(`${location} must be a boolean`);
        }
    }
    else if (schema.type === 'null')
    {
        if (value !== null)
        {
            errors.push(`${location} must be null`);
        }
    }
    else if (schema.type === 'integer')
    {
        if (!Number.isInteger(value))
        {
            errors.push(`${location} must be an integer`);
        }
    }
    else if (schema.type === 'number')
    {
        if (typeof value !== 'number' || !Number.isFinite(value))
        {
            errors.push(`${location} must be a finite number`);
        }
    }
    return errors;
}

/** Validate the sole semantic variant authority and all references it owns. */
export function validateFixtureVariantCatalog({
    variantFile = fixtureCatalogFiles.variant,
    capabilityFile = fixtureCatalogFiles.capability,
    producerFile = fixtureCatalogFiles.producer,
    profileFile = fixtureCatalogFiles.profile,
    schemaFile = fixtureVariantSchemaFile
} = {})
{
    const errors = [];
    let catalog;
    let schema;
    try
    {
        catalog = JSON.parse(fs.readFileSync(variantFile, 'utf8'));
    }
    catch (error)
    {
        return [`fixture variant catalog is unreadable: ${error.message}`];
    }
    try
    {
        schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
        if (schema.$id !== 'fsusblog.fixture-variant-catalog.v1')
        {
            errors.push('fixture variant schema identity is invalid');
        }
        if (schema.additionalProperties !== false)
        {
            errors.push('fixture variant schema root must reject additional properties');
        }
    }
    catch (error)
    {
        errors.push(`fixture variant schema is unreadable: ${error.message}`);
    }
    if (schema)
    {
        errors.push(...validateJsonSchemaValue(schema, schema, catalog)
            .map((error) => `fixture variant schema: ${error}`));
    }
    if (catalog.schema !== 'fsusblog.fixture-variant-catalog.v1')
    {
        errors.push('variant catalog schema identity is invalid');
    }
    if (!Array.isArray(catalog.validityClasses))
    {
        errors.push('variant catalog validityClasses must be an array');
    }
    const classes = catalog.validityClasses ?? [];
    if (classes.length !== FIXTURE_VALIDITY_CLASSES.length)
    {
        errors.push(`variant catalog must declare exactly ${FIXTURE_VALIDITY_CLASSES.length} validity classes`);
    }
    const classIds = classes.map((item) => item.id);
    if (JSON.stringify([...classIds].sort()) !== JSON.stringify([...FIXTURE_VALIDITY_CLASSES].sort()))
    {
        errors.push(`variant catalog validity classes must exactly match ${FIXTURE_VALIDITY_CLASSES.join(', ')}`);
    }
    for (const expected of FIXTURE_VALIDITY_CLASSES)
    {
        if (!classIds.includes(expected))
        {
            errors.push(`variant catalog missing required validity class ${expected}`);
        }
    }
    if (new Set(classIds).size !== classIds.length)
    {
        errors.push('variant catalog has duplicate validity class ids');
    }
    for (const item of classes)
    {
        if (!item.semantics || typeof item.semantics !== 'string')
        {
            errors.push(`validity class ${item.id} must declare semantics`);
        }
        if (!Array.isArray(item.allowedExecutionClasses) || !item.allowedExecutionClasses.length)
        {
            errors.push(`validity class ${item.id} must declare catalog execution policy`);
        }
    }
    const writerContracts = idsFrom(catalog, 'writerContracts');
    const contentShapes = idsFrom(catalog, 'contentShapes');
    const temporalShapes = idsFrom(catalog, 'temporalShapes');
    const mediaShapes = idsFrom(catalog, 'mediaShapes');
    const distributionShapes = idsFrom(catalog, 'distributionShapes');
    const derivedStates = idsFrom(catalog, 'derivedStates');
    const sentinels = catalog.sentinels ?? [];
    const sentinelIds = new Set(sentinels.map((item) => item.id));
    for (const [label, entries] of Object.entries({ writerContracts: catalog.writerContracts, contentShapes: catalog.contentShapes, temporalShapes: catalog.temporalShapes, mediaShapes: catalog.mediaShapes, distributionShapes: catalog.distributionShapes, derivedStates: catalog.derivedStates }))
    {
        const ids = (entries ?? []).map((item) => item.id);
        if (!Array.isArray(entries) || !entries.length || !sortedUnique(ids))
        {
            errors.push(`${label} must declare sorted unique stable IDs`);
        }
    }
    let profiles = [];
    try
    {
        profiles = (JSON.parse(fs.readFileSync(profileFile, 'utf8')).profiles ?? []);
    }
    catch
    {
        errors.push('fixture profile catalog is unreadable');
    }
    const profileIds = new Set(profiles.map((item) => item.id));
    for (const sentinel of sentinels)
    {
        const id = sentinel.id ?? '<missing>';
        if (!stableId.test(id))
        {
            errors.push(`sentinel has unstable id ${id}`);
        }
        if (typeof sentinel.value !== 'string' || !sentinel.value)
        {
            errors.push(`sentinel ${id} must declare value`);
        }
        validateExactReferences(sentinel.allowedValidityClasses, new Set(FIXTURE_VALIDITY_CLASSES), `sentinel ${id}.allowedValidityClasses`, errors);
        if (!Array.isArray(sentinel.allowedProfiles) || !sortedUnique(sentinel.allowedProfiles))
        {
            errors.push(`sentinel ${id}.allowedProfiles must be sorted unique stable profile IDs`);
        }
        validateReferences(sentinel.allowedProfiles, profileIds, `sentinel ${id}.allowedProfiles`, errors);
        if (sentinel.profileScope === 'registered-profiles' && sentinel.allowedProfiles.length === 0)
        {
            errors.push(`sentinel ${id} registered-profiles scope requires profile references`);
        }
        if (sentinel.profileScope === 'unbound-retired' && sentinel.allowedProfiles.length !== 0)
        {
            errors.push(`sentinel ${id} unbound-retired scope must not bind profiles`);
        }
        if (sentinel.profileScope !== 'registered-profiles' && sentinel.profileScope !== 'unbound-retired')
        {
            errors.push(`sentinel ${id} must declare a controlled profileScope`);
        }
        if (sentinel.profileScope === 'unbound-retired' && !sentinel.allowedValidityClasses.every((item) => item === 'migration-legacy' || item === 'negative-invalid'))
        {
            errors.push(`sentinel ${id} unbound-retired scope may only serve migration-legacy or negative-invalid variants`);
        }
        if (typeof sentinel.forbiddenInCanonicalPositive !== 'boolean')
        {
            errors.push(`sentinel ${id} must declare forbiddenInCanonicalPositive`);
        }
        if (!stableId.test(sentinel.retirementOwner ?? ''))
        {
            errors.push(`sentinel ${id} must declare retirementOwner`);
        }
    }

    const variants = catalog.variants ?? [];
    const variantIds = variants.map((item) => item.id);
    const duplicateVariantIds = variantIds.filter((value, index) => variantIds.indexOf(value) !== index);
    if (duplicateVariantIds.length)
    {
        errors.push(`duplicate variant id ${duplicateVariantIds.sort().join(', ')}`);
    }
    let capabilities = [];
    let producers = [];
    try
    {
        capabilities = (JSON.parse(fs.readFileSync(capabilityFile, 'utf8')).capabilities ?? []);
    }
    catch
    {
        errors.push('fixture capability catalog is unreadable');
    }
    try
    {
        producers = (JSON.parse(fs.readFileSync(producerFile, 'utf8')).producers ?? []);
    }
    catch
    {
        errors.push('fixture producer registry is unreadable');
    }
    const capabilityById = new Map(capabilities.map((item) => [item.id, item]));
    const producerIds = new Set(producers.map((item) => item.id));
    const canonicalByCapability = new Map();
    for (const variant of variants)
    {
        const id = variant.id ?? '<missing>';
        if (!stableId.test(id))
        {
            errors.push(`variant has unstable id ${id}`);
        }
        if (!FIXTURE_VALIDITY_CLASSES.includes(variant.validityClass))
        {
            errors.push(`variant ${id} has invalid validityClass ${variant.validityClass}`);
        }
        const capability = capabilityById.get(variant.capabilityId);
        if (!capability)
        {
            errors.push(`variant ${id} references unknown capability ${variant.capabilityId}`);
        }
        if (!producerIds.has(variant.ownerProducerId))
        {
            errors.push(`variant ${id} references unknown producer ${variant.ownerProducerId}`);
        }
        if (capability && capability.ownerProducerId !== variant.ownerProducerId)
        {
            errors.push(`variant ${id} ownerProducerId must match capability owner ${capability.ownerProducerId}`);
        }
        const capabilityValidityClasses = capability?.validityClasses ?? FIXTURE_VALIDITY_CLASSES;
        if (!capabilityValidityClasses.includes(variant.validityClass))
        {
            errors.push(`variant ${id} validityClass is not allowed by capability ${variant.capabilityId}`);
        }
        if (!writerContracts.has(variant.writerContractId))
        {
            errors.push(`variant ${id} references unknown writer contract ${variant.writerContractId}`);
        }
        validateExactReferences(variant.contentShapeIds, contentShapes, `variant ${id}.contentShapeIds`, errors);
        if (!temporalShapes.has(variant.temporalShapeId))
        {
            errors.push(`variant ${id} references unknown temporal shape ${variant.temporalShapeId}`);
        }
        validateExactReferences(variant.mediaShapeIds, mediaShapes, `variant ${id}.mediaShapeIds`, errors, { required: false });
        if (variant.distributionShapeId !== null && !distributionShapes.has(variant.distributionShapeId))
        {
            errors.push(`variant ${id} references unknown distribution shape ${variant.distributionShapeId}`);
        }
        validateExactReferences(variant.requiredDerivedStateIds, derivedStates, `variant ${id}.requiredDerivedStateIds`, errors, { required: false });
        validateExactReferences(variant.forbiddenSentinelIds, sentinelIds, `variant ${id}.forbiddenSentinelIds`, errors, { required: false });
        if (typeof variant.expectedBoundary !== 'string' || !variant.expectedBoundary)
        {
            errors.push(`variant ${id} must declare expectedBoundary`);
        }
        validateExactReferences(variant.allowedExecutionClasses, new Set(fixtureExecutionClasses), `variant ${id}.allowedExecutionClasses`, errors);
        validateExactReferences(variant.defaultExecutionClasses, new Set(fixtureExecutionClasses), `variant ${id}.defaultExecutionClasses`, errors, { required: false });
        for (const executionClass of variant.defaultExecutionClasses ?? [])
        {
            if (!variant.allowedExecutionClasses.includes(executionClass))
            {
                errors.push(`variant ${id} default execution class ${executionClass} is not allowed`);
            }
        }
        if (variant.validityClass !== 'canonical-positive' && variant.allowedExecutionClasses?.some((item) => nonQualificationExecutionClasses.has(item)))
        {
            errors.push(`non-canonical variant ${id} cannot be consumed by qualification execution classes`);
        }
        if (variant.validityClass !== 'canonical-positive')
        {
            const declared = classes.find((item) => item.id === variant.validityClass)?.allowedExecutionClasses ?? [];
            if (JSON.stringify(variant.allowedExecutionClasses) !== JSON.stringify(declared))
            {
                errors.push(`variant ${id} validity class ${variant.validityClass} must exactly match catalog execution policy ${declared.join(', ')}`);
            }
        }
        if (variant.validityClass === 'negative-invalid' && variant.requiredDerivedStateIds.length !== 1)
        {
            errors.push(`negative-invalid variant ${id} must violate exactly one invariant`);
        }
        if (variant.validityClass === 'negative-invalid' && !stableId.test(variant.expectedInvariantId ?? ''))
        {
            errors.push(`negative-invalid variant ${id} must declare its exact expected invariant ID`);
        }
        if (variant.validityClass === 'negative-invalid' && !sentinelIds.has(variant.injectedSentinelId ?? ''))
        {
            errors.push(`negative-invalid variant ${id} must declare its exact injected sentinel ID`);
        }
        if (variant.validityClass === 'negative-invalid' && !sentinels.find((item) => item.id === variant.injectedSentinelId)?.allowedValidityClasses?.includes('negative-invalid'))
        {
            errors.push(`negative-invalid variant ${id} injected sentinel ${variant.injectedSentinelId} must allow negative-invalid`);
        }
        if (variant.validityClass !== 'negative-invalid' && variant.expectedInvariantId != null)
        {
            errors.push(`non-negative variant ${id} must not declare expectedInvariantId`);
        }
        if (variant.validityClass !== 'negative-invalid' && variant.injectedSentinelId != null)
        {
            errors.push(`non-negative variant ${id} must not declare injectedSentinelId`);
        }
        if (variant.validityClass === 'scale-synthetic' && (!variant.expectedBoundary.includes('equivalent:') || !variant.expectedBoundary.includes('not-equivalent:')))
        {
            errors.push(`scale-synthetic variant ${id} must declare production graph equivalence boundary`);
        }
        if (variant.validityClass === 'canonical-positive')
        {
            if (canonicalByCapability.has(variant.capabilityId))
            {
                errors.push(`capability ${variant.capabilityId} has multiple canonical variants`);
            }
            canonicalByCapability.set(variant.capabilityId, variant);
            const requiredSentinels = sentinels.filter((item) => item.forbiddenInCanonicalPositive).map((item) => item.id).sort();
            if (JSON.stringify(variant.forbiddenSentinelIds) !== JSON.stringify(requiredSentinels))
            {
                errors.push(`canonical-positive variant ${id} must reject every registered canonical-forbidden sentinel`);
            }
        }
        const allowedFields = new Set(['id', 'capabilityId', 'validityClass', 'ownerProducerId', 'writerContractId', 'contentShapeIds', 'temporalShapeId', 'mediaShapeIds', 'distributionShapeId', 'requiredDerivedStateIds', 'forbiddenSentinelIds', 'expectedBoundary', 'expectedInvariantId', 'injectedSentinelId', 'allowedExecutionClasses', 'defaultExecutionClasses']);
        for (const key of Object.keys(variant))
        {
            if (!allowedFields.has(key))
            {
                errors.push(`variant ${id} has unexpected field ${key}`);
            }
        }
    }
    for (const capability of capabilities)
    {
        const hasAllowedVariant = variants.some((item) => item.capabilityId === capability.id);
        if (!hasAllowedVariant)
        {
            errors.push(`capability ${capability.id} has no registered fixture variant`);
        }
        const capabilityValidityClasses = capability.validityClasses ?? FIXTURE_VALIDITY_CLASSES;
        if (capabilityValidityClasses.includes('canonical-positive')
            && !canonicalByCapability.has(capability.id)
            && !/^(?:development\.demo\.dataset|scale\.)/u.test(capability.id))
        {
            errors.push(`capability ${capability.id} has no canonical-positive variant`);
        }
        if (!capabilityValidityClasses.includes('canonical-positive')
            && canonicalByCapability.has(capability.id))
        {
            errors.push(`negative-only capability ${capability.id} cannot register a canonical-positive variant`);
        }
    }
    for (const capability of capabilities)
    {
        for (const executionClass of fixtureExecutionClasses)
        {
            const permitted = variants.filter((item) => item.capabilityId === capability.id
        && item.allowedExecutionClasses?.includes(executionClass));
            if (!permitted.length)
            {
                continue;
            }
            const defaults = permitted.filter((item) => item.defaultExecutionClasses?.includes(executionClass));
            if (defaults.length !== 1)
            {
                errors.push(`capability ${capability.id} execution class ${executionClass} must have exactly one catalog default variant`);
            }
        }
    }
    return errors;
}

function freezeVariantEntry(variant, catalogs)
{
    const capability = catalogs.capability.capabilities.find((item) => item.id === variant.capabilityId);
    if (!capability)
    {
        throw new Error(`fixture variant ${variant.id} references unknown capability ${variant.capabilityId}`);
    }
    return Object.freeze({
        id: variant.id,
        capabilityId: variant.capabilityId,
        postconditionIds: Object.freeze([...(capability.postconditionIds ?? [])]),
        validityClass: variant.validityClass,
        ownerProducerId: variant.ownerProducerId,
        writerContractId: variant.writerContractId,
        contentShapeIds: Object.freeze([...variant.contentShapeIds]),
        temporalShapeId: variant.temporalShapeId,
        mediaShapeIds: Object.freeze([...variant.mediaShapeIds]),
        distributionShapeId: variant.distributionShapeId,
        requiredDerivedStateIds: Object.freeze([...variant.requiredDerivedStateIds]),
        forbiddenSentinelIds: Object.freeze([...variant.forbiddenSentinelIds]),
        expectedBoundary: variant.expectedBoundary,
        expectedInvariantId: variant.expectedInvariantId ?? null,
        injectedSentinelId: variant.injectedSentinelId ?? null,
        injectedSentinelValue: variant.injectedSentinelId == null
            ? null
            : catalogs.variant.sentinels.find((item) => item.id === variant.injectedSentinelId)?.value ?? null,
        allowedExecutionClasses: Object.freeze([...variant.allowedExecutionClasses])
    });
}

/**
 * Resolve an exact consumer requirement. When requestedVariantIds is supplied,
 * every capability must name exactly one permitted catalog variant. Otherwise,
 * the sole catalog-owned default for that capability/execution class is used.
 */
export function resolveFixtureVariants(capabilityIds, executionClass, catalogs = readFixtureCatalogs(), {
    requestedVariantIds = null
} = {})
{
    const variants = catalogs.variant?.variants ?? [];
    const capabilities = [...capabilityIds].sort();
    const requested = requestedVariantIds == null ? null : [...requestedVariantIds].sort();
    const requestedEntries = requested == null
        ? null
        : requested.map((variantId) =>
{
      const variant = variants.find((item) => item.id === variantId);
      if (!variant)
{
throw new Error(`requested fixture variant ${variantId} is not registered`);
}
      return variant;
    });
    if (requested && new Set(requested).size !== requested.length)
    {
        throw new Error('requested fixture variant IDs must be sorted and unique');
    }
    if (requestedEntries)
    {
        const requestedCapabilities = requestedEntries.map((item) => item.capabilityId).sort();
        if (JSON.stringify(requestedCapabilities) !== JSON.stringify(capabilities))
        {
            throw new Error('requested fixture variants must map one-to-one with required capabilities');
        }
    }
    return Object.freeze(capabilities.map((capabilityId) =>
    {
        const matches = requestedEntries
            ? requestedEntries.filter((item) => item.capabilityId === capabilityId)
            : variants.filter((item) => item.capabilityId === capabilityId
        && item.defaultExecutionClasses?.includes(executionClass));
        if (matches.length !== 1)
        {
            throw new Error(`capability ${capabilityId} must resolve to exactly one fixture variant for ${executionClass}`);
        }
        const variant = matches[0];
        if (!variant.allowedExecutionClasses.includes(executionClass))
        {
            throw new Error(`fixture variant ${variant.id} rejects execution class ${executionClass}`);
        }
        return variant.id;
    }).sort());
}

/** Immutable runtime projection; producers receive only their own typed slice. */
export function buildFixtureVariantPlan(variantIds, catalogs = readFixtureCatalogs())
{
    const ids = [...variantIds].sort();
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('fixture variant plan IDs must be unique');
    }
    const entries = ids.map((id) =>
    {
        const variant = catalogs.variant?.variants?.find((item) => item.id === id);
        if (!variant)
        {
            throw new Error(`fixture variant plan references unregistered variant ${id}`);
        }
        return freezeVariantEntry(variant, catalogs);
    });
    const producerIds = [...new Set(entries.map((item) => item.ownerProducerId))].sort();
    const byProducer = producerIds.map((producerId) => Object.freeze({
        producerId,
        variants: Object.freeze(entries.filter((item) => item.ownerProducerId === producerId))
    }));
    const body = {
        schema: 'fsusblog.fixture-variant-plan.v1',
        catalogDigest: fixtureCatalogDigest(catalogs),
        variants: Object.freeze(entries),
        byProducer: Object.freeze(byProducer)
    };
    return Object.freeze({
        ...body,
        variantPlanDigest: sha256Json(body)
    });
}

/** Immutable producer-owned slice whose digest is bound to the complete fixture plan. */
export function buildProducerFixtureVariantPlan({
    producerId,
    variantIds,
    fixtureVariantIds,
    fixtureVariantPlanDigest,
    catalogs = readFixtureCatalogs()
} = {})
{
    const id = String(producerId ?? '').trim();
    if (!stableId.test(id))
    {
        throw new Error('producer fixture variant plan requires a stable producerId');
    }
    if (typeof fixtureVariantPlanDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(fixtureVariantPlanDigest))
    {
        throw new Error(`producer ${id} fixture variant plan requires the complete fixture plan digest`);
    }
    const completePlan = buildFixtureVariantPlan(fixtureVariantIds ?? [], catalogs);
    if (fixtureVariantPlanDigest !== completePlan.variantPlanDigest)
    {
        throw new Error(`producer ${id} fixture variant plan digest is forged or does not match the complete registered plan`);
    }
    const expectedIds = (completePlan.byProducer.find((item) => item.producerId === id)?.variants ?? [])
        .map((item) => item.id)
        .sort();
    const requestedIds = [...(variantIds ?? [])].sort();
    if (JSON.stringify(requestedIds) !== JSON.stringify(expectedIds))
    {
        throw new Error(`producer ${id} fixture variant slice does not exactly match the complete registered plan`);
    }
    const variants = completePlan.variants.filter((variant) => variant.ownerProducerId === id);
    const body = {
        schema: 'fsusblog.fixture-producer-variant-plan.v1',
        catalogDigest: fixtureCatalogDigest(catalogs),
        fixtureVariantPlanDigest,
        producerId: id,
        variants
    };
    return Object.freeze({
        ...body,
        producerVariantPlanDigest: sha256Json(body)
    });
}

/**
 * Validate producer evidence against the sealed data variant, rather than merely
 * accepting a matching ID in a receipt. This is intentionally adapter-neutral so
 * #1713/#1718 producers must meet the same live evidence contract.
 */
export function validateFixtureVariantEvidence({ result, variantIds, catalogs = readFixtureCatalogs() } = {})
{
    if (result?.enforceVariantEvidence !== true)
    {
        return [];
    }
    const errors = [];
    const expected = [...(variantIds ?? [])].sort();
    const variants = new Map((catalogs.variant?.variants ?? []).map((item) => [item.id, item]));
    const sentinels = new Map((catalogs.variant?.sentinels ?? []).map((item) => [item.id, item.value]));
    const entities = result?.observations?.database?.entities ?? result?.databaseObservation?.entities ?? [];
    const identities = result?.entityIdentities ?? [];
    for (const entity of [...entities, ...identities])
    {
        if (!entity?.variantId || !expected.includes(entity.variantId))
        {
            errors.push(`fixture entity ${entity?.id ?? '<missing>'} has no exact planned variantId`);
        }
    }
    for (const id of expected)
    {
        const variant = variants.get(id);
        if (!variant)
        {
            errors.push(`fixture evidence references unknown variant ${id}`);
            continue;
        }
        const boundEntities = entities.filter((item) => item?.variantId === id);
        const evidence = result?.variantEvidence?.variants?.find((item) => item?.variantId === id);
        const observedIds = new Set(entities.map((item) => String(item?.id ?? '')));
        const hasLiveEvidence = evidence?.source === 'live-service'
      && Array.isArray(evidence.entityIds)
      && ((evidence.entityIds.length > 0
        && evidence.entityIds.every((entityId) => observedIds.has(String(entityId))))
        || (variant.capabilityId === 'public.empty'
          && evidence.emptyVerified === true
          && evidence.entityIds.length === 0
          && entities.length === 0));
        if (variant.validityClass === 'negative-invalid')
        {
            if (boundEntities.length !== 0)
            {
                errors.push(`negative variant ${id} must not publish fixture entities`);
            }
            const expectedSentinelValue = sentinels.get(variant.injectedSentinelId);
            if (evidence?.source !== 'live-service' || evidence?.rejected !== true || evidence?.injectedSentinelId !== variant.injectedSentinelId || evidence?.injectedSentinelValue !== expectedSentinelValue || !Array.isArray(evidence.invariantIds) || evidence.invariantIds.length !== 1 || evidence.invariantIds[0] !== variant.expectedInvariantId)
            {
                errors.push(`negative variant ${id} requires its exact live rejected invariant ${variant.expectedInvariantId}`);
            }
            continue;
        }
        if (boundEntities.length === 0 && !hasLiveEvidence)
        {
            errors.push(`variant ${id} has no exact entity binding or live evidence`);
        }
        const mediaEntities = boundEntities.length
            ? boundEntities
            : entities.filter((item) => evidence?.entityIds?.map(String).includes(String(item?.id ?? '')));
        const hasCover = mediaEntities.some((entity) => entity?.fields?.hasCover === true || String(entity?.fields?.coverImageUrl ?? '').trim());
        const hasNoCover = mediaEntities.some((entity) => !(entity?.fields?.hasCover === true || String(entity?.fields?.coverImageUrl ?? '').trim()));
        if (variant.mediaShapeIds?.includes('no-media') && hasCover)
        {
            errors.push(`no-media variant ${id} observed a cover entity`);
        }
        if (variant.mediaShapeIds?.includes('cover-and-no-cover') && (!hasCover || !hasNoCover))
        {
            errors.push(`cover-and-no-cover variant ${id} requires live cover and no-cover observations`);
        }
        for (const entity of mediaEntities)
        {
            const fields = JSON.stringify(entity.fields ?? {});
            if (variant.validityClass === 'canonical-positive')
            {
                for (const sentinelId of variant.forbiddenSentinelIds ?? [])
                {
                    const value = sentinels.get(sentinelId);
                    if (value && fields.includes(value))
                    {
                        errors.push(`canonical-positive variant ${id} contains forbidden sentinel ${sentinelId}`);
                    }
                }
            }
        }
        if (variant.validityClass === 'migration-legacy'
      && ((boundEntities.length === 0 && !hasLiveEvidence) || evidence?.legacyRead !== true))
        {
            errors.push(`migration variant ${id} requires observed live legacy-read evidence`);
        }
        if (variant.validityClass === 'scale-synthetic'
      && evidence?.expectedBoundary !== variant.expectedBoundary)
        {
            errors.push(`scale variant ${id} must prove its exact production boundary`);
        }
    }
    return errors;
}

export function readFixtureCatalogs(files = fixtureCatalogFiles)
{
    return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readJson(file)]));
}

function duplicate(values)
{
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function validateReferences(values, known, label, errors)
{
    for (const value of values ?? [])
    {
        if (!known.has(value))
        {
            errors.push(`${label} references unknown id ${value}`);
        }
    }
}

function normalizedSentinelValue(value)
{
    return String(value).trim().toLowerCase().replace(/\s*=\s*/gu, '=');
}

export function validateFixtureSentinelRegistry({
    catalogs = readFixtureCatalogs(),
    repositoryRoot = root,
    sourceOverrides = new Map()
} = {})
{
    const errors = [];
    const registered = new Set((catalogs.variant.sentinels ?? [])
        .map((item) => normalizedSentinelValue(item.value)));
    const candidatePatterns = [
        /\blegacy_[a-z0-9_]+\b/giu,
        /\brights-v3:[a-z0-9-]+:recompute\b/giu,
        /\bcreated_by_admin_principal_id\s*=\s*0\b/giu,
        /\bunknown audit action\b/giu,
        /\bunverified local fallback object\b/giu
    ];
    const sources = new Set((catalogs.producer.producers ?? [])
        .flatMap((item) => item.implementationPaths ?? []));
    for (const source of sourceOverrides.keys())
    {
        sources.add(source);
    }
    for (const source of [...sources].sort())
    {
        const file = path.join(repositoryRoot, source);
        const content = sourceOverrides.get(source)
      ?? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
        for (const pattern of candidatePatterns)
        {
            for (const match of content.matchAll(pattern))
            {
                if (!registered.has(normalizedSentinelValue(match[0])))
                {
                    errors.push(`${source}: fixture sentinel ${match[0]} is not registered in FixtureVariantCatalog`);
                }
            }
        }
    }
    return [...new Set(errors)];
}

/**
 * Observe truthful current source / fallback semantics from consumer source text.
 * Must not hardcode "no fallback" when Playwright or bootstrap reuses env data.
 */
export function observeFixtureConsumerSource(sourcePath, content)
{
    const observations = new Set();
    const text = String(content ?? '');
    const pathHint = String(sourcePath ?? '');

    // Detect live API→DB fallback control flow, not merely co-located helper definitions.
    if (/seedPublicFixturesViaApi[\s\S]{0,400}catch[\s\S]{0,400}seedPublicFixtures\s*\(/u.test(text)
    || /admin API seeding unavailable; using direct DB seed/u.test(text))
    {
        observations.add('admin API public seed falls back to direct-DB seed when API unavailable');
    }
    else if (/seedPublicFixturesViaApi/u.test(text))
    {
        observations.add('public fixtures seeded via admin API only (public-api-scenario; no direct-DB fallback)');
    }

    if (/\bseedPublicFixtures\s*\(/u.test(text)
    && /existing_article/u.test(text)
    && /seedPublicFixturesViaApi[\s\S]{0,400}catch[\s\S]{0,400}seedPublicFixtures\s*\(/u.test(text))
    {
        observations.add('direct-DB public seed reuses existing article rows by title when present');
    }

    if (/transaction-fixture/u.test(text)
    && /public-content|PublicContentFixtureSeeder|LocalPublicContentFixture/u.test(text + pathHint)
    && /domain.?port|composition root|IPublicContentFixtureSeeder|IArticleCoreGateway/u.test(text))
    {
        observations.add('public content prepared only via transaction-fixture domain-port composition root (no API/DB/env discovery)');
    }

    if (/waitForPublicFixtureSnapshot|fetchPublicArticlePage/u.test(text) && /page\?\.items/u.test(text)
    && !/refusing env discovery|forbids fallback/u.test(text))
    {
        observations.add('reuses public content already present in the running env when list/home discovery succeeds');
    }

    if (/acceptance environment is reused|while the acceptance environment is reused/u.test(text))
    {
        observations.add('tolerates stale list cache entries while a reused acceptance environment refreshes');
    }

    if (/using direct DB fixture seed while public hot-read/u.test(text)
    || (/buildSeededArticleFallback/u.test(text) && /seededFallback/u.test(text) && /firstArticle = fallback/u.test(text)))
    {
        observations.add('uses direct-DB seeded article IDs while public hot-read snapshot refreshes');
    }

    if (/FSUSBLOG_PERSIST_AUTH_FIXTURES/u.test(text) && /persistAuthFixtureManifest|auth-fixtures\.json/u.test(text))
    {
        observations.add('persists auth fixture files when FSUSBLOG_PERSIST_AUTH_FIXTURES is not 0 for later worker reuse');
    }

    if (/WITH existing AS|WHERE NOT EXISTS \(SELECT 1 FROM existing\)/u.test(text) && /auth|user|admin|session/iu.test(text + pathHint))
    {
        observations.add('upserts auth identities; reuses existing user/admin rows when handles already exist');
    }

    if (/PrepareAuthFixturesOnce|PreparePublicFixturesOnce|PrepareRuntimeFixturesOnce|PrepareSessionFixturesOnce/u.test(text)
    || /tools\/test-fixtures\/cli\.mjs|InvokeFixtureOrchestrator|InvokeLaneFixtureOrchestrator/u.test(text))
    {
        observations.add('bootstrap prepares fixtures through the unique FixtureOrchestrator / sealed profile plan');
    }

    if (/public fallback is forbidden|sealed browser contract fixture is missing/u.test(text))
    {
        observations.add('requires sealed browser-contract fixture root; public fallback is forbidden');
    }

    if (/browser-contract must use its formal single-namespace fixture lifecycle/u.test(text))
    {
        observations.add('rejects legacy multi-worker session prep in browser-contract mode');
    }

    if (/data-scale|scale\.article-comment/u.test(pathHint + text) && /seed|cleanup|probe/u.test(pathHint + text))
    {
        observations.add('scale data is produced by the scale-data generator for the selected scale profile only');
    }

    if (/demo-seed\.sql|seed-demo-data/u.test(pathHint) || /development\.demo\.dataset/u.test(text))
    {
        observations.add('development demo dataset is applied via tools/dev demo seed; not a runtime acceptance producer');
    }

    if (/ResetSecurityRuntimeState/u.test(text))
    {
        observations.add('lane may reset security runtime state around execution (not a business-data fallback)');
    }

    if (observations.size === 0)
    {
        if (/tests\/matrix\.yml/u.test(pathHint))
        {
            return 'matrix-bound profile only; no undeclared free-string capability selection';
        }
        return 'no local data fallback path; depends on producers declared by the bound fixture profile';
    }

    return [...observations].sort().join('; ');
}

export function observeFixtureImplicitSource(sourcePath, content, { kind = 'source', tierId = null } = {})
{
    const text = String(content ?? '');
    const pathHint = String(sourcePath ?? '');
    if (kind === 'matrix')
    {
        return `tests/matrix.yml tier ${tierId}; command ${pathHint}`;
    }
    if (/fixture-catalog:\s+consumer/u.test(text))
    {
        return `fixture-catalog consumer declaration in ${pathHint}`;
    }
    if (/public-content-producer|LocalPublicContentFixture|PublicContentFixtureSeeder/u.test(pathHint))
    {
        return `${pathHint} materialises public content via transaction-fixture composition root and FixtureReceipt projection`;
    }
    if (/session-fixtures/u.test(pathHint))
    {
        return `${pathHint} prepares auth/session identities via local fixture endpoints and SQL upserts`;
    }
    if (/bootstrap-acceptance-env/u.test(pathHint))
    {
        return `${pathHint} prepares namespace auth and public fixtures for acceptance/runtime consumers`;
    }
    if (/default-fixture-provider|browser-contract/u.test(pathHint))
    {
        return `${pathHint} prepares or loads sealed browser-contract fixture state`;
    }
    return pathHint;
}

function readOptionalSource(repositoryRoot, relative)
{
    const absolute = path.join(repositoryRoot, relative);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
}

/**
 * Shared observation corpus for matrix consumers so inventory generation and validation stay exact.
 */
export function matrixConsumerObservationContent(tier, { repositoryRoot = root } = {})
{
    const commandPath = String(tier.command ?? '').match(/\b(tools\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))\b/u)?.[1];
    const chunks = [];
    if (commandPath)
    {
        chunks.push(readOptionalSource(repositoryRoot, commandPath));
    }
    if (tier.requiresBootstrap === 'full' || /bootstrap/u.test(String(tier.command ?? '')))
    {
        chunks.push(readOptionalSource(repositoryRoot, 'tools/bootstrap-acceptance-env.sh'));
    }
    if (/discover-playwright|playwright|browser-contract|acceptance|visual|ux-viewport|csrf-browser/u.test(`${tier.id} ${tier.command ?? ''}`))
    {
        chunks.push(readOptionalSource(repositoryRoot, 'tools/test-fixtures/producers/public-content-producer.mjs'));
        chunks.push(readOptionalSource(repositoryRoot, 'tests/frontend/support/session-fixtures.mjs'));
    }
    if (/browser-contract/u.test(`${tier.id} ${tier.command ?? ''}`))
    {
        chunks.push(readOptionalSource(repositoryRoot, 'tests/browser-contract/fixture.mjs'));
        chunks.push(readOptionalSource(repositoryRoot, 'tests/browser-contract/default-fixture-provider.mjs'));
    }
    if (/data-scale|load-smoke|load-profile|backend-qps/u.test(`${tier.id} ${tier.command ?? ''}`))
    {
        chunks.push(readOptionalSource(repositoryRoot, 'tools/data-scale/seed.sh'));
        chunks.push(readOptionalSource(repositoryRoot, 'tools/test/lanes/data-scale.sh'));
    }
    return chunks.join('\n');
}

export function scanFixtureSourceDeclarations({ repositoryRoot = root, sourceOverrides = new Map() } = {})
{
    const consumers = [];
    const producers = [];
    const sources = new Set(requiredFixtureSourceFiles);
    const visit = (relative) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        if (!fs.existsSync(absolute))
        {
            return;
        }
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
        {
            const child = path.posix.join(relative, entry.name);
            if (entry.isDirectory())
            {
                if (!['node_modules', '.tmp', 'bin', 'obj', 'dist'].includes(entry.name))
                {
                    visit(child);
                }
            }
            else if (fixtureDeclarationScanExtensions.test(entry.name) && !fixtureDeclarationScanExclusions.has(child))
            {
                sources.add(child);
            }
        }
    };
    for (const directory of fixtureDeclarationScanRoots)
    {
        visit(directory);
    }
    for (const [source] of sourceOverrides)
    {
        sources.add(source);
    }
    for (const source of [...sources].sort())
    {
        const file = path.join(repositoryRoot, source);
        if (!sourceOverrides.has(source) && !fs.existsSync(file))
        {
            throw new Error(`audited fixture source is missing: ${source}`);
        }
        const content = sourceOverrides.get(source) ?? fs.readFileSync(file, 'utf8');
        const declarations = [...content.matchAll(/fixture-catalog:[ \t]+(consumer|producer)[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*|matrix))?/gu)];
        if (declarations.length === 0)
        {
            if (requiredFixtureSourceFiles.includes(source))
            {
                throw new Error(`audited fixture source has no declaration: ${source}`);
            }
            continue;
        }
        for (const declaration of declarations)
        {
            if (declaration[1] === 'consumer')
            {
                if (!declaration[3])
                {
                    throw new Error(`fixture consumer declaration has no profile: ${source}`);
                }
                consumers.push({ id: declaration[2], profileId: declaration[3], source });
            }
            else
            {
                if (declaration[3])
                {
                    throw new Error(`fixture producer declaration has unexpected profile: ${source}`);
                }
                producers.push({ producerId: declaration[2], source });
            }
        }
    }
    const consumerIds = consumers.map((item) => item.id);
    if (duplicate(consumerIds).length)
    {
        throw new Error(`duplicate fixture source consumer id ${duplicate(consumerIds).sort().join(', ')}`);
    }
    return {
        consumers: consumers.sort((left, right) => left.id.localeCompare(right.id)),
        producers: producers.sort((left, right) => left.producerId.localeCompare(right.producerId) || left.source.localeCompare(right.source))
    };
}

export function isFixtureMatrixConsumer(tier)
{
    if (['projection', 'summary'].includes(tier.executionMode))
    {
        return false;
    }
    return tier.requiresBootstrap !== 'none'
    || (/tools\/test\/lanes\/(?:backend-qps|data-scale|load-profile|load-smoke)\.sh/u.test(String(tier.command ?? ''))
      && !/\saggregate$/u.test(String(tier.command ?? '')));
}

export function validateNoneFixtureTier(tier, {
    repositoryRoot = root,
    sourceOverrides = new Map()
} = {})
{
    if (tier.fixtureProfile !== 'none')
    {
        return [];
    }
    const commandPath = String(tier.command ?? '').match(/\b(tools\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))\b/u)?.[1];
    if (!commandPath)
    {
        return [];
    }
    const source = sourceOverrides.get(commandPath)
    ?? (fs.existsSync(path.join(repositoryRoot, commandPath))
        ? fs.readFileSync(path.join(repositoryRoot, commandPath), 'utf8')
        : '');
    if (!source)
    {
        return [];
    }
    const forbiddenOperations = [
        [/ResetSecurityRuntimeState/u, 'security state reset'],
        [/\b(?:PrepareAuthFixturesOnce|PreparePublicFixturesOnce|PrepareRuntimeFixturesOnce|PrepareSessionFixturesOnce|InvokeLaneFixtureOrchestrator|InvokeFixtureOrchestrator)\b|tools\/test-fixtures\/cli\.mjs/u, 'business fixture preparation']
    ];
    return forbiddenOperations
        .filter(([pattern]) => pattern.test(source))
        .map(([, operation]) => `matrix tier ${tier.id} none profile cannot execute ${operation}`);
}

export function validateFixtureAuthoritySources({ repositoryRoot = root, sourceOverrides = new Map() } = {})
{
    const errors = [];
    const forbidden = [
        [/fixtureProfileAlias(?:es)?|legacyFixtureProfiles?/u, 'fixture profile alias is forbidden'],
        [/fixtureVariantAlias(?:es)?|legacyFixtureVariants?|variantAliases?/u, 'fixture variant alias is forbidden'],
        [/\bfixtureProfiles?\s*[:=]\s*\[/u, 'second fixture profile list is forbidden'],
        [/\b[A-Za-z0-9_]*fixture[A-Za-z0-9_]*capabilit(?:y|ies)\s*[:=]\s*\[/iu, 'free-string fixture capability list is forbidden']
    ];
    const allowedAuthorityFiles = new Set([
        'config/testing/fixture-capability-catalog.json',
        'config/testing/fixture-consumer-inventory.generated.json',
        'config/testing/fixture-producer-registry.json',
        'config/testing/fixture-profile-catalog.json',
        'config/testing/fixture-variant-catalog.json',
        'docs/testing/fixture-capability-catalog.md',
        'tests/matrix.yml',
        'tests/tools/fixture-catalog.test.mjs',
        'tests/tools/matrix-fixture-profile.test.mjs',
        'tools/test-matrix/behavior-doc-static-admission-contract.mjs',
        'tools/testing/fixture-catalog.mjs',
        'tools/testing/generate-fixture-catalog-artifacts.mjs'
    ]);
    const candidates = [];
    const visit = (relative) =>
    {
        const absolute = path.join(repositoryRoot, relative);
        if (!fs.existsSync(absolute))
        {
            return;
        }
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
        {
            const child = path.posix.join(relative, entry.name);
            if (entry.isDirectory())
            {
                if (!['node_modules', '.tmp', 'bin', 'obj', 'dist'].includes(entry.name))
                {
                    visit(child);
                }
            }
            else if (/\.(?:cs|json|md|mjs|sh|sql|ts|tsx|vue|ya?ml)$/u.test(entry.name))
            {
                candidates.push(child);
            }
        }
    };
    for (const directory of ['config', 'docs', 'src', 'tests', 'tools'])
    {
        visit(directory);
    }
    for (const [source] of sourceOverrides)
    {
        if (!candidates.includes(source))
        {
            candidates.push(source);
        }
    }
    for (const source of candidates)
    {
        if (allowedAuthorityFiles.has(source))
        {
            continue;
        }
        const content = sourceOverrides.get(source) ?? fs.readFileSync(path.join(repositoryRoot, source), 'utf8');
        const code = content.replace(/^.*fixture-catalog:.*$/gmu, '');
        for (const [pattern, message] of forbidden)
        {
            if (pattern.test(code))
            {
                errors.push(`${source}: ${message}`);
            }
        }
        if (/\bfixtureProfile\s*[:=]\s*['"`]/u.test(code))
        {
            errors.push(`${source}: free-string fixture profile selection is forbidden`);
        }
    }
    return errors;
}

export function expandFixtureProfile(profileId, catalogs = readFixtureCatalogs())
{
    const profile = catalogs.profile.profiles.find((candidate) => candidate.id === profileId);
    if (!profile)
    {
        throw new Error(`unknown fixture profile ${profileId}`);
    }
    const byCapability = new Map(catalogs.capability.capabilities.map((capability) => [capability.id, capability]));
    const resolved = new Set();
    const visiting = new Set();
    const add = (id) =>
    {
        if (visiting.has(id))
        {
            throw new Error(`fixture capability dependency cycle at ${id}`);
        }
        if (resolved.has(id))
        {
            return;
        }
        const capability = byCapability.get(id);
        if (!capability)
        {
            throw new Error(`fixture profile ${profileId} references unknown capability ${id}`);
        }
        visiting.add(id);
        capability.dependsOn.forEach(add);
        visiting.delete(id);
        resolved.add(id);
    };
    profile.capabilities.forEach(add);
    const capabilities = [...resolved].sort();
    const conflicts = capabilities.flatMap((id) => byCapability.get(id).conflictsWith.filter((conflict) => resolved.has(conflict)).map((conflict) => [id, conflict]));
    if (conflicts.length)
    {
        throw new Error(`fixture profile ${profileId} contains conflicting capabilities ${conflicts.map((pair) => pair.join('/')).join(', ')}`);
    }
    return Object.freeze({ id: profileId, capabilities: Object.freeze(capabilities) });
}

/**
 * Authority digest over capability/profile/producer/content-shape catalogs
 * (inventory excluded).
 * Used to fail closed when sealed matrix identity drifts from live catalogs.
 */
export function fixtureCatalogDigest(catalogs = readFixtureCatalogs())
{
    return sha256Json({
        capability: catalogs.capability,
        profile: catalogs.profile,
        producer: catalogs.producer,
        variant: catalogs.variant,
        contentShapeAuthorityDigest: contentShapeCatalogDigest(
            catalogs.contentShapeAuthority ?? readContentShapeAuthority()
        )
    });
}

export function expandedCapabilityDigest(capabilities)
{
    return sha256Json([...(capabilities ?? [])].map(String).sort());
}

export function producersForCapabilities(capabilities, catalogs = readFixtureCatalogs())
{
    const selected = new Set(capabilities ?? []);
    return (catalogs.producer.producers ?? [])
        .filter((producer) => producer.provides.some((id) => selected.has(id)))
        .map((producer) => producer.id)
        .sort();
}

/**
 * Derive mutation policy and orchestrator flags from an expanded profile.
 * Security runtime reset is never a default bootstrap side effect; only future
 * explicit catalog-owned reset capabilities can enable it (none today).
 */
export function planFixtureMutation(profileId, catalogs = readFixtureCatalogs())
{
    const profile = catalogs.profile.profiles.find((candidate) => candidate.id === profileId);
    if (!profile)
    {
        throw new Error(`unknown fixture profile ${profileId}`);
    }
    const expanded = expandFixtureProfile(profileId, catalogs);
    const producers = producersForCapabilities(expanded.capabilities, catalogs);
    const byCapability = new Map(catalogs.capability.capabilities.map((capability) => [capability.id, capability]));
    const requiresAuthFixtures = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'auth-session');
    const requiresPublicFixtures = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'public-content');
    const requiresDemoSeed = expanded.capabilities.includes('development.demo.dataset');
    const requiresSecurityState = expanded.capabilities.some((id) => byCapability.get(id)?.ownerProducerId === 'security-state');
    // Catalog has no dedicated security-runtime-reset capability yet; fail closed to zero.
    const mutationPolicy = profileId === 'none' || expanded.capabilities.length === 0
        ? 'zero-mutation'
        : profile.isDestructive
      ? 'destructive-namespace'
      : 'namespace-fixture';
    return Object.freeze({
        profileId,
        capabilities: expanded.capabilities,
        producers: Object.freeze(producers),
        mutationPolicy,
        isDestructive: profile.isDestructive === true,
        requiresFreshNamespace: profile.requiresFreshNamespace === true,
        requiresLocalAuthBypass: requiresAuthFixtures,
        requiresAuthFixtures,
        requiresPublicFixtures,
        requiresDemoSeed,
        requiresSecurityState,
        allowedExecutionClasses: Object.freeze([...(profile.allowedExecutionClasses ?? [])])
    });
}

/**
 * Shared resolver for dev-cli and matrix-sealed bootstrap inputs.
 * Correctness callers cannot substitute profile identity via free env override.
 */
export function resolveFixtureProfile({
    profileId,
    profileSource,
    executionClass = null,
    requestedVariantIds = null,
    sealed = null,
    catalogs = readFixtureCatalogs(),
    allowFreeProfileEnv = false,
    freeProfileEnv = process.env.FSUSBLOG_FIXTURE_PROFILE
} = {})
{
    if (!profileSources.has(profileSource))
    {
        throw new Error(`fixture profile source must be dev-cli or matrix, got ${profileSource ?? '<missing>'}`);
    }
    if (profileSource === 'matrix' && allowFreeProfileEnv !== true)
    {
        const override = String(freeProfileEnv ?? '').trim();
        if (override)
        {
            throw new Error('correctness fixture profile cannot be overridden by FSUSBLOG_FIXTURE_PROFILE');
        }
    }
    const requestedId = String(profileId ?? '').trim();
    if (!requestedId)
    {
        throw new Error('fixture profile id is required; use catalog id none for zero-data startup');
    }
    if (requestedId !== profileId || !stableId.test(requestedId))
    {
        throw new Error(`fixture profile id is invalid: ${profileId}`);
    }
    const profile = catalogs.profile.profiles.find((candidate) => candidate.id === requestedId);
    if (!profile)
    {
        throw new Error(`unknown fixture profile ${requestedId}`);
    }
    const plan = planFixtureMutation(requestedId, catalogs);
    if (executionClass != null && executionClass !== '')
    {
        if (!plan.allowedExecutionClasses.includes(executionClass))
        {
            throw new Error(`fixture profile ${requestedId} rejects execution class ${executionClass}`);
        }
    }
    const resolvedExecutionClass = executionClass
    || (profileSource === 'matrix' ? (sealed?.executionClass ?? null) : null)
    || (profileSource === 'dev-cli'
        ? (plan.allowedExecutionClasses.includes('diagnostic')
        ? 'diagnostic'
        : plan.allowedExecutionClasses[0] ?? null)
        : null);
    const variantIds = resolvedExecutionClass == null
        ? Object.freeze([])
        : resolveFixtureVariants(plan.capabilities, resolvedExecutionClass, catalogs, { requestedVariantIds });
    const variantPlan = buildFixtureVariantPlan(variantIds, catalogs);
    const catalogDigest = fixtureCatalogDigest(catalogs);
    const capabilityDigest = expandedCapabilityDigest(plan.capabilities);
    if (profileSource === 'matrix')
    {
        if (!sealed || typeof sealed !== 'object')
        {
            throw new Error('matrix fixture profile requires sealed identity before mutation');
        }
        const sealedId = String(sealed.fixtureProfileId ?? '').trim();
        const sealedCatalogDigest = String(sealed.fixtureCatalogDigest ?? '').trim();
        const sealedCapabilityDigest = String(sealed.expandedCapabilityDigest ?? '').trim();
        const sealedVariantIds = sealed.fixtureVariantIds;
        const sealedVariantPlanDigest = String(sealed.fixtureVariantPlanDigest ?? '').trim();
        const sealedExecutionClass = sealed.executionClass == null || sealed.executionClass === ''
            ? null
            : String(sealed.executionClass);
        if (!sealedId)
        {
            throw new Error('sealed fixtureProfileId is missing');
        }
        if (sealedId !== requestedId)
        {
            throw new Error(`sealed fixture profile ${sealedId} does not match requested ${requestedId}`);
        }
        if (!sealedCatalogDigest)
        {
            throw new Error('sealed fixtureCatalogDigest is missing');
        }
        if (!sealedCapabilityDigest)
        {
            throw new Error('sealed expandedCapabilityDigest is missing');
        }
        if (!Array.isArray(sealedVariantIds))
        {
            throw new Error('sealed fixtureVariantIds are missing');
        }
        if (!sealedVariantPlanDigest)
        {
            throw new Error('sealed fixtureVariantPlanDigest is missing');
        }
        if (sealedCatalogDigest !== catalogDigest)
        {
            throw new Error('fixture catalog digest drifted after matrix seal; refusing mutation');
        }
        if (sealedCapabilityDigest !== capabilityDigest)
        {
            throw new Error('expanded capability digest drifted after matrix seal; refusing mutation');
        }
        if (JSON.stringify(sealedVariantIds) !== JSON.stringify(variantIds))
        {
            throw new Error('fixture variant IDs drifted after matrix seal; refusing mutation');
        }
        if (sealedVariantPlanDigest !== variantPlan.variantPlanDigest)
        {
            throw new Error('fixture variant plan digest drifted after matrix seal; refusing mutation');
        }
        if (sealedExecutionClass != null)
        {
            if (!plan.allowedExecutionClasses.includes(sealedExecutionClass))
            {
                throw new Error(`sealed execution class ${sealedExecutionClass} is not allowed for profile ${requestedId}`);
            }
            if (executionClass != null && executionClass !== '' && sealedExecutionClass !== executionClass)
            {
                throw new Error(`sealed execution class ${sealedExecutionClass} does not match ${executionClass}`);
            }
        }
    }
    else if (sealed != null)
    {
        throw new Error('dev-cli fixture profile must not carry matrix sealed identity');
    }
    return Object.freeze({
        schema: 'fsusblog.fixture-profile-plan.v1',
        profileId: requestedId,
        profileSource,
        executionClass: resolvedExecutionClass,
        catalogDigest,
        expandedCapabilityDigest: capabilityDigest,
        capabilities: plan.capabilities,
        variantIds,
        variantPlan,
        variantPlanDigest: variantPlan.variantPlanDigest,
        producers: plan.producers,
        mutationPolicy: plan.mutationPolicy,
        isDestructive: plan.isDestructive,
        requiresFreshNamespace: plan.requiresFreshNamespace,
        requiresLocalAuthBypass: plan.requiresLocalAuthBypass,
        requiresAuthFixtures: plan.requiresAuthFixtures,
        requiresPublicFixtures: plan.requiresPublicFixtures,
        requiresDemoSeed: plan.requiresDemoSeed,
        requiresSecurityState: plan.requiresSecurityState,
        sealed: profileSource === 'matrix'
            ? Object.freeze({
        fixtureProfileId: requestedId,
        fixtureCatalogDigest: catalogDigest,
        expandedCapabilityDigest: capabilityDigest,
        fixtureVariantIds: variantIds,
        fixtureVariantPlanDigest: variantPlan.variantPlanDigest,
        executionClass: resolvedExecutionClass
      })
            : null
    });
}

export function inferFixtureExecutionClass(tier, catalogs = readFixtureCatalogs())
{
    const profile = catalogs.profile.profiles.find((item) => item.id === tier?.fixtureProfile);
    const candidates = [];
    if (tier?.resourceClass === 'browser')
    {
        candidates.push('browser');
    }
    if (/^(?:backend-qps|data-scale|load|soak)/u.test(String(tier?.id ?? '')))
    {
        candidates.push('load');
    }
    if (/^(?:csrf|security)/u.test(String(tier?.id ?? '')))
    {
        candidates.push('security');
    }
    if (tier?.requiresBootstrap === 'full' || tier?.selfBootstraps === true)
    {
        candidates.push('acceptance');
    }
    candidates.push('runtime', 'diagnostic');
    for (const candidate of candidates)
    {
        if (profile?.allowedExecutionClasses?.includes(candidate))
        {
            return candidate;
        }
    }
    return profile?.allowedExecutionClasses?.[0] ?? null;
}

export function sealMatrixFixtureProfile(tier, catalogs = readFixtureCatalogs())
{
    if (!tier || !Object.hasOwn(tier, 'fixtureProfile'))
    {
        throw new Error('matrix tier is missing fixtureProfile');
    }
    const executionClass = inferFixtureExecutionClass(tier, catalogs);
    const plan = planFixtureMutation(tier.fixtureProfile, catalogs);
    if (executionClass != null && !plan.allowedExecutionClasses.includes(executionClass))
    {
        throw new Error(`fixture profile ${tier.fixtureProfile} rejects execution class ${executionClass}`);
    }
    const catalogDigest = fixtureCatalogDigest(catalogs);
    const capabilityDigest = expandedCapabilityDigest(plan.capabilities);
    const variantIds = resolveFixtureVariants(plan.capabilities, executionClass, catalogs);
    const variantPlan = buildFixtureVariantPlan(variantIds, catalogs);
    return resolveFixtureProfile({
        profileId: tier.fixtureProfile,
        profileSource: 'matrix',
        executionClass,
        sealed: {
            fixtureProfileId: tier.fixtureProfile,
            fixtureCatalogDigest: catalogDigest,
            expandedCapabilityDigest: capabilityDigest,
            fixtureVariantIds: variantIds,
            fixtureVariantPlanDigest: variantPlan.variantPlanDigest,
            executionClass
        },
        catalogs,
        // Sealing happens inside the matrix runner before child env is built.
        allowFreeProfileEnv: true,
        freeProfileEnv: ''
    });
}

export function writeFixtureProfileReceipt(file, plan, {
    kind = 'planned-profile',
    fixtureReceiptPath = null,
    fixtureReceiptDigest = null,
    fixtureReceiptTerminalStatus = null,
    fixtureReceiptDocument = null,
    extra = null
} = {})
{
    if (!file)
    {
        throw new Error('fixture profile receipt path is required');
    }
    // #1710 one-shot: fixture-receipt.v1 removed — use tools/test-fixtures FixtureReceipt v2.
    if (kind === 'fixture-receipt')
    {
        throw new Error(
            'writeFixtureProfileReceipt kind=fixture-receipt was deleted; write FixtureReceipt v2 via tools/test-fixtures/receipt'
        );
    }
    if (kind !== 'planned-profile' && kind !== 'environment-ready')
    {
        throw new Error(`unsupported fixture profile receipt kind: ${kind}`);
    }
    if (kind === 'environment-ready' && fixtureReceiptPath != null)
    {
        if (!fixtureReceiptDocument || typeof fixtureReceiptDocument !== 'object')
        {
            throw new Error('environment-ready requires a validated FixtureReceipt document when a receipt path is present');
        }
        const comparisons = [
            ['profile id', fixtureReceiptDocument.profileIdentity?.profileId, plan.profileId],
            ['profile source', fixtureReceiptDocument.profileIdentity?.profileSource, plan.profileSource],
            ['execution class', fixtureReceiptDocument.profileIdentity?.executionClass ?? null, plan.executionClass ?? null],
            ['catalog digest', fixtureReceiptDocument.catalogDigest, plan.catalogDigest],
            ['capability digest', fixtureReceiptDocument.expandedCapabilityDigest, plan.expandedCapabilityDigest],
            ['variant ids', fixtureReceiptDocument.fixtureVariantIds, plan.variantIds ?? plan.fixtureVariantIds ?? []],
            ['variant plan digest', fixtureReceiptDocument.variantPlanDigest, plan.variantPlanDigest ?? plan.fixtureVariantPlanDigest]
        ];
        for (const [label, actual, expected] of comparisons)
        {
            if (stableStringify(actual) !== stableStringify(expected))
            {
                throw new Error(`environment-ready FixtureReceipt ${label} does not match the planned profile`);
            }
        }
        if (fixtureReceiptDocument.schema !== 'fsusblog.fixture-receipt.v2'
      || fixtureReceiptDocument.terminalStatus !== 'verified')
        {
            throw new Error('environment-ready requires a verified FixtureReceipt v2');
        }
        if (!/^sha256:[a-f0-9]{64}$/u.test(String(fixtureReceiptDocument.receiptDigest ?? '')))
        {
            throw new Error('environment-ready requires the validated FixtureReceipt digest');
        }
        if (fixtureReceiptTerminalStatus !== 'verified')
        {
            throw new Error('environment-ready verified FixtureReceipt must declare terminal status verified');
        }
        if (fixtureReceiptDigest != null && fixtureReceiptDigest !== fixtureReceiptDocument.receiptDigest)
        {
            throw new Error('environment-ready FixtureReceipt digest does not match the validated receipt');
        }
        fixtureReceiptDigest = fixtureReceiptDocument.receiptDigest;
    }
    else if (kind === 'environment-ready' && fixtureReceiptTerminalStatus === 'verified')
    {
        throw new Error('environment-ready cannot claim verified without a validated FixtureReceipt');
    }
    const capabilityIds = plan.capabilityIds ?? plan.capabilities ?? [];
    const producerIds = plan.producerIds ?? plan.producers ?? [];
    const receipt = {
        schema: kind === 'environment-ready'
            ? 'fsusblog.fixture-environment-ready.v1'
            : 'fsusblog.fixture-planned-profile.v1',
        kind,
        // generatedAt is audit metadata only — never a currency/completeness criterion (#1710).
        generatedAt: new Date().toISOString(),
        profileId: plan.profileId,
        profileSource: plan.profileSource,
        catalogDigest: plan.catalogDigest,
        expandedCapabilityDigest: plan.expandedCapabilityDigest,
        fixtureVariantIds: plan.variantIds ?? plan.fixtureVariantIds ?? [],
        fixtureVariantPlanDigest: plan.variantPlanDigest ?? plan.fixtureVariantPlanDigest,
        capabilityIds,
        producerIds,
        // Preserve plan-shaped aliases so later receipt writers can rehydrate.
        capabilities: capabilityIds,
        producers: producerIds,
        mutationPolicy: plan.mutationPolicy,
        executionClass: plan.executionClass,
        requiresLocalAuthBypass: plan.requiresLocalAuthBypass,
        requiresAuthFixtures: plan.requiresAuthFixtures,
        requiresPublicFixtures: plan.requiresPublicFixtures,
        requiresDemoSeed: plan.requiresDemoSeed,
        // environment-ready references FixtureReceipt v2 digests; URLs/containers are not completeness proof.
        fixtureReceiptPath,
        fixtureReceiptDigest,
        fixtureReceiptTerminalStatus,
        ...(extra && typeof extra === 'object' ? extra : {})
    };
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    try
    {
        fs.chmodSync(file, 0o600);
    }
    catch
    { /* best-effort on platforms without chmod */ }
    return receipt;
}

export function fixtureReceiptDigestFromFile(file)
{
    // Prefer content-addressed file digest; FixtureReceipt.receiptDigest is authoritative body digest.
    const bytes = fs.readFileSync(file);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function applySealedFixtureProfileEnvironment(env, plan)
{
    const next = { ...env };
    next.FSUSBLOG_SEALED_FIXTURE_PROFILE_ID = plan.profileId;
    next.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST = plan.catalogDigest;
    next.FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST = plan.expandedCapabilityDigest;
    next.FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS = JSON.stringify(plan.variantIds ?? []);
    next.FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST = plan.variantPlanDigest ?? '';
    next.FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS = plan.executionClass ?? '';
    next.FSUSBLOG_FIXTURE_PROFILE_SOURCE = plan.profileSource;
    // Overwrite ambient free-profile env so process.env inheritance cannot smuggle overrides.
    next.FSUSBLOG_FIXTURE_PROFILE = '';
    return next;
}

function validateInventoryTruthfulness(consumer, content, errors)
{
    const fallback = String(consumer.currentFallback ?? '');
    const implicit = String(consumer.implicitSource ?? '');
    if (!fallback || !implicit)
    {
        errors.push(`consumer ${consumer.consumerId} must record source and fallback`);
        return;
    }
    for (const phrase of forbiddenInventoryPhrases)
    {
        if (phrase.test(fallback) || phrase.test(implicit))
        {
            errors.push(`consumer ${consumer.consumerId} inventory uses incomplete environment-default phrasing`);
        }
    }
    const expectedFallback = observeFixtureConsumerSource(consumer.source, content);
    if (fallback !== expectedFallback)
    {
        errors.push(`consumer ${consumer.consumerId} currentFallback is stale or untruthful`);
    }
    // Reject the prior fail pattern: universal hardcoded "no fallback" while source reuses env data.
    if (/no catalog alias or undeclared capability fallback/u.test(fallback)
    && /seedPublicFixtures|FSUSBLOG_PERSIST_AUTH_FIXTURES|PrepareAuthFixturesOnce|reuses public content|existing_article/u.test(content))
    {
        errors.push(`consumer ${consumer.consumerId} hardcodes no-fallback while source reuses env data`);
    }
}

export function validateFixtureCatalogs({
    files = fixtureCatalogFiles,
    matrixFile = path.join(root, 'tests/matrix.yml'),
    validateRepositoryAuthority = true,
    repositoryRoot = root
} = {})
{
    const errors = [];
    let catalogs;
    try
    {
        catalogs = readFixtureCatalogs(files);
    }
    catch (error)
    {
        return [`fixture catalog is unreadable: ${error.message}`];
    }
    const { capability, profile, producer, inventory } = catalogs;
    if (capability.schema !== 'fsusblog.fixture-capability-catalog.v1')
    {
        errors.push('capability catalog schema is invalid');
    }
    if (profile.schema !== 'fsusblog.fixture-profile-catalog.v1')
    {
        errors.push('profile catalog schema is invalid');
    }
    if (producer.schema !== 'fsusblog.fixture-producer-registry.v1')
    {
        errors.push('producer registry schema is invalid');
    }
    if (inventory.schema !== 'fsusblog.fixture-consumer-inventory.v1')
    {
        errors.push('consumer inventory schema is invalid');
    }
    const domains = new Set(readJson(path.join(repositoryRoot, capability.stateDomainRegistry)).domains ?? []);
    const capabilities = capability.capabilities ?? [];
    const producers = producer.producers ?? [];
    const profiles = profile.profiles ?? [];
    const capabilityIds = new Set(capabilities.map((item) => item.id));
    const producerIds = new Set(producers.map((item) => item.id));
    const profileIds = new Set(profiles.map((item) => item.id));
    for (const [label, values] of [['capability', capabilities.map((item) => item.id)], ['producer', producers.map((item) => item.id)], ['profile', profiles.map((item) => item.id)]])
    {
        if (duplicate(values).length)
        {
            errors.push(`duplicate ${label} id ${duplicate(values).sort().join(', ')}`);
        }
    }
    for (const item of capabilities)
    {
        if (!stableId.test(item.id ?? ''))
        {
            errors.push(`capability has unstable id ${item.id}`);
        }
        for (const field of ['stateDomains', 'dependsOn', 'conflictsWith', 'postconditionIds'])
        {
            if (!sortedUnique(item[field]))
            {
                errors.push(`capability ${item.id} ${field} must be sorted and unique stable IDs`);
            }
        }
        if (item.stateDomains?.length === 0)
        {
            errors.push(`capability ${item.id} must declare state domains`);
        }
        if (item.postconditionIds?.length === 0)
        {
            errors.push(`capability ${item.id} must declare postconditions`);
        }
        if (!stableId.test(item.resetContractId ?? ''))
        {
            errors.push(`capability ${item.id} must declare a stable reset contract`);
        }
        if (!producerIds.has(item.ownerProducerId))
        {
            errors.push(`capability ${item.id} has unknown owner ${item.ownerProducerId}`);
        }
        validateReferences(item.stateDomains, domains, `capability ${item.id}.stateDomains`, errors);
        validateReferences(item.dependsOn, capabilityIds, `capability ${item.id}.dependsOn`, errors);
        validateReferences(item.conflictsWith, capabilityIds, `capability ${item.id}.conflictsWith`, errors);
        if (!['namespace', 'run', 'scenario'].includes(item.scope))
        {
            errors.push(`capability ${item.id} has invalid scope`);
        }
        if (!['immutable', 'scenario-owned'].includes(item.mutability))
        {
            errors.push(`capability ${item.id} has invalid mutability`);
        }
        const validityClasses = item.validityClasses ?? FIXTURE_VALIDITY_CLASSES;
        if (!sortedUnique(validityClasses)
            || validityClasses.length === 0
            || validityClasses.some((value) => !FIXTURE_VALIDITY_CLASSES.includes(value)))
        {
            errors.push(`capability ${item.id} validityClasses must be sorted, unique and known`);
        }
    }
    for (const item of producers)
    {
        if (!stableId.test(item.id ?? ''))
        {
            errors.push(`producer has unstable id ${item.id}`);
        }
        for (const field of ['provides', 'consumes', 'stateDomains', 'receiptPostconditions'])
        {
            if (!sortedUnique(item[field]))
            {
                errors.push(`producer ${item.id} ${field} must be sorted and unique stable IDs`);
            }
        }
        if (!item.provides?.length)
        {
            errors.push(`producer ${item.id} must provide capabilities`);
        }
        if (!Array.isArray(item.implementationPaths) || item.implementationPaths.length === 0 || item.implementationPaths.some((value, index) => typeof value !== 'string' || (!index ? false : item.implementationPaths[index - 1] >= value)))
        {
            errors.push(`producer ${item.id} implementationPaths must be non-empty, sorted and unique`);
        }
        if (!['transaction-fixture', 'public-api-scenario', 'deterministic-generator'].includes(item.strategy))
        {
            errors.push(`producer ${item.id} has invalid strategy`);
        }
        // #1711: every catalog producer must register FixtureReceipt run-once reuse verifier.
        if (item.reuseVerifier !== 'fixture-receipt')
        {
            errors.push(`producer ${item.id} must register reuseVerifier=fixture-receipt (#1711); omission fails closed`);
        }
        validateReferences(item.provides, capabilityIds, `producer ${item.id}.provides`, errors);
        validateReferences(item.consumes, capabilityIds, `producer ${item.id}.consumes`, errors);
        validateReferences(item.stateDomains, domains, `producer ${item.id}.stateDomains`, errors);
        const expectedDomains = [...new Set([...item.provides, ...item.consumes].flatMap((id) => capability.capabilities.find((candidate) => candidate.id === id)?.stateDomains ?? []))].sort();
        if (JSON.stringify(item.stateDomains) !== JSON.stringify(expectedDomains))
        {
            errors.push(`producer ${item.id} stateDomains must exactly match capability domains`);
        }
        const expectedPostconditions = [...new Set(item.provides.flatMap((id) => capability.capabilities.find((candidate) => candidate.id === id)?.postconditionIds ?? []))].sort();
        if (JSON.stringify(item.receiptPostconditions) !== JSON.stringify(expectedPostconditions))
        {
            errors.push(`producer ${item.id} receiptPostconditions must exactly match provided capability postconditions`);
        }
    }
    // One owner per capability; API + direct-DB cannot both claim the same capability as producers.
    for (const item of capabilities)
    {
        const owners = producers.filter((candidate) => candidate.provides.includes(item.id));
        if (owners.length !== 1 || owners[0]?.id !== item.ownerProducerId)
        {
            errors.push(`capability ${item.id} must have exactly owner ${item.ownerProducerId}`);
        }
    }
    const strategyByCapability = new Map();
    for (const item of producers)
    {
        for (const capabilityId of item.provides)
        {
            const prior = strategyByCapability.get(capabilityId);
            if (prior && prior !== item.strategy)
            {
                errors.push(`capability ${capabilityId} has mixed producer strategies ${prior} and ${item.strategy}; API and direct-DB cannot be runtime fallbacks`);
            }
            strategyByCapability.set(capabilityId, item.strategy);
        }
    }
    const securityIds = capabilities.filter((item) => /^(?:security\.|auth\.user\.banned)/u.test(item.id)).map((item) => item.id);
    for (const id of securityIds)
    {
        if (capability.capabilities.find((item) => item.id === id).ownerProducerId !== 'security-state')
        {
            errors.push(`security capability ${id} must be owned by security-state`);
        }
    }
    for (const item of producers.find((candidate) => candidate.id === 'auth-session')?.provides ?? [])
    {
        if (/^(?:security\.|auth\.user\.banned)/u.test(item))
        {
            errors.push('auth-session must not provide security capability');
        }
    }
    for (const item of profiles)
    {
        if (!stableId.test(item.id ?? '') || !sortedUnique(item.capabilities))
        {
            errors.push(`profile ${item.id} capabilities must be sorted and unique stable IDs`);
        }
        if (!sortedUnique(item.allowedExecutionClasses) || item.allowedExecutionClasses.length === 0 || item.allowedExecutionClasses.some((value) => !['acceptance', 'browser', 'development', 'diagnostic', 'load', 'runtime', 'security'].includes(value)))
        {
            errors.push(`profile ${item.id} allowedExecutionClasses must be non-empty, sorted, unique and known`);
        }
        if (typeof item.isDestructive !== 'boolean' || typeof item.requiresFreshNamespace !== 'boolean')
        {
            errors.push(`profile ${item.id} mutation and namespace flags must be boolean`);
        }
        validateReferences(item.capabilities, capabilityIds, `profile ${item.id}.capabilities`, errors);
        try
        {
            expandFixtureProfile(item.id, catalogs);
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    const none = profiles.find((item) => item.id === 'none');
    if (!none || none.capabilities.length !== 0 || none.isDestructive || none.requiresFreshNamespace)
    {
        errors.push('none profile must declare zero producers, zero business mutation and zero reset');
    }
    if ([...capabilityIds].some((id) => /(?:^|[.-])all(?:[.-]|$)/u.test(id)))
    {
        errors.push('broad fixture capability is forbidden');
    }
    const inventoryConsumerIds = (inventory.consumers ?? []).map((item) => item.consumerId);
    if (duplicate(inventoryConsumerIds).length)
    {
        errors.push(`duplicate fixture inventory consumer id ${duplicate(inventoryConsumerIds).sort().join(', ')}`);
    }
    for (const consumer of inventory.consumers ?? [])
    {
        if (!consumer.consumerId || !Array.isArray(consumer.requiredCapabilities))
        {
            errors.push('consumer inventory entry is incomplete');
        }
        validateReferences(consumer.requiredCapabilities, capabilityIds, `consumer ${consumer.consumerId}`, errors);
        if (consumer.requiredCapabilities.length && consumer.profileId === 'none')
        {
            errors.push(`data consumer ${consumer.consumerId} cannot use none profile`);
        }
        if (!consumer.implicitSource || !consumer.currentFallback)
        {
            errors.push(`consumer ${consumer.consumerId} must record source and fallback`);
        }
        const selectedProfiles = consumer.profileIds ?? [consumer.profileId];
        if (!sortedUnique(selectedProfiles) || selectedProfiles.length === 0)
        {
            errors.push(`consumer ${consumer.consumerId} profile bindings must be non-empty, sorted and unique`);
        }
        for (const profileId of selectedProfiles)
        {
            const selectedProfile = profiles.find((item) => item.id === profileId);
            if (!selectedProfile)
            {
                errors.push(`consumer ${consumer.consumerId} references unknown profile ${profileId}`);
            }
            else if (!selectedProfile.allowedExecutionClasses.includes(consumer.executionClass) && !consumer.consumerId.startsWith('source:'))
            {
                errors.push(`consumer ${consumer.consumerId} profile ${profileId} rejects execution class ${consumer.executionClass}`);
            }
        }
        if (selectedProfiles.every((profileId) => profileIds.has(profileId)))
        {
            try
            {
                const expanded = new Set(selectedProfiles.flatMap((profileId) => expandFixtureProfile(profileId, catalogs).capabilities));
                for (const required of consumer.requiredCapabilities)
                {
                    if (!expanded.has(required))
                    {
                        errors.push(`consumer ${consumer.consumerId} profile binding omits required capability ${required}`);
                    }
                }
            }
            catch (error)
            {
                errors.push(`consumer ${consumer.consumerId} profile expansion failed: ${error.message}`);
            }
        }
        try
        {
            const expectedVariants = resolveFixtureVariants(
                consumer.requiredCapabilities,
                consumer.executionClass,
                catalogs,
                { requestedVariantIds: consumer.requiredVariantIds }
            );
            if (JSON.stringify(consumer.requiredVariantIds) !== JSON.stringify(expectedVariants))
            {
                errors.push(`consumer ${consumer.consumerId} variant requirements must exactly match FixtureVariantCatalog`);
            }
        }
        catch (error)
        {
            errors.push(`consumer ${consumer.consumerId} variant resolution failed: ${error.message}`);
        }
    }
    try
    {
        const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'));
        const expectedMatrixConsumers = matrix.tiers.filter(isFixtureMatrixConsumer);
        const profileById = new Map(profiles.map((item) => [item.id, item]));
        for (const tier of matrix.tiers)
        {
            const isConsumer = isFixtureMatrixConsumer(tier);
            const missing = ['fixtureProfile', 'fixtureProfileReason', 'fixtureProfileProof', 'fixtureMutatorAllowed', 'executionClass']
                .filter((field) => !Object.hasOwn(tier, field));
            if (missing.length)
            {
                errors.push(`matrix tier ${tier.id} must bind ${missing.join(', ')}`);
                continue;
            }
            if (Object.hasOwn(tier, 'fixtureCapabilities'))
            {
                errors.push(`matrix tier ${tier.id} must not declare retired fixtureCapabilities field`);
            }
            if (!profileIds.has(tier.fixtureProfile))
            {
                errors.push(`matrix tier ${tier.id} references unknown fixture profile ${tier.fixtureProfile}`);
                continue;
            }
            if (profileById.get(tier.fixtureProfile)?.status === 'deprecated')
            {
                errors.push(`matrix tier ${tier.id} references deprecated fixture profile ${tier.fixtureProfile}`);
            }
            if (tier.fixtureMutatorAllowed !== (tier.fixtureProfile !== 'none'))
            {
                errors.push(`matrix tier ${tier.id} fixtureMutatorAllowed must be ${tier.fixtureProfile !== 'none'}`);
            }
            const expectedReason = tier.fixtureProfile === 'none'
                ? `none-${tier.executionClass}`
                : `binds-${tier.fixtureProfile}`;
            if (tier.fixtureProfileReason !== expectedReason)
            {
                errors.push(`matrix tier ${tier.id} fixtureProfileReason must be ${expectedReason}`);
            }
            if (typeof tier.fixtureProfileProof !== 'string' || !tier.fixtureProfileProof.startsWith('tests/tools/')
        || !tier.fixtureProfileProof.endsWith('.test.mjs'))
            {
                errors.push(`matrix tier ${tier.id} fixtureProfileProof must reference a tests/tools focused test`);
            }
            if (tier.fixtureProfile !== 'none' && !isConsumer)
            {
                errors.push(`matrix non-consumer ${tier.id} must use fixtureProfile none`);
            }
            if (isConsumer && tier.fixtureProfile !== 'none')
            {
                const selectedProfile = profileById.get(tier.fixtureProfile);
                if (!selectedProfile.allowedExecutionClasses.includes(tier.executionClass))
                {
                    errors.push(`matrix data consumer ${tier.id} profile ${tier.fixtureProfile} rejects execution class ${tier.executionClass}`);
                }
            }
            errors.push(...validateNoneFixtureTier(tier, { repositoryRoot }));
        }
        const inventoryMatrixIds = (inventory.consumers ?? []).filter((item) => item.consumerId.startsWith('matrix:')).map((item) => item.consumerId.slice('matrix:'.length)).sort();
        if (JSON.stringify(inventoryMatrixIds) !== JSON.stringify(expectedMatrixConsumers.map((tier) => tier.id).sort()))
        {
            errors.push('matrix data consumers and generated inventory must bidirectionally exact match');
        }
        const inventoryById = new Map((inventory.consumers ?? []).map((item) => [item.consumerId, item]));
        for (const tier of expectedMatrixConsumers)
        {
            const entry = inventoryById.get(`matrix:${tier.id}`);
            let requiredCapabilities;
            try
            {
                requiredCapabilities = expandFixtureProfile(tier.fixtureProfile, catalogs).capabilities;
            }
            catch (error)
            {
                errors.push(`matrix tier ${tier.id} profile expansion failed: ${error.message}`);
                continue;
            }
            const expectedVariants = resolveFixtureVariants(
                requiredCapabilities,
                entry?.executionClass ?? inferFixtureExecutionClass(tier, catalogs),
                catalogs,
                { requestedVariantIds: entry?.requiredVariantIds }
            );
            if (entry && (entry.profileId !== tier.fixtureProfile || JSON.stringify(entry.requiredCapabilities) !== JSON.stringify(requiredCapabilities) || JSON.stringify(entry.requiredVariantIds) !== JSON.stringify(expectedVariants)))
            {
                errors.push(`matrix tier ${tier.id} and generated inventory declaration differ`);
            }
            if (entry)
            {
                validateInventoryTruthfulness(entry, matrixConsumerObservationContent(tier, { repositoryRoot }), errors);
            }
        }
    }
    catch (error)
    {
        errors.push(`matrix is unreadable for fixture validation: ${error.message}`);
    }
    try
    {
        const declarations = scanFixtureSourceDeclarations({ repositoryRoot });
        const declaredImplementations = declarations.producers;
        const registryImplementations = producers.flatMap((item) => item.implementationPaths.map((source) => ({ producerId: item.id, source }))).sort((left, right) => left.producerId.localeCompare(right.producerId) || left.source.localeCompare(right.source));
        if (JSON.stringify(declaredImplementations) !== JSON.stringify(registryImplementations))
        {
            errors.push('producer registry and source implementations must bidirectionally exact match');
        }
        const inventorySourceIds = (inventory.consumers ?? []).filter((item) => item.consumerId.startsWith('source:')).map((item) => item.consumerId.slice('source:'.length)).sort();
        if (JSON.stringify(inventorySourceIds) !== JSON.stringify(declarations.consumers.map((item) => item.id).sort()))
        {
            errors.push('fixture source declarations and generated inventory must bidirectionally exact match');
        }
        const inventoryById = new Map((inventory.consumers ?? []).map((item) => [item.consumerId, item]));
        for (const declaration of declarations.consumers)
        {
            if (declaration.profileId !== 'matrix' && !profileIds.has(declaration.profileId))
            {
                errors.push(`fixture source ${declaration.source} references unknown profile ${declaration.profileId}`);
            }
            const entry = inventoryById.get(`source:${declaration.id}`);
            if (!entry)
            {
                continue;
            }
            const expectedProfiles = declaration.profileId === 'matrix'
                ? entry.profileIds
                : [declaration.profileId];
            if (JSON.stringify(entry.profileIds) !== JSON.stringify(expectedProfiles)
        || entry.profileId !== (expectedProfiles.length === 1 ? expectedProfiles[0] : null))
            {
                errors.push(`fixture source ${declaration.id} and generated inventory profile binding differ`);
            }
            if (expectedProfiles.every((profileId) => profileIds.has(profileId)))
            {
                const expectedCapabilities = [...new Set(expectedProfiles.flatMap((profileId) => expandFixtureProfile(profileId, catalogs).capabilities))].sort();
                if (JSON.stringify(entry.requiredCapabilities) !== JSON.stringify(expectedCapabilities))
                {
                    errors.push(`fixture source ${declaration.id} and generated inventory capabilities differ`);
                }
            }
            const content = fs.readFileSync(path.join(repositoryRoot, declaration.source), 'utf8');
            validateInventoryTruthfulness(entry, content, errors);
        }
        if (JSON.stringify(inventory.producerImplementations ?? []) !== JSON.stringify(declaredImplementations))
        {
            errors.push('producer implementation inventory is stale');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (validateRepositoryAuthority)
    {
        errors.push(...validateFixtureAuthoritySources({ repositoryRoot }));
    }
    // Variant catalog validation (#1722)
    errors.push(...validateFixtureVariantCatalog({
        variantFile: files.variant ?? fixtureCatalogFiles.variant,
        capabilityFile: files.capability ?? fixtureCatalogFiles.capability,
        producerFile: files.producer ?? fixtureCatalogFiles.producer
    }));
    errors.push(...validateFixtureSentinelRegistry({ catalogs, repositoryRoot }));
    errors.push(...validateContentShapeAuthority({ root: repositoryRoot }));
    return errors;
}

function parseCliArgs(argv)
{
    const options = { _: [] };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--')
        {
            options._.push(...argv.slice(index + 1));
            break;
        }
        if (arg.startsWith('--'))
        {
            const eq = arg.indexOf('=');
            if (eq >= 0)
            {
                options[arg.slice(2, eq)] = arg.slice(eq + 1);
            }
            else
            {
                const key = arg.slice(2);
                const next = argv[index + 1];
                if (next != null && !next.startsWith('--'))
                {
                    options[key] = next;
                    index += 1;
                }
                else
                {
                    options[key] = true;
                }
            }
        }
        else
        {
            options._.push(arg);
        }
    }
    return options;
}

function parseVariantIdsOption(value, label)
{
    if (value == null || value === '')
    {
        return null;
    }
    const text = String(value).trim();
    if (!text)
    {
        return null;
    }
    if (text.startsWith('['))
    {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
        {
            throw new Error(`${label} must be a JSON array or comma-separated ids`);
        }
        return parsed.map(String);
    }
    return text.split(',').map((item) => item.trim()).filter(Boolean);
}

async function runCli(argv = process.argv.slice(2))
{
    const options = parseCliArgs(argv);
    const command = options._[0] ?? 'validate';
    if (command === 'validate')
    {
        const errors = validateFixtureCatalogs();
        if (errors.length)
        {
            process.stderr.write(`${errors.join('\n')}\n`);
            process.exit(1);
        }
        process.stdout.write('fixture capability catalog valid\n');
        return;
    }
    if (command === 'resolve')
    {
        const profileId = options.profile ?? options['profile-id'];
        const profileSource = options.source ?? options['profile-source'];
        const executionClass = options['execution-class'] ?? null;
        const out = options.out ?? options.output ?? null;
        const kind = options.kind ?? 'planned-profile';
        const requestedVariantIds = parseVariantIdsOption(options['variant-ids'], '--variant-ids');
        const sealedVariantIds = parseVariantIdsOption(
            options['sealed-variant-ids'] ?? process.env.FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS,
            '--sealed-variant-ids'
        );
        const sealed = profileSource === 'matrix'
            ? {
        fixtureProfileId: options['sealed-profile-id'] ?? profileId,
        fixtureCatalogDigest: options['sealed-catalog-digest'],
        expandedCapabilityDigest: options['sealed-capability-digest'],
        fixtureVariantIds: sealedVariantIds,
        fixtureVariantPlanDigest: options['sealed-variant-plan-digest']
          ?? process.env.FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST,
        executionClass: options['sealed-execution-class'] ?? executionClass
      }
            : null;
        const plan = resolveFixtureProfile({
            profileId,
            profileSource,
            executionClass,
            requestedVariantIds: requestedVariantIds ?? sealedVariantIds,
            sealed,
            allowFreeProfileEnv: profileSource === 'dev-cli',
            freeProfileEnv: profileSource === 'dev-cli' ? '' : process.env.FSUSBLOG_FIXTURE_PROFILE
        });
        if (out)
        {
            writeFixtureProfileReceipt(out, plan, { kind });
        }
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        return;
    }
    if (command === 'digest')
    {
        const catalogs = readFixtureCatalogs();
        const profileId = options.profile ?? options['profile-id'] ?? 'none';
        const plan = planFixtureMutation(profileId, catalogs);
        process.stdout.write(`${JSON.stringify({
            catalogDigest: fixtureCatalogDigest(catalogs),
            expandedCapabilityDigest: expandedCapabilityDigest(plan.capabilities),
            profileId,
            capabilities: plan.capabilities,
            producers: plan.producers,
            mutationPolicy: plan.mutationPolicy
        })}\n`);
        return;
    }
    if (command === 'receipt-digest')
    {
        const file = options.file ?? options._[1];
        if (!file)
        {
            throw new Error('receipt-digest requires --file');
        }
        process.stdout.write(`${fixtureReceiptDigestFromFile(file)}\n`);
        return;
    }
    if (command === 'write-receipt')
    {
        const planFile = options.plan ?? options['plan-file'];
        const out = options.out ?? options.output;
        if (!planFile || !out)
        {
            throw new Error('write-receipt requires --plan and --out');
        }
        const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        const fixtureReceiptPath = options['fixture-receipt'] ?? null;
        const fixtureReceiptTerminalStatus = options['fixture-receipt-terminal-status'] ?? null;
        let fixtureReceiptDocument = null;
        if (fixtureReceiptPath)
        {
            const { readFixtureReceipt } = await import('../test-fixtures/receipt/fixture-receipt.mjs');
            fixtureReceiptDocument = readFixtureReceipt(fixtureReceiptPath, {
                requireVerified: fixtureReceiptTerminalStatus === 'verified'
            });
        }
        const fixtureReceiptDigest = fixtureReceiptDocument?.receiptDigest
      ?? (options['fixture-receipt-digest'] ?? null);
        const receipt = writeFixtureProfileReceipt(out, plan, {
            kind: options.kind ?? 'environment-ready',
            fixtureReceiptPath,
            fixtureReceiptDigest,
            fixtureReceiptTerminalStatus,
            fixtureReceiptDocument
        });
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
        return;
    }
    throw new Error(`unknown fixture-catalog command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    runCli().catch((error) =>
    {
        process.stderr.write(`${error?.message ?? error}\n`);
        process.exit(1);
    });
}
