import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const executionEnvelopePolicyFile = path.join(
    root,
    'config/testing/test-execution-envelope-policy.json'
);
export const executionEnvelopeApplicabilityFile = path.join(
    root,
    'config/testing/test-execution-envelope-applicability.json'
);
export const executionEnvelopePolicySchemaFile = path.join(
    root,
    'config/schemas/test-execution-envelope-policy.schema.json'
);
export const executionEnvelopeApplicabilitySchemaFile = path.join(
    root,
    'config/schemas/test-execution-envelope-applicability.schema.json'
);
export const producerExecutionClassContractFile = path.join(
    root,
    'config/testing/producer-execution-class-contract.json'
);
export const correctnessEvidenceClasses = Object.freeze([
    'correctness',
    'browser-contract'
]);

function canonicalRunnerInvocations(file)
{
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'config/governance/custom-rule-registry.json')
    {
        return JSON.parse(source).rules
            .map((rule) => String(rule.execution?.command ?? ''))
            .filter((command) => command.includes('run-deterministic-command.mjs'));
    }
    return [...source.matchAll(/run-deterministic-command\.mjs\b/gu)]
        .filter((match) => !source.slice(
            source.lastIndexOf('\n', match.index) + 1,
            match.index
        ).includes('--path'))
        .map((match) => source.slice(match.index, match.index + 1200));
}

function invocationOption(invocation, name)
{
    const pattern = new RegExp(`--${name}\\s+(?:["']([^"']+)["']|([^\\s"'\\\\]+))`, 'u');
    return invocation.match(pattern)?.slice(1).find(Boolean) ?? null;
}

