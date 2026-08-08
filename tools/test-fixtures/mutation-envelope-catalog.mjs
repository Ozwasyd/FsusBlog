#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    fixtureCatalogDigest,
    readFixtureCatalogs
} from '../testing/fixture-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const mutationEnvelopeCatalogSchema = 'fsusblog.mutation-envelope-catalog.v1';
export const canonicalMutationEnvelopeCatalogPath =
    'config/testing/fixture-mutation-envelope-catalog.json';

export const mutationEnvelopeCatalogSchemaPath =
    'config/schemas/fixture-mutation-envelope-catalog.schema.json';

export const mutationKinds = Object.freeze([
    'set-wrong-value',
    'remove-required-row/relation',
    'add-extra-owned-relation',
    'delete-owned-file',
    'truncate-owned-file',
    'replace-owned-bytes',
    'delete-owned-cache-key',
    'modify-owned-cache-key'
]);
const mutationKindSet = new Set(mutationKinds);

export const providers = Object.freeze([
    'postgresql',
    'mysql',
    'sqlite',
    'redis',
    'filesystem'
]);
const providerSet = new Set(providers);

export const entityKinds = Object.freeze([
    'article',
    'category',
    'tag',
    'user',
    'admin',
    'session',
    'comment',
    'thread',
    'notification',
    'preference',
    'media',
    'other'
]);
const entityKindSet = new Set(entityKinds);

export const fileRoles = Object.freeze([
    'original',
    'thumbnail',
    'variant',
    'raw'
]);
const fileRoleSet = new Set(fileRoles);

export const cleanupOwners = Object.freeze([
    'fixture-receipt.owned-namespace',
    'fixture-receipt.owned-entities',
    'fixture-receipt.owned-keys',
    'fixture-receipt.owned-files'
]);
const cleanupOwnerSet = new Set(cleanupOwners);

// Every required parent-ticket mutation surface must be covered by at least one
// envelope semantic domain. Unknown or uncovered surfaces fail closed.
export const requiredSurfaceDomains = Object.freeze([
    'admin.disabled',
    'admin.permission',
    'article.metadata',
    'article.tags',
    'article.views',
    'comment.moderation',
    'media',
    'public.home',
    'public.projection',
    'redis.cache',
    'security.risk',
    'session.expiry',
    'user.mfa'
]);

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const stableIdPattern = /^[a-z][a-z0-9_.-]*$/u;
const forbiddenFixedTargetFields = new Set(['id', 'rowId', 'rowNumber', 'firstRow', 'title', 'handle']);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