function canonicalRunnerProducerIds(producerContract, errors)
{
    const values = [];
    for (const [file, expectedKeys] of Object.entries(
        producerContract?.canonicalRunnerInvocations ?? {}
    ))
    {
        let invocations;
        try
        {
            invocations = canonicalRunnerInvocations(file);
        }
        catch (error)
        {
            errors.push(`${file}: canonical runner source is unreadable: ${error.message}`);
            continue;
        }
        for (const key of expectedKeys)
        {
            const matches = invocations.filter((invocation) =>
                invocationOption(invocation, 'key') === key);
            if (matches.length !== 1)
            {
                errors.push(`${file}/${key}: canonical runner invocation must be exact-one`);
                continue;
            }
            const declaredProducerId = invocationOption(matches[0], 'producer-id');
            if (!declaredProducerId)
            {
                errors.push(`${file}/${key}: canonical runner producer identity is missing`);
                continue;
            }
            values.push(declaredProducerId.startsWith('$') ? key : declaredProducerId);
        }
    }
    return new Set(values);
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

export function executionEnvelopeDigest(value)
{
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalize(value)))
        .digest('hex')}`;
}

function readJson(file, identity)
{
    if (!fs.existsSync(file))
    {
        return { missing: true, identity, file };
    }
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        return {
            invalid: true,
            identity,
            file,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function loadExecutionEnvelopePolicy(
    file = executionEnvelopePolicyFile
)
{
    return readJson(file, 'execution envelope policy');
}

export function loadExecutionEnvelopeApplicability(
    file = executionEnvelopeApplicabilityFile
)
{
    return readJson(file, 'execution envelope applicability catalog');
}

export function executionEnvelopeEvidenceClass(tier)
{
    return tier?.evidenceClass ?? 'correctness';
}

export function isCorrectnessEnvelopeProducer(tier)
{
    return correctnessEvidenceClasses.includes(executionEnvelopeEvidenceClass(tier));
}

export function matchingExecutionEnvelopeProducers(producerId, catalog)
{
    return (catalog?.producers ?? []).filter((entry) => entry.producerId === producerId);
}

export function resolveExecutionEnvelopeProducer(producerId, catalog)
{
    const matches = matchingExecutionEnvelopeProducers(producerId, catalog);
    if (matches.length !== 1)
    {
        throw new Error(
            `${producerId}: correctness producer must have exactly one execution envelope applicability entry; matched ${matches.length}`
        );
    }
    return matches[0];
}

function schemaErrors(document, schemaFile, label)
{
    if (!fs.existsSync(schemaFile))
    {
        return [`${label} schema source is missing`];
    }
    let schema;
    try
    {
        schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    }
    catch (error)
    {
        return [`${label} schema is invalid JSON: ${error.message}`];
    }
    const errors = [];
    validateSchemaValue(document, schema, schema, '', errors);
    return errors.map((error) => `${label} schema ${error}`);
}

function schemaPath(value)
{
    return value || '/';
}

function resolveSchemaReference(rootSchema, reference)
{
    if (!reference.startsWith('#/'))
    {
        throw new Error(`unsupported execution envelope schema reference: ${reference}`);
    }
    return reference
        .slice(2)
        .split('/')
        .reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
}

function valueMatchesType(value, type)
{
    if (Array.isArray(type))
    {
        return type.some((entry) => valueMatchesType(value, entry));
    }
    if (type === 'null')
    {
        return value === null;
    }
    if (type === 'array')
    {
        return Array.isArray(value);
    }
    if (type === 'object')
    {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    if (type === 'integer')
    {
        return Number.isInteger(value);
    }
    if (type === 'number')
    {
        return typeof value === 'number' && Number.isFinite(value);
    }
    return typeof value === type;
}

function validateSchemaValue(value, schema, rootSchema, location, errors)
{
    if (schema.$ref)
    {
        validateSchemaValue(
            value,
            resolveSchemaReference(rootSchema, schema.$ref),
            rootSchema,
            location,
            errors
        );
        return;
    }
    if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const))
    {
        errors.push(`${schemaPath(location)} must equal its declared constant`);
        return;
    }
    if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)))
    {
        errors.push(`${schemaPath(location)} is not an allowed value`);
        return;
    }
    if (schema.type && !valueMatchesType(value, schema.type))
    {
        errors.push(`${schemaPath(location)} must be ${schema.type}`);
        return;
    }
    if (schema.type === 'object')
    {
        for (const key of schema.required ?? [])
        {
            if (!Object.hasOwn(value, key))
            {
                errors.push(`${schemaPath(`${location}/${key}`)} is required`);
            }
        }
        if (schema.additionalProperties === false)
        {
            for (const key of Object.keys(value))
            {
                if (!Object.hasOwn(schema.properties ?? {}, key))
                {
                    errors.push(`${schemaPath(`${location}/${key}`)} is unknown`);
                }
            }
        }
        for (const [key, childSchema] of Object.entries(schema.properties ?? {}))
        {
            if (Object.hasOwn(value, key))
            {
                validateSchemaValue(value[key], childSchema, rootSchema, `${location}/${key}`, errors);
            }
        }
        return;
    }
    if (schema.type === 'array')
    {
        if (Number.isInteger(schema.minItems) && value.length < schema.minItems)
        {
            errors.push(`${schemaPath(location)} must contain at least ${schema.minItems} items`);
        }
        if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems)
        {
            errors.push(`${schemaPath(location)} must contain at most ${schema.maxItems} items`);
        }
        if (schema.uniqueItems === true)
        {
            const serialized = value.map((entry) => JSON.stringify(canonicalize(entry)));
            if (new Set(serialized).size !== serialized.length)
            {
                errors.push(`${schemaPath(location)} must contain unique items`);
            }
        }
        if (schema.items)
        {
            value.forEach((entry, index) =>
                validateSchemaValue(entry, schema.items, rootSchema, `${location}/${index}`, errors));
        }
        return;
    }
    if (schema.type === 'string')
    {
        if (Number.isInteger(schema.minLength) && value.length < schema.minLength)
        {
            errors.push(`${schemaPath(location)} is too short`);
        }
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
        {
            errors.push(`${schemaPath(location)} does not match ${schema.pattern}`);
        }
    }
}

export function validateExecutionEnvelopeContracts({
    matrix,
    policy,
    catalog,
    producerContract = readJson(
        producerExecutionClassContractFile,
        'producer execution class contract'
    ),
    policySchemaFile = executionEnvelopePolicySchemaFile,
    applicabilitySchemaFile = executionEnvelopeApplicabilitySchemaFile
})
{
    const errors = [];
    for (const source of [policy, catalog, producerContract])
    {
        if (source?.missing === true)
        {
            errors.push(`${source.identity} source is missing`);
        }
        if (source?.invalid === true)
        {
            errors.push(`${source.identity} source is invalid: ${source.error}`);
        }
    }
    if (errors.length > 0)
    {
        return errors;
    }
    errors.push(...schemaErrors(policy, policySchemaFile, 'policy'));
    errors.push(...schemaErrors(catalog, applicabilitySchemaFile, 'applicability'));

    const observerById = new Map();
    for (const observer of catalog?.observers ?? [])
    {
        if (observerById.has(observer.id))
        {
            errors.push(`duplicate execution envelope observer id: ${observer.id}`);
        }
        observerById.set(observer.id, observer);
    }
    const expectedDomains = new Set([
        'platform',
        'resources',
        'environment',
        'toolchain',
        'browserRendering',
        'services',
        'directories',
        'network',
        'fontsLocale',
        'identity'
    ]);
    for (const domain of expectedDomains)
    {
        const observers = [...observerById.values()]
            .filter((observer) => observer.domain === domain);
        if (observers.length !== 1)
        {
            errors.push(`${domain}: envelope domain must have exactly one observer; matched ${observers.length}`);
        }
    }
    const producerIds = new Set();
    for (const producer of catalog?.producers ?? [])
    {
        if (producerIds.has(producer.producerId))
        {
            errors.push(`duplicate applicability producer id: ${producer.producerId}`);
        }
        producerIds.add(producer.producerId);
        if (producer.policyId !== policy?.policyId)
        {
            errors.push(`${producer.producerId}: unknown policyId ${producer.policyId}`);
        }
        for (const requiredDomain of [
            'platform',
            'resources',
            'environment',
            'toolchain',
            'directories',
            'network',
            'fontsLocale',
            'identity'
        ])
        {
            if (producer.fieldApplicability?.[requiredDomain]?.status !== 'required')
            {
                errors.push(`${producer.producerId}/${requiredDomain}: required envelope field cannot be optional or not-applicable`);
            }
        }
        for (const [domain, applicability] of Object.entries(
            producer.fieldApplicability ?? {}
        ))
        {
            if (applicability.status === 'not-applicable')
            {
                if (applicability.observerId !== null
                    || !String(applicability.notApplicableReason ?? '').trim())
                {
                    errors.push(`${producer.producerId}/${domain}: not-applicable requires null observer and a reason`);
                }
                continue;
            }
            const observer = observerById.get(applicability.observerId);
            if (!observer || observer.domain !== domain
                || applicability.notApplicableReason !== null)
            {
                errors.push(`${producer.producerId}/${domain}: required or optional field lacks its declared domain observer`);
            }
        }
    }

    const excludedEvidenceClasses = new Set(
        (catalog?.excludedEvidenceClasses ?? [])
            .map((entry) => entry?.evidenceClass)
            .filter(Boolean)
    );
    const tierIds = new Set();
    for (const tier of matrix?.tiers ?? [])
    {
        const tierId = tier?.id ?? '<missing>';
        if (tierIds.has(tierId))
        {
            errors.push(`duplicate matrix tier id prevents envelope applicability: ${tierId}`);
        }
        tierIds.add(tierId);
        const matches = matchingExecutionEnvelopeProducers(tierId, catalog);
        if (isCorrectnessEnvelopeProducer(tier))
        {
            if (matches.length !== 1)
            {
                errors.push(
                    `${tierId}: correctness producer must match exactly one execution envelope entry; matched ${matches.length}`
                );
            }
            else
            {
                const entry = matches[0];
                if (entry.evidenceClass !== executionEnvelopeEvidenceClass(tier)
                    || entry.executionClass !== tier.executionClass
                    || entry.sourceKind !== 'matrix-tier')
                {
                    errors.push(`${tierId}: matrix/applicability identity drift`);
                }
                const browser = entry.fieldApplicability?.browserRendering;
                const browserRequired = tier.requiresPlaywright !== 'none';
                if ((browser?.status === 'required') !== browserRequired)
                {
                    errors.push(`${tierId}: browser rendering applicability drift`);
                }
                const services = entry.fieldApplicability?.services;
                const servicesRequired = (tier.services ?? []).length > 0
                    || (tier.clusterFixtures ?? []).length > 0
                    || !['', 'none'].includes(String(tier.coordinationStore ?? '').trim());
                if ((services?.status === 'required') !== servicesRequired)
                {
                    errors.push(`${tierId}: service applicability drift`);
                }
                const expectedServices = [...new Set([
                    ...(tier.services ?? []),
                    ...(!['', 'none'].includes(String(tier.coordinationStore ?? '').trim())
                        ? [String(tier.coordinationStore).trim()]
                        : [])
                ])].sort();
                if (JSON.stringify(entry.requiredServices) !== JSON.stringify(expectedServices))
                {
                    errors.push(`${tierId}: required service applicability drift`);
                }
                const expectedAllowedEnvironment = [
                    'PATH',
                    ...(tier.requiresDotnet ? ['DOTNET_ROOT'] : []),
                    ...(tier.requiresPlaywright !== 'none'
                        ? ['PLAYWRIGHT_BROWSERS_PATH']
                        : []),
                    ...(expectedServices.includes('postgres')
                        ? ['FSUSBLOG_POSTGRES_PORT']
                        : []),
                    ...(expectedServices.includes('redis')
                        ? ['FSUSBLOG_REDIS_PORT']
                        : [])
                ].sort();
                if (JSON.stringify(entry.allowedEnvironment)
                    !== JSON.stringify(expectedAllowedEnvironment))
                {
                    errors.push(`${tierId}: allowed environment drift`);
                }
            }
            continue;
        }
        const evidenceClass = executionEnvelopeEvidenceClass(tier);
        if (!excludedEvidenceClasses.has(evidenceClass))
        {
            errors.push(
                `${tierId}: non-correctness evidenceClass ${evidenceClass} lacks an explicit exclusion`
            );
        }
        if (matches.length !== 0)
        {
            errors.push(
                `${tierId}: excluded producer unexpectedly has correctness applicability`
            );
        }
    }
    const canonicalRunnerIds = canonicalRunnerProducerIds(producerContract, errors);
    for (const runnerId of canonicalRunnerIds)
    {
        const matches = matchingExecutionEnvelopeProducers(runnerId, catalog);
        if (matches.length !== 1)
        {
            errors.push(`${runnerId}: canonical correctness runner must match exactly one execution envelope entry; matched ${matches.length}`);
            continue;
        }
        if (!tierIds.has(runnerId))
        {
            const entry = matches[0];
            if (entry.sourceKind !== 'canonical-runner'
                || entry.evidenceClass !== 'correctness'
                || entry.executionClass !== 'static-governance'
                || JSON.stringify(entry.allowedEnvironment) !== JSON.stringify(['PATH'])
                || JSON.stringify(entry.requiredServices) !== JSON.stringify([])
                || entry.fieldApplicability?.browserRendering?.status !== 'not-applicable'
                || entry.fieldApplicability?.services?.status !== 'not-applicable')
            {
                errors.push(`${runnerId}: canonical runner applicability drift`);
            }
        }
    }
    for (const producerId of producerIds)
    {
        if (!tierIds.has(producerId) && !canonicalRunnerIds.has(producerId))
        {
            errors.push(`unknown applicability producer: ${producerId}`);
        }
    }
    return errors;
}

function schemaIdentity(policySchemaFile, applicabilitySchemaFile)
{
    const schemas = [policySchemaFile, applicabilitySchemaFile].map((file) => ({
        file: path.relative(root, file).replaceAll('\\', '/'),
        sha256: executionEnvelopeDigest(fs.readFileSync(file))
    }));
    return executionEnvelopeDigest(schemas);
}

export function createExecutionEnvelopePolicyIdentity({
    policy,
    catalog,
    policySchemaFile = executionEnvelopePolicySchemaFile,
    applicabilitySchemaFile = executionEnvelopeApplicabilitySchemaFile
})
{
    return Object.freeze({
        schema: 'fsusblog.test-execution-envelope-policy-identity.v1',
        policyId: policy.policyId,
        policyDigest: executionEnvelopeDigest(policy),
        catalogDigest: executionEnvelopeDigest(catalog),
        schemaIdentity: schemaIdentity(policySchemaFile, applicabilitySchemaFile)
    });
}

export function projectExecutionEnvelopeApplicability(matrix, policy, catalog)
{
    const errors = validateExecutionEnvelopeContracts({ matrix, policy, catalog });
    if (errors.length > 0)
    {
        throw new Error(`execution envelope contract is invalid:\n${errors.join('\n')}`);
    }
    const identity = createExecutionEnvelopePolicyIdentity({ policy, catalog });
    return (matrix.tiers ?? [])
        .filter(isCorrectnessEnvelopeProducer)
        .map((tier) =>
        {
            const producer = resolveExecutionEnvelopeProducer(tier.id, catalog);
            return Object.freeze({
                schema: 'fsusblog.test-execution-envelope-applicability-projection.v1',
                producerId: tier.id,
                evidenceClass: executionEnvelopeEvidenceClass(tier),
                executionClass: tier.executionClass,
                policyId: producer.policyId,
                fieldApplicability: producer.fieldApplicability,
                allowedEnvironment: producer.allowedEnvironment,
                ...identity
            });
        });
}