export function envelopeContentDigest(envelope)
{
    const content = { ...(envelope ?? {}) };
    delete content.contentDigest;
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function catalogContentDigest(catalog)
{
    const content = { ...(catalog ?? {}) };
    delete content.contentDigest;
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

function sortedUnique(values, label, { allowEmpty = false } = {})
{
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
        || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
    }
    if (new Set(values).size !== values.length
        || JSON.stringify(values) !== JSON.stringify([...values].sort()))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return values;
}

function providerUsedBySurface(provider, surface)
{
    if (['postgresql', 'mysql', 'sqlite'].includes(provider))
    {
        return (surface.entities ?? []).length > 0;
    }
    if (provider === 'redis')
    {
        return (surface.redisKeys ?? []).length > 0 || (surface.cacheEntries ?? []).length > 0;
    }
    if (provider === 'filesystem')
    {
        return (surface.ownedFiles ?? []).length > 0;
    }
    return false;
}

function targetSignature(target, kind)
{
    if (kind === 'entities')
    {
        return `entity:${target.domain}:${target.kind}:${[...(target.fields ?? [])].sort().join(',')}`;
    }
    if (kind === 'redisKeys')
    {
        return `redis:${target.domain}:${target.keyRole}`;
    }
    if (kind === 'cacheEntries')
    {
        return `cache:${target.domain}:${target.generationRole}`;
    }
    return `file:${target.domain}:${target.role}`;
}

function validateSurface(surface, label, { domains, kinds, roles, allowEmpty = false })
{
    const errors = [];
    if (!surface || typeof surface !== 'object' || Array.isArray(surface))
    {
        return [`${label} must be a target surface object`];
    }
    for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
    {
        const items = surface[kind] ?? [];
        if (!Array.isArray(items))
        {
            errors.push(`${label}.${kind} must be an array`);
            continue;
        }
        if (!allowEmpty && items.length === 0)
        {
            errors.push(`${label}.${kind} must not be empty`);
        }
        const signatures = [];
        for (const [index, target] of items.entries())
        {
            const targetLabel = `${label}.${kind}[${index}]`;
            if (!target || typeof target !== 'object' || Array.isArray(target))
            {
                errors.push(`${targetLabel} must be an object`);
                continue;
            }
            if (typeof target.domain !== 'string' || !stableIdPattern.test(target.domain))
            {
                errors.push(`${targetLabel}.domain must be a stable semantic domain`);
            }
            else if (domains && !domains.has(target.domain))
            {
                errors.push(`${targetLabel}.domain is unknown: ${target.domain}`);
            }
            if (kind === 'entities')
            {
                if (typeof target.kind !== 'string' || !entityKindSet.has(target.kind))
                {
                    errors.push(`${targetLabel}.kind is unknown: ${target?.kind ?? 'missing'}`);
                }
                if (!Array.isArray(target.fields) || target.fields.length === 0
                    || target.fields.some((field) => typeof field !== 'string' || !stableIdPattern.test(field)))
                {
                    errors.push(`${targetLabel}.fields must be non-empty stable semantic fields`);
                }
                for (const field of target.fields ?? [])
                {
                    if (forbiddenFixedTargetFields.has(field))
                    {
                        errors.push(`${targetLabel} must not target fixed identity field ${field}`);
                    }
                }
            }
            else if (kind === 'redisKeys')
            {
                if (typeof target.keyRole !== 'string' || !stableIdPattern.test(target.keyRole))
                {
                    errors.push(`${targetLabel}.keyRole must be a stable key role without wildcards`);
                }
            }
            else if (kind === 'cacheEntries')
            {
                if (typeof target.generationRole !== 'string'
                    || !stableIdPattern.test(target.generationRole))
                {
                    errors.push(`${targetLabel}.generationRole must be a stable generation role`);
                }
            }
            else if (kind === 'ownedFiles')
            {
                if (typeof target.role !== 'string' || !roles || !roles.has(target.role))
                {
                    errors.push(`${targetLabel}.role must be a closed owned-file role`);
                }
            }
            const signature = targetSignature(target, kind);
            if (signatures.includes(signature))
            {
                errors.push(`${label}.${kind} contains duplicate target ${signature}`);
            }
            signatures.push(signature);
        }
    }
    return errors;
}

function assertNoActionKeys(value, label, errors)
{
    if (!value || typeof value !== 'object')
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        if (/^(actions|commands|command|restart|rebootstrap|cleanupAction|script|sql)$/iu.test(key)
            || /path/iu.test(key))
        {
            errors.push(`${label} must not declare ${key} action`);
        }
        if (child && typeof child === 'object')
        {
            assertNoActionKeys(child, `${label}.${key}`, errors);
        }
    }
}

function validateEnvelope(envelope, index, {
    profileIds,
    capabilityIds,
    domainSet,
    envelopeSet
})
{
    const label = `envelopes[${index}]`;
    const errors = [];
    if (typeof envelope?.envelopeId !== 'string'
        || !/^[a-z][a-z0-9/_-]*$/u.test(envelope.envelopeId))
    {
        errors.push(`${label}.envelopeId must be a stable envelope ID`);
    }
    if (envelope?.version !== 1)
    {
        errors.push(`${label}.version must be 1`);
    }
    try
    {
        sortedUnique(envelope?.targetProfileIds, `${label}.targetProfileIds`);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    for (const profileId of envelope?.targetProfileIds ?? [])
    {
        if (profileId === 'none')
        {
            errors.push(`${label} must not target the none profile`);
        }
        else if (!profileIds.has(profileId))
        {
            errors.push(`${label} references unknown fixture profile ${profileId}`);
        }
    }
    try
    {
        sortedUnique(envelope?.targetCapabilities, `${label}.targetCapabilities`);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    for (const capabilityId of envelope?.targetCapabilities ?? [])
    {
        if (!capabilityIds.has(capabilityId))
        {
            errors.push(`${label} references unknown profile capability ${capabilityId}`);
        }
    }

    errors.push(...validateSurface(envelope?.semanticTargets, `${label}.semanticTargets`, {
        domains: domainSet,
        roles: fileRoleSet,
        allowEmpty: true
    }));
    const anyTargets = ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles']
        .some((kind) => (envelope?.semanticTargets?.[kind] ?? []).length > 0);
    if (!anyTargets)
    {
        errors.push(`${label}.semanticTargets must declare at least one owned semantic target`);
    }

    if (typeof envelope?.mutationKind !== 'string' || !mutationKindSet.has(envelope.mutationKind))
    {
        errors.push(`${label}.mutationKind is unsupported: ${envelope?.mutationKind ?? 'missing'}`);
    }
    const surface = envelope?.semanticTargets ?? {};
    const kind = envelope?.mutationKind;
    const hasEntities = (surface.entities ?? []).length > 0;
    const hasCache = (surface.cacheEntries ?? []).length > 0;
    const hasRedis = (surface.redisKeys ?? []).length > 0;
    const hasFiles = (surface.ownedFiles ?? []).length > 0;
    if (kind === 'delete-owned-file' || kind === 'truncate-owned-file' || kind === 'replace-owned-bytes')
    {
        if (!hasFiles)
        {
            errors.push(`${label} file mutation ${kind} requires owned file targets`);
        }
    }
    if (kind === 'delete-owned-cache-key' || kind === 'modify-owned-cache-key')
    {
        if (!hasRedis && !hasCache)
        {
            errors.push(`${label} cache mutation ${kind} requires redis/cache targets`);
        }
    }
    if (kind === 'remove-required-row/relation' || kind === 'add-extra-owned-relation')
    {
        if (!hasEntities)
        {
            errors.push(`${label} relation mutation ${kind} requires entity targets`);
        }
    }
    if (kind === 'set-wrong-value' && !hasEntities && !hasRedis && !hasCache)
    {
        errors.push(`${label} value mutation requires entity/redis/cache targets`);
    }

    const precondition = envelope?.precondition;
    if (!precondition || precondition.verifiedReceipt !== true
        || precondition.receiptSchema !== 'fsusblog.fixture-receipt.v2'
        || precondition.semanticSnapshot !== 'pre-mutation-verified')
    {
        errors.push(`${label}.precondition must require a verified fixture receipt`);
    }
    const recovery = envelope?.expectedRecovery;
    if (!recovery || recovery.source !== 'same-profile-current-producer-plan'
        || recovery.restoreTarget !== 'pre-mutation-verified-semantic-snapshot'
        || Object.keys(recovery).length !== 2)
    {
        errors.push(
            `${label}.expectedRecovery must reference the same-profile current producer plan `
            + 'and the pre-mutation verified semantic snapshot only'
        );
    }
    errors.push(...validateSurface(envelope?.expectedDriftFacts, `${label}.expectedDriftFacts`, {
        domains: domainSet,
        roles: fileRoleSet,
        allowEmpty: true
    }));
    const anyDrift = ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles']
        .some((kind) => (envelope?.expectedDriftFacts?.[kind] ?? []).length > 0);
    if (!anyDrift)
    {
        errors.push(`${label}.expectedDriftFacts must declare at least one drift fact surface`);
    }

    if (typeof envelope?.cleanupOwner !== 'string' || !cleanupOwnerSet.has(envelope.cleanupOwner))
    {
        errors.push(`${label}.cleanupOwner is not a receipt-owned cleanup owner`);
    }

    const support = envelope?.providerSupport;
    if (!support || typeof support !== 'object' || Array.isArray(support))
    {
        errors.push(`${label}.providerSupport must be declared`);
    }
    else
    {
        for (const provider of providers)
        {
            if (typeof support[provider] !== 'boolean')
            {
                errors.push(`${label}.providerSupport.${provider} must be a boolean`);
            }
        }
    }

    errors.push(...validateSurface(envelope?.allowedChanges, `${label}.allowedChanges`, {
        domains: domainSet,
        roles: fileRoleSet,
        allowEmpty: true
    }));
    errors.push(...validateSurface(envelope?.forbiddenDomains, `${label}.forbiddenDomains`, {
        domains: domainSet,
        roles: fileRoleSet,
        allowEmpty: true
    }));

    // Exact allowed/forbidden domains: allowedChanges must exactly equal the
    // semantic mutation surface, and forbiddenDomains must not intersect it.
    if (envelope?.allowedChanges && envelope?.semanticTargets)
    {
        for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
        {
            const allowed = new Set(
                (envelope.allowedChanges[kind] ?? [])
                    .map((target) => targetSignature(target, kind))
            );
            const targets = new Set(
                (envelope.semanticTargets[kind] ?? [])
                    .map((target) => targetSignature(target, kind))
            );
            if (JSON.stringify([...allowed].sort()) !== JSON.stringify([...targets].sort()))
            {
                errors.push(
                    `${label}.allowedChanges must exactly equal semanticTargets (${kind})`
                );
            }
        }
        const forbidden = new Set();
        for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
        {
            for (const target of envelope.forbiddenDomains?.[kind] ?? [])
            {
                forbidden.add(targetSignature(target, kind));
            }
            for (const target of envelope.semanticTargets[kind] ?? [])
            {
                if (forbidden.has(targetSignature(target, kind)))
                {
                    errors.push(`${label} semantic target is both allowed and forbidden`);
                }
            }
        }
    }

    if (!digestPattern.test(String(envelope?.contentDigest ?? '')))
    {
        errors.push(`${label}.contentDigest must be a SHA-256 digest`);
    }
    else if (envelopeContentDigest(envelope) !== envelope.contentDigest)
    {
        errors.push(`${label} contentDigest does not match its canonical envelope content`);
    }

    assertNoActionKeys(envelope, label, errors);
    return errors;
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
    if (schema?.$ref)
    {
        const target = resolveSchemaReference(schemaRoot, schema.$ref);
        return target
            ? validateJsonSchemaValue(schemaRoot, target, value, location)
            : [`${location} has unresolved schema ref ${schema.$ref}`];
    }
    const errors = [];
    if (schema?.const !== undefined
        && JSON.stringify(value) !== JSON.stringify(schema.const))
    {
        errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema?.enum)
        && !schema.enum.some((candidate) =>
            JSON.stringify(candidate) === JSON.stringify(value)))
    {
        errors.push(`${location} has invalid enum value ${JSON.stringify(value)}`);
    }
    if (schema?.type === 'object')
    {
        if (!value || typeof value !== 'object' || Array.isArray(value))
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
                errors.push(...validateJsonSchemaValue(
                    schemaRoot, childSchema, value[key], `${location}.${key}`
                ));
            }
        }
    }
    else if (schema?.type === 'array')
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
            && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
        {
            errors.push(`${location} must contain unique items`);
        }
        for (const [index, item] of value.entries())
        {
            errors.push(...validateJsonSchemaValue(
                schemaRoot, schema.items ?? {}, item, `${location}[${index}]`
            ));
        }
    }
    else if (schema?.type === 'string')
    {
        if (typeof value !== 'string')
        {
            return [`${location} must be a string`];
        }
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
        {
            errors.push(`${location} does not match ${schema.pattern}`);
        }
    }
    else if (schema?.type === 'boolean' && typeof value !== 'boolean')
    {
        errors.push(`${location} must be a boolean`);
    }
    else if (schema?.type === 'integer' && !Number.isInteger(value))
    {
        errors.push(`${location} must be an integer`);
    }
    return errors;
}

export function validateMutationEnvelopeCatalogSchema(
    catalog = loadCanonicalMutationEnvelopeCatalog(),
    schemaFile = path.resolve(root, mutationEnvelopeCatalogSchemaPath)
)
{
    const errors = [];
    let schema;
    try
    {
        schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    }
    catch (error)
    {
        return [`mutation envelope catalog schema is unreadable: ${error.message}`];
    }
    if (schema.$id !== mutationEnvelopeCatalogSchema)
    {
        errors.push('mutation envelope catalog schema identity is invalid');
    }
    if (schema.additionalProperties !== false)
    {
        errors.push('mutation envelope catalog schema root must reject additional properties');
    }
    errors.push(...validateJsonSchemaValue(schema, schema, catalog)
        .map((error) => `mutation envelope catalog schema: ${error}`));
    return errors;
}

export function validateMutationEnvelopeCatalog(
    catalog,
    {
        catalogs = readFixtureCatalogs(),
        profileCatalogDigest = null
    } = {}
)
{
    const errors = [];
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog))
    {
        return ['mutation envelope catalog must be an object'];
    }

    errors.push(...validateMutationEnvelopeCatalogSchema(catalog));
    if (catalog.schema !== mutationEnvelopeCatalogSchema)
    {
        errors.push(`mutation envelope catalog must use ${mutationEnvelopeCatalogSchema}`);
    }
    if (catalog.version !== 1)
    {
        errors.push('mutation envelope catalog version must be 1');
    }
    if (catalog.destructiveScope !== 'fixture-namespace')
    {
        errors.push('mutation envelope catalog destructiveScope must be fixture-namespace');
    }
    if (catalog.contentDigest !== catalogContentDigest(catalog))
    {
        errors.push('mutation envelope catalog contentDigest is stale or tampered');
    }
    const expectedProfileDigest = fixtureCatalogDigest(catalogs);
    if (catalog.profileCatalogDigest !== expectedProfileDigest)
    {
        errors.push('mutation envelope catalog profileCatalogDigest is stale; fixture catalogs changed');
    }
    if (profileCatalogDigest !== null && profileCatalogDigest !== catalog.profileCatalogDigest)
    {
        errors.push('mutation envelope catalog producer-plan digest does not match the bound plan');
    }
    if (JSON.stringify(catalog.mutationKinds) !== JSON.stringify(mutationKinds))
    {
        errors.push('mutation envelope catalog mutationKinds must be the closed canonical set');
    }
    if (JSON.stringify(catalog.providers) !== JSON.stringify(providers))
    {
        errors.push('mutation envelope catalog providers must be the closed provider set');
    }
    if (Object.hasOwn(catalog, 'mutations'))
    {
        errors.push('mutation envelope catalog must not contain a second mutation list');
    }

    const domainSet = new Set(catalog.semanticDomains ?? []);
    if (domainSet.size === 0)
    {
        errors.push('mutation envelope catalog must declare closed semantic domains');
    }
    const profileIds = new Set((catalogs.profile.profiles ?? []).map((profile) => profile.id));
    const capabilityIds = new Set(
        (catalogs.capability.capabilities ?? []).map((capability) => capability.id)
    );
    const envelopeIds = new Set();
    const envelopeSignatures = new Map();
    if (!Array.isArray(catalog.envelopes) || catalog.envelopes.length === 0)
    {
        errors.push('mutation envelope catalog must declare envelopes');
        return errors;
    }
    for (const [index, envelope] of catalog.envelopes.entries())
    {
        errors.push(...validateEnvelope(envelope, index, {
            profileIds,
            capabilityIds,
            domainSet,
            envelopeIds
        }));
        if (typeof envelope?.envelopeId === 'string')
        {
            if (envelopeIds.has(envelope.envelopeId))
            {
                errors.push(`duplicate envelope id ${envelope.envelopeId}`);
            }
            envelopeIds.add(envelope.envelopeId);
        }
        for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
        {
            for (const target of envelope?.semanticTargets?.[kind] ?? [])
            {
                const signature = targetSignature(target, kind);
                if (envelopeSignatures.has(signature)
                    && envelopeSignatures.get(signature) !== envelope.envelopeId)
                {
                    errors.push(
                        `overlapping semantic target ${signature} owned by `
                        + `${envelopeSignatures.get(signature)} and ${envelope.envelopeId}`
                    );
                }
                else
                {
                    envelopeSignatures.set(signature, envelope.envelopeId);
                }
            }
        }
    }

    // Required parent-ticket mutation surface coverage.
    const coveredDomains = new Set();
    for (const envelope of catalog.envelopes ?? [])
    {
        for (const kind of ['entities', 'redisKeys', 'cacheEntries', 'ownedFiles'])
        {
            for (const target of envelope.semanticTargets?.[kind] ?? [])
            {
                coveredDomains.add(target.domain);
            }
        }
    }
    for (const domain of requiredSurfaceDomains)
    {
        if (!coveredDomains.has(domain))
        {
            errors.push(`required mutation surface domain is uncovered: ${domain}`);
        }
    }

    // Sequence completeness: every envelope referenced exactly once, no unknown
    // references, cross-recovery combinations with exact envelope sets.
    const sequenceIds = new Set();
    const referencedEnvelopes = new Map();
    if (!Array.isArray(catalog.sequences) || catalog.sequences.length < 5)
    {
        errors.push('mutation envelope catalog must declare at least five profile sequences');
        return errors;
    }
    for (const [index, sequence] of catalog.sequences.entries())
    {
        const label = `sequences[${index}]`;
        if (typeof sequence?.sequenceId !== 'string' || sequenceIds.has(sequence.sequenceId))
        {
            errors.push(`${label}.sequenceId must be unique`);
        }
        if (sequence?.sequenceId)
        {
            sequenceIds.add(sequence.sequenceId);
        }
        try
        {
            sortedUnique(sequence?.targetProfileIds, `${label}.targetProfileIds`);
        }
        catch (error)
        {
            errors.push(error.message);
        }
        if ((sequence?.targetProfileIds ?? []).length < 2)
        {
            errors.push(`${label} must combine at least two profiles for cross-recovery`);
        }
        try
        {
            sortedUnique(sequence?.envelopeIds, `${label}.envelopeIds`);
        }
        catch (error)
        {
            errors.push(error.message);
        }
        if ((sequence?.envelopeIds ?? []).length < 2)
        {
            errors.push(`${label} must reference at least two envelopes`);
        }
        for (const profileId of sequence?.targetProfileIds ?? [])
        {
            if (!profileIds.has(profileId))
            {
                errors.push(`${label} references unknown profile ${profileId}`);
            }
        }
        for (const envelopeId of sequence?.envelopeIds ?? [])
        {
            if (!envelopeIds.has(envelopeId))
            {
                errors.push(`${label} references unknown envelope ${envelopeId}`);
            }
            if (referencedEnvelopes.has(envelopeId))
            {
                errors.push(`envelope ${envelopeId} is referenced by multiple sequences`);
            }
            referencedEnvelopes.set(envelopeId, sequence.sequenceId);
        }
        const sequenceEnvelopes = (catalog.envelopes ?? [])
            .filter((envelope) => (sequence?.envelopeIds ?? []).includes(envelope.envelopeId));
        const support = sequence?.providerSupport;
        if (!support || typeof support !== 'object' || Array.isArray(support))
        {
            errors.push(`${label}.providerSupport must be declared`);
            continue;
        }
        for (const provider of providers)
        {
            const mode = support[provider];
            const used = sequenceEnvelopes.some((envelope) =>
                providerUsedBySurface(provider, envelope?.semanticTargets ?? {}));
            const allSupported = sequenceEnvelopes.every((envelope) =>
                envelope?.providerSupport?.[provider] === true);
            if (!['supported', 'fail-closed', 'unsupported'].includes(mode))
            {
                errors.push(`${label}.providerSupport.${provider} must be supported/fail-closed/unsupported`);
                continue;
            }
            if (mode === 'supported' && !allSupported)
            {
                errors.push(
                    `${label} declares ${provider} supported but an envelope does not support it`
                );
            }
            if (mode === 'fail-closed')
            {
                if (!used)
                {
                    errors.push(`${label} declares ${provider} fail-closed but never uses it`);
                }
                if (sequence.qualificationEligible !== false)
                {
                    errors.push(`${label} fail-closed provider ${provider} must not qualify`);
                }
            }
            if (mode === 'unsupported' && used)
            {
                errors.push(
                    `${label} requires ${provider} but marks it unsupported; declare fail-closed`
                );
            }
        }
    }
    for (const envelope of catalog.envelopes ?? [])
    {
        if (!referencedEnvelopes.has(envelope.envelopeId))
        {
            errors.push(`envelope ${envelope.envelopeId} is not referenced by any sequence`);
        }
    }
    return errors;
}

export function loadCanonicalMutationEnvelopeCatalog()
{
    return JSON.parse(fs.readFileSync(
        path.resolve(root, canonicalMutationEnvelopeCatalogPath),
        'utf8'
    ));
}

export function checkMutationEnvelopeCatalog(catalog = loadCanonicalMutationEnvelopeCatalog())
{
    const errors = validateMutationEnvelopeCatalog(catalog);
    if (errors.length > 0)
    {
        throw new Error(`mutation envelope catalog is invalid:\n${errors.join('\n')}`);
    }
    return catalog.envelopes;
}

function main()
{
    const mode = process.argv[2] ?? '--check';
    if (mode !== '--check' || process.argv.length > 3)
    {
        throw new Error('usage: node tools/test-fixtures/mutation-envelope-catalog.mjs --check');
    }
    const envelopes = checkMutationEnvelopeCatalog();
    const catalog = loadCanonicalMutationEnvelopeCatalog();
    console.log(
        `[mutation-envelope-catalog] ok (${envelopes.length} envelopes, `
        + `${catalog.sequences.length} sequences, digest ${catalog.contentDigest})`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
