import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { observationAuthoritySourcePaths } from '../../contracts/lib/config-error-security-observation.mjs';
import { digestValue } from '../lib/canonicalize.mjs';

const observationRelative = '.tmp/contracts/config-error-security/config-error-security-policy-observation.json';
const buildReceiptRelative = '.tmp/contracts/config-error-security/build-receipt.json';
const expectedArtifactId = 'config-error-security-policy-observation';
const expectedSchema = 'fsusblog.config-error-security-policy-observation.v2';
const expectedDomainErrorSchema = 'fsusblog.domain-error-catalog.v1';
const expectedChallengeWindowSchema = 'fsusblog.security-challenge-verification-window.v1';

const requiredFactKeys = Object.freeze([
    'configuration.keys',
    'configuration.defaults',
    'configuration.allowed-values',
    'configuration.required-production-values',
    'error-codes.public',
    'error-codes.status-mapping-keys',
    'error-codes.transport-mapping',
    'error-codes.domain',
    'security.challenge-kinds',
    'security.challenge-retired-kinds',
    'security.challenge-verification-window',
    'security.rate-limit-policies',
    'security.cache-policy-classes',
    'security.fail-open-closed-modes',
    'security.numeric-boundaries'
]);

function failResult(reasons)
{
    return {
        status: 'failed',
        failureReasons: reasons.map(String),
        observations: {}
    };
}

function exactKeys(value, keys)
{
    return value != null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validateExactBuildReceipt(repositoryRoot, suppliedIdentity)
{
    const receiptPath = path.join(repositoryRoot, buildReceiptRelative);
    if (!existsSync(receiptPath))
    {
        return { failureReasons: [`missing canonical config/error build receipt ${buildReceiptRelative}`], receipt: null };
    }

    let receipt;
    try
    {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    }
    catch (error)
    {
        return {
            failureReasons: [`canonical config/error build receipt JSON parse failed: ${error instanceof Error ? error.message : String(error)}`],
            receipt: null
        };
    }

    const receiptKeys = [
        'schema',
        'artifactId',
        'observationPath',
        'observationDigest',
        'artifactDigest',
        'sourceDigests',
        'sourceDigest',
        'configuration',
        'buildIdentity'
    ];
    const embeddedIdentityKeys = [
        'artifactId',
        'receiptDigest',
        'artifactDigest',
        'sourceDigests',
        'sourceDigest'
    ];
    const failureReasons = [];
    if (
        !exactKeys(receipt, receiptKeys)
        || receipt.schema !== 'fsusblog.config-error-security-observation-build-receipt.v1'
        || receipt.artifactId !== expectedArtifactId
        || receipt.observationPath !== observationRelative
        || !['Debug', 'Release'].includes(receipt.configuration)
        || !exactKeys(receipt.buildIdentity, embeddedIdentityKeys)
        || !exactKeys(receipt.sourceDigests, observationAuthoritySourcePaths)
    )
    {
        failureReasons.push('canonical config/error build receipt shape/path/source set is invalid');
        return { failureReasons, receipt };
    }

    const { buildIdentity: embeddedIdentity, ...receiptBody } = receipt;
    const actualReceiptDigest = digestValue(receiptBody);
    if (embeddedIdentity.receiptDigest !== actualReceiptDigest)
    {
        failureReasons.push('canonical config/error build receipt self-digest mismatch');
    }
    for (const key of embeddedIdentityKeys.filter((key) => key !== 'receiptDigest'))
    {
        if (JSON.stringify(embeddedIdentity[key]) !== JSON.stringify(receipt[key]))
        {
            failureReasons.push(`config/error build receipt embedded ${key} mismatch`);
        }
    }
    if (
        !exactKeys(suppliedIdentity, ['artifactId', 'receiptDigest', 'artifactDigest'])
        || suppliedIdentity.artifactId !== embeddedIdentity.artifactId
        || suppliedIdentity.receiptDigest !== embeddedIdentity.receiptDigest
        || suppliedIdentity.artifactDigest !== embeddedIdentity.artifactDigest
    )
    {
        failureReasons.push('supplied buildIdentity does not identify the canonical config/error build receipt');
    }

    const actualSourceDigests = Object.fromEntries(observationAuthoritySourcePaths.map((relative) => [
        relative,
        existsSync(path.join(repositoryRoot, relative))
            ? createHash('sha256').update(readFileSync(path.join(repositoryRoot, relative))).digest('hex')
            : null
    ]));
    for (const relative of observationAuthoritySourcePaths)
    {
        if (actualSourceDigests[relative] == null)
        {
            failureReasons.push(`build receipt source missing: ${relative}`);
        }
        else if (receipt.sourceDigests[relative] !== actualSourceDigests[relative])
        {
            failureReasons.push(`build receipt source digest mismatch: ${relative}`);
        }
    }
    if (receipt.sourceDigest !== digestValue(actualSourceDigests))
    {
        failureReasons.push('config/error build receipt aggregate source digest mismatch');
    }
    return { failureReasons, receipt };
}

function isSortedUniqueStrings(values)
{
    if (!Array.isArray(values) || values.length === 0)
    {
        return false;
    }
    if (values.some((value) => typeof value !== 'string' || value.length === 0))
    {
        return false;
    }
    if (new Set(values).size !== values.length)
    {
        return false;
    }
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sorted.every((value, index) => value === values[index]);
}

function isBoundary(value)
{
    return value != null
    && typeof value === 'object'
    && typeof value.value === 'number'
    && Number.isFinite(value.value)
    && typeof value.unit === 'string'
    && value.unit.length > 0
    && typeof value.inclusiveMin === 'boolean'
    && typeof value.inclusiveMax === 'boolean'
    && typeof value.bound === 'string';
}

function isRangeBoundary(value)
{
    return value != null
    && typeof value === 'object'
    && typeof value.min === 'number'
    && typeof value.max === 'number'
    && typeof value.unit === 'string'
    && value.unit.length > 0
    && typeof value.inclusiveMin === 'boolean'
    && typeof value.inclusiveMax === 'boolean'
    && typeof value.bound === 'string';
}

function validateDomainErrors(domainErrors, transport, failureReasons)
{
    if (domainErrors?.schema !== expectedDomainErrorSchema || domainErrors?.version !== 1 || domainErrors?.closed !== true)
    {
        failureReasons.push(`error-codes.domain must be closed ${expectedDomainErrorSchema}`);
        return;
    }
    for (const partition of ['active', 'retired', 'migrationOnly'])
    {
        if (domainErrors[partition] == null || typeof domainErrors[partition] !== 'object' || Array.isArray(domainErrors[partition]))
        {
            failureReasons.push(`error-codes.domain.${partition} must be a typed map`);
        }
    }
    if (domainErrors.active == null || typeof domainErrors.active !== 'object')
    {
        return;
    }

    const requiredDomains = new Set(['auth', 'session', 'passkey', 'mfa', 'recovery', 'step-up', 'pow', 'security-challenge']);
    const identities = new Set();
    for (const [identity, entry] of Object.entries(domainErrors.active))
    {
        if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}$/u.test(identity)
      || /(?:compat|alias|current-equivalent|manual)/iu.test(identity))
        {
            failureReasons.push(`invalid or compatibility domain error identity ${identity}`);
            continue;
        }
        if (identities.has(identity))
        {
            failureReasons.push(`duplicate domain error identity ${identity}`);
        }
        identities.add(identity);
        if (entry?.stableCode !== identity)
        {
            failureReasons.push(`${identity} stableCode mismatch`);
        }
        requiredDomains.delete(entry?.domain);
        for (const key of ['domain', 'operation', 'condition', 'retryability', 'failMode', 'sourceOwner', 'sourceRange'])
        {
            if (typeof entry?.[key] !== 'string' || entry[key].length === 0)
            {
                failureReasons.push(`${identity} missing ${key}`);
            }
        }
        if (entry?.status !== 'active')
        {
            failureReasons.push(`${identity} active partition entry must have status=active`);
        }
        if (entry?.message != null || entry?.messageText != null)
        {
            failureReasons.push(`${identity} must not use message text as identity`);
        }
        if (!['fail-open', 'fail-closed'].includes(entry?.failMode))
        {
            failureReasons.push(`${identity} has invalid failMode`);
        }
        if (!isSortedUniqueStrings(entry?.proofTests))
        {
            failureReasons.push(`${identity} missing proofTests`);
        }
        const mapping = entry?.transport;
        if (mapping == null || typeof mapping !== 'object'
      || !Number.isInteger(mapping.httpStatus)
      || mapping.aedsFrame !== 'Error'
      || typeof mapping.aedsErrorCode !== 'string')
        {
            failureReasons.push(`${identity} has unknown or unmapped transport`);
            continue;
        }
        const canonical = Object.values(transport ?? {}).find((candidate) =>
            candidate?.mappingKind === 'error-code-default-status'
            && candidate?.errorCode === mapping.aedsErrorCode);
        if (canonical == null || canonical.httpStatus !== mapping.httpStatus)
        {
            failureReasons.push(`${identity} transport mapping conflicts with production ErrorCode policy`);
        }
    }
    for (const domain of requiredDomains)
    {
        failureReasons.push(`error-codes.domain missing active ${domain} coverage`);
    }

    for (const partition of ['retired', 'migrationOnly'])
    {
        for (const [identity, entry] of Object.entries(domainErrors[partition] ?? {}))
        {
            const expectedStatus = partition === 'retired' ? 'retired' : 'migration-only';
            if (entry?.status !== expectedStatus)
            {
                failureReasons.push(`${identity} ${partition} status mismatch`);
            }
            if (Object.hasOwn(domainErrors.active, identity))
            {
                failureReasons.push(`${identity} must not be both active and ${partition}`);
            }
        }
    }
}

function validateTransportMappings(transport, statusMappingKeys, publicCodes, failureReasons)
{
  if (transport == null || typeof transport !== 'object' || Array.isArray(transport) || Object.keys(transport).length === 0)
  {
    failureReasons.push('error-codes.transport-mapping must be a non-empty map')
    return
  }

  const expectedKeys = ['defaultMessage', 'direction', 'errorCode', 'httpStatus', 'mappingId', 'mappingKind']
  const mappingIds = new Set()
  const typedTuples = new Set()
  const genericStatuses = new Set()
  const reverseCodes = new Set()
  const mappingStatuses = new Set()
  let operationMappingCount = 0
  for (const [identity, mapping] of Object.entries(transport))
  {
    if (mapping == null || typeof mapping !== 'object' || Array.isArray(mapping)
      || JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify(expectedKeys))
    {
      failureReasons.push(`error-codes.transport-mapping.${identity} must be an exact typed mapping`)
      continue
    }
    if (mapping.mappingId !== identity
      || !/^(?:Generic|Default|Operation)[1-5][0-9]{2}[A-Z][A-Za-z]+$/u.test(mapping.mappingId))
    {
      failureReasons.push(`transport mapping ${identity} must use its exact stable mappingId`)
    }
    if (mappingIds.has(mapping.mappingId)) failureReasons.push(`duplicate transport mapping ID ${mapping.mappingId}`)
    mappingIds.add(mapping.mappingId)
    if (!Number.isInteger(mapping.httpStatus) || mapping.httpStatus < 400 || mapping.httpStatus > 599
      || typeof mapping.errorCode !== 'string' || !publicCodes?.includes(mapping.errorCode)
      || typeof mapping.defaultMessage !== 'string' || mapping.defaultMessage.trim().length === 0)
    {
      failureReasons.push(`error-codes.transport-mapping.${identity} has invalid status, ErrorCode or default message`)
      continue
    }
    const typedTuple = `${mapping.mappingKind}\u0000${mapping.httpStatus}\u0000${mapping.errorCode}`
    mappingStatuses.add(mapping.httpStatus)
    if (typedTuples.has(typedTuple)) failureReasons.push(`duplicate typed transport tuple ${typedTuple}`)
    typedTuples.add(typedTuple)

    if (mapping.direction === 'status-to-error-code')
    {
      if (mapping.mappingKind !== 'generic-status-default')
      {
        failureReasons.push(`status mapping ${identity} must be classified as generic-status-default`)
      }
      if (genericStatuses.has(mapping.httpStatus))
      {
        failureReasons.push(`duplicate generic status mapping ${mapping.httpStatus}`)
      }
      genericStatuses.add(mapping.httpStatus)
      continue
    }

    if (mapping.direction === 'error-code-to-status')
    {
      if (mapping.mappingKind !== 'error-code-default-status')
      {
        failureReasons.push(`ErrorCode mapping ${identity} must be classified as error-code-default-status`)
      }
      if (reverseCodes.has(mapping.errorCode))
      {
        failureReasons.push(`duplicate ErrorCode reverse mapping ${mapping.errorCode}`)
      }
      reverseCodes.add(mapping.errorCode)
      continue
    }

    if (mapping.direction === 'operation-status-pair')
    {
      if (mapping.mappingKind !== 'operation-status-pair')
      {
        failureReasons.push(`operation mapping ${identity} must be classified as operation-status-pair`)
      }
      operationMappingCount += 1
      continue
    }

    failureReasons.push(`error-codes.transport-mapping.${identity} has invalid direction`)
  }

  if (genericStatuses.size === 0)
  {
    failureReasons.push('error-codes.transport-mapping requires explicit status mappings')
  }

  if (!Array.isArray(statusMappingKeys) || statusMappingKeys.length === 0
    || statusMappingKeys.some((status) => !Number.isInteger(status) || status < 400 || status > 599))
  {
    failureReasons.push('error-codes.status-mapping-keys must be a non-empty HTTP error status set')
  }
  else
  {
    for (let index = 1; index < statusMappingKeys.length; index += 1)
    {
      if (statusMappingKeys[index] <= statusMappingKeys[index - 1])
      {
        failureReasons.push('error-codes.status-mapping-keys must be strictly ascending and unique')
        break
      }
    }
    const keySet = new Set(statusMappingKeys)
    for (const status of statusMappingKeys)
    {
      if (!mappingStatuses.has(status)) failureReasons.push(`status mapping key ${status} has no transport mapping`)
      if (!genericStatuses.has(status)) failureReasons.push(`status mapping key ${status} has no generic status mapping`)
    }
    for (const status of [...mappingStatuses].sort((left, right) => left - right))
    {
      if (!keySet.has(status)) failureReasons.push(`transport mapping status ${status} is missing its status mapping key`)
    }
  }
  if (operationMappingCount === 0)
  {
    failureReasons.push('error-codes.transport-mapping requires explicit operation pairs')
  }
  for (const code of publicCodes ?? [])
  {
    if (!reverseCodes.has(code))
    {
      failureReasons.push(`error-codes.transport-mapping missing ErrorCode reverse mapping ${code}`)
    }
  }

  const requiredMappings = {
    Generic500InfraFailure: ['generic-status-default', 500, 'InfraFailure'],
    Generic501InfraFailure: ['generic-status-default', 501, 'InfraFailure'],
    Default500InfraFailure: ['error-code-default-status', 500, 'InfraFailure'],
    Default500Unknown: ['error-code-default-status', 500, 'Unknown']
  }
  for (const [identity, [mappingKind, httpStatus, errorCode]] of Object.entries(requiredMappings))
  {
    const mapping = transport[identity]
    if (mapping?.mappingId !== identity
      || mapping?.mappingKind !== mappingKind
      || mapping?.httpStatus !== httpStatus
      || mapping?.errorCode !== errorCode)
    {
      failureReasons.push(`error-codes.transport-mapping missing canonical ${identity}`)
    }
  }
}

function validateChallengeVerificationWindow(window, activeKinds, failureReasons)
{
    if (window?.schema !== expectedChallengeWindowSchema || window?.version !== 1 || window?.closed !== true)
    {
        failureReasons.push(`security.challenge-verification-window must be closed ${expectedChallengeWindowSchema}`);
        return;
    }
    if (window.factId !== 'security.challenge.verify-attempt-window')
    {
        failureReasons.push('challenge verification window has wrong stable factId');
    }
    if (!['fixed-bucket', 'sliding-expiry-counter'].includes(window.windowType))
    {
        failureReasons.push('challenge verification window has unknown windowType');
    }
    if (!isBoundary(window.duration) || window.duration.value <= 0)
    {
        failureReasons.push('challenge verification window must have non-zero typed duration and boundary');
    }
    const unitMilliseconds = { milliseconds: 1, seconds: 1000, minutes: 60000, hours: 3600000 };
    const durationMilliseconds = window?.duration
        ? window.duration.value * (unitMilliseconds[window.duration.unit] ?? Number.NaN)
        : Number.NaN;
    if (!Number.isFinite(durationMilliseconds) || window.durationMilliseconds !== durationMilliseconds)
    {
        failureReasons.push('challenge verification window canonical duration mismatch');
    }
    if (!isBoundary(window.cacheExpiry) || window.cacheExpiry.value <= 0)
    {
        failureReasons.push('challenge verification cache expiry must have non-zero typed duration and boundary');
    }
    const cacheExpiryMilliseconds = window?.cacheExpiry
        ? window.cacheExpiry.value * (unitMilliseconds[window.cacheExpiry.unit] ?? Number.NaN)
        : Number.NaN;
    if (!Number.isFinite(cacheExpiryMilliseconds) || window.cacheExpiryMilliseconds !== cacheExpiryMilliseconds)
    {
        failureReasons.push('challenge verification cache expiry canonical duration mismatch');
    }
    if (window.cacheExpiryFactId !== 'security.challenge.verify-attempt-cache-expiry'
    || window.cacheExpiryFactId === window.factId)
    {
        failureReasons.push('challenge window and cache expiry require distinct stable fact IDs');
    }
    if (window.maxAttemptsFactId !== 'security.challenge.verify-max-attempts'
    || !isBoundary(window.maxAttempts)
    || window.maxAttempts.unit !== 'attempts')
    {
        failureReasons.push('challenge max attempts must be an independent typed fact');
    }
    if (window.failModeFactId !== 'security.challenge.verify-fail-mode'
    || !['fail-open', 'fail-closed'].includes(window.failMode))
    {
        failureReasons.push('challenge verification fail mode must be an independent typed fact');
    }
    if (typeof window.startsAt !== 'string' || window.startsAt.length === 0
    || typeof window.boundary !== 'string' || window.boundary.length === 0
    || typeof window.relation !== 'string' || window.relation.length === 0)
    {
        failureReasons.push('challenge verification window missing start/boundary/relation semantics');
    }
    const relation = window['window-relation'];
    if (relation?.relationId !== 'security.challenge.verify-window-distinct-from-cache-expiry'
    || relation?.subject !== window.factId
    || relation?.predicate !== 'is-distinct-from'
    || relation?.object !== window.cacheExpiryFactId
    || relation?.direction !== 'subject-to-object'
    || relation?.truthValue !== 'true'
    || typeof relation?.condition !== 'string'
    || relation.condition.length === 0)
    {
        failureReasons.push('challenge verification window/cache relation is incomplete or reversed');
    }
    if (!isSortedUniqueStrings(window.challengeKinds)
    || !Array.isArray(activeKinds)
    || window.challengeKinds.length !== activeKinds.length
    || window.challengeKinds.some((kind, index) => kind !== activeKinds[index]))
    {
        failureReasons.push('challenge verification window scope must exactly match active challenge kinds');
    }
    if (typeof window.challengeManifestVersion !== 'string' || window.challengeManifestVersion.length === 0)
    {
        failureReasons.push('challenge verification window missing challenge version scope');
    }
    if (typeof window.sourceOwner !== 'string' || typeof window.sourceRange !== 'string'
    || !isSortedUniqueStrings(window.proofTests))
    {
        failureReasons.push('challenge verification window missing source/proof binding');
    }
}

function receiptMapKey(key)
{
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key))
    {
        return key;
    }
    return `key_${Buffer.from(key, 'utf8').toString('hex')}`;
}

function toReceiptObservationValue(value)
{
    if (value === null || value === undefined)
    {
        return { state: 'null' };
    }
    if (typeof value === 'string')
    {
        return value.length > 0 ? value : { state: 'empty-string' };
    }
    if (typeof value === 'number' || typeof value === 'boolean')
    {
        return value;
    }
    if (Array.isArray(value))
    {
        if (value.length === 0)
        {
            return { count: 0 };
        }
        if (value.every((entry) =>
            (typeof entry === 'string' && entry.length > 0)
      || typeof entry === 'number'
      || typeof entry === 'boolean'))
        {
            return [...value];
        }
        return {
            count: value.length,
            items: Object.fromEntries(value.map((entry, index) => [
                `item_${String(index).padStart(4, '0')}`,
                toReceiptObservationValue(entry)
            ]))
        };
    }
    if (value != null && typeof value === 'object')
    {
        const entries = Object.entries(value);
        if (entries.length === 0)
        {
            return { state: 'empty-map' };
        }
        return Object.fromEntries(entries.map(([key, entry]) =>
        {
            const projectedKey = receiptMapKey(key);
            const projectedValue = toReceiptObservationValue(entry);
            return projectedKey === key
                ? [key, projectedValue]
                : [projectedKey, { identity: key, value: projectedValue }];
        }));
    }
    throw new Error(`unsupported configuration observation value type ${typeof value}`);
}

function parseTsConstObjectKeys(source, exportName)
{
    const match = source.match(new RegExp(`export const ${exportName} = \\{([\\s\\S]*?)\\n\\} as const`, 'u'));
    if (!match)
    {
        return null;
    }
    return [...match[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/gmu)].map((entry) => entry[1]);
}

function readOptional(repositoryRoot, relative)
{
    const absolute = path.join(repositoryRoot, relative);
    if (!existsSync(absolute))
    {
        return null;
    }
    return readFileSync(absolute, 'utf8');
}

/**
 * compiled-assembly extractor for configuration defaults, public error codes,
 * and challenge/rate/cache/security policy facts.
 * Authority is the sealed observation artifact from FsusBlog.ConfigErrorSecurityObservation.
 * Frontend sources are compared as consumer projections only — never as authority and never via handwritten alignment tables.
 */
// BEHAVIOR-OWNER: configuration-error-security-policy
export function extract(context)
{
    const buildIdentity = context.buildIdentity;
    if (buildIdentity == null || typeof buildIdentity !== 'object')
    {
        return failResult(['config-error-security-policy-fact-extractor requires exact buildIdentity']);
    }
    if (buildIdentity.artifactId !== expectedArtifactId)
    {
        return failResult([`unexpected artifactId ${buildIdentity.artifactId}`]);
    }
    if (/bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.artifactId))
    || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
    {
        return failResult(['refuses ambient bin/Debug or bin/Release observation identity']);
    }

    const canonicalIdentity = buildIdentity.schema === 'fsusblog.build-identity.v1';
    const standaloneReceiptValidation = canonicalIdentity
        ? null
        : validateExactBuildReceipt(context.repositoryRoot, buildIdentity);
    if (standaloneReceiptValidation?.failureReasons.length > 0)
    {
        return failResult(standaloneReceiptValidation.failureReasons);
    }

    const sourceDigests = canonicalIdentity
        ? buildIdentity.sourceDigests
        : standaloneReceiptValidation.receipt.sourceDigests;
    const sourceDigestMap = Array.isArray(sourceDigests)
        ? Object.fromEntries(sourceDigests.map((entry) => [entry?.path, entry?.digest]))
        : sourceDigests;
    const sourceDigestKeys = sourceDigestMap != null
        && typeof sourceDigestMap === 'object'
        && !Array.isArray(sourceDigestMap)
        ? Object.keys(sourceDigestMap).sort()
        : [];
    const expectedAuthorityPaths = [...observationAuthoritySourcePaths].sort();
    const isMinimalBuildIdentity = canonicalIdentity;
    if (
        isMinimalBuildIdentity
            ? expectedAuthorityPaths.some((relative) => !sourceDigestKeys.includes(relative))
            : JSON.stringify(sourceDigestKeys) !== JSON.stringify(expectedAuthorityPaths)
    )
    {
        return failResult(['buildIdentity.sourceDigests must exactly bind the ApiErrorSemanticMapper authority source']);
    }
    const declaredSourceDigest = canonicalIdentity
        ? buildIdentity.sourceDigest
        : standaloneReceiptValidation.receipt.sourceDigest;
    if (declaredSourceDigest !== digestValue(sourceDigests))
    {
        return failResult(['buildIdentity.sourceDigest does not match sourceDigests']);
    }
    for (const relative of observationAuthoritySourcePaths)
    {
        const sourcePath = path.join(context.repositoryRoot, relative);
        if (!existsSync(sourcePath))
        {
            return failResult([`missing authority source ${relative}`]);
        }
        const actualDigest = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
        if (sourceDigestMap[relative] !== actualDigest)
        {
            return failResult([`authority source digest mismatch for ${relative}`]);
        }
    }

    const absolute = path.join(context.repositoryRoot, observationRelative);
    if (!existsSync(absolute))
    {
        return failResult([`missing sealed observation artifact ${observationRelative}`]);
    }

    const bytes = readFileSync(absolute);
    const artifactDigest = createHash('sha256').update(bytes).digest('hex');
    if (artifactDigest !== buildIdentity.artifactDigest)
    {
        return failResult([
            `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildIdentity.artifactDigest}, got ${artifactDigest})`
        ]);
    }

    let observation;
    try
    {
        observation = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        return failResult([`observation JSON parse failed: ${error instanceof Error ? error.message : String(error)}`]);
    }

    if (observation?.schema !== expectedSchema)
    {
        return failResult([`observation schema is not ${expectedSchema}`]);
    }
    if (observation.source === 'checked-in-docs'
    || observation.source === 'test-fixture'
    || observation.source === 'appsettings.Development'
    || observation.source === 'example-appsettings'
    || observation.generatedFromDocs === true)
    {
        return failResult(['observation must not be reverse-generated from docs, fixtures, or example appsettings']);
    }
    if (observation.status === 'failed' || (Array.isArray(observation.failureReasons) && observation.failureReasons.length > 0))
    {
        return failResult([
            'observation host reported coherence failure',
            ...(Array.isArray(observation.failureReasons) ? observation.failureReasons.map(String) : [])
        ]);
    }

    const facts = observation.facts;
    if (facts == null || typeof facts !== 'object' || Array.isArray(facts))
    {
        return failResult(['observation.facts missing']);
    }

    const failureReasons = [];
    for (const key of requiredFactKeys)
    {
        if (!Object.hasOwn(facts, key))
        {
            failureReasons.push(`missing required fact ${key}`);
        }
    }
    if (failureReasons.length > 0)
    {
        return failResult(failureReasons);
    }

    // configuration layers
    const keys = facts['configuration.keys'];
    if (keys == null || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0)
    {
        failureReasons.push('configuration.keys must be a non-empty typed map');
    }

    const defaults = facts['configuration.defaults'];
    if (defaults == null || typeof defaults !== 'object' || Array.isArray(defaults))
    {
        failureReasons.push('configuration.defaults must be a typed map');
    }
    else
    {
        for (const [key, entry] of Object.entries(defaults))
        {
            if (entry == null || typeof entry !== 'object')
            {
                failureReasons.push(`configuration.defaults.${key} must be an object`);
                continue;
            }
            if (entry.secret === true && entry.layers)
            {
                for (const layer of Object.values(entry.layers))
                {
                    if (layer && typeof layer === 'object' && Object.hasOwn(layer, 'value') && layer.value != null && layer.value !== '')
                    {
                        failureReasons.push(`secret configuration.defaults.${key} must not materialize values`);
                    }
                }
            }
            if (entry.layers && typeof entry.layers === 'object')
            {
                if (Object.hasOwn(entry.layers, 'runtime-environment'))
                {
                    failureReasons.push(`configuration.defaults.${key} must not include runtime-environment layer`);
                }
            }
        }
    }

    const requiredProduction = facts['configuration.required-production-values'];
    if (requiredProduction == null || typeof requiredProduction !== 'object' || Array.isArray(requiredProduction))
    {
        failureReasons.push('configuration.required-production-values must be a typed map');
    }

    const allowedValues = facts['configuration.allowed-values'];
    if (allowedValues == null || typeof allowedValues !== 'object' || Array.isArray(allowedValues))
    {
        failureReasons.push('configuration.allowed-values must be a typed map');
    }

    // error codes
    const publicCodes = facts['error-codes.public'];
    if (!isSortedUniqueStrings(publicCodes))
    {
        failureReasons.push('error-codes.public must be a sorted unique string set from production catalog');
    }
    if (Array.isArray(publicCodes) && !publicCodes.includes('Validation'))
    {
        failureReasons.push('error-codes.public must include Validation');
    }

    const transport = facts['error-codes.transport-mapping'];
    const statusMappingKeys = facts['error-codes.status-mapping-keys'];
    validateTransportMappings(transport, statusMappingKeys, publicCodes, failureReasons);
    validateDomainErrors(facts['error-codes.domain'], transport, failureReasons);

    // challenges
    const challengeKinds = facts['security.challenge-kinds'];
    const activeKinds = challengeKinds?.active;
    if (!isSortedUniqueStrings(activeKinds))
    {
        failureReasons.push('security.challenge-kinds.active must be a sorted unique string set');
    }

    const retiredKinds = facts['security.challenge-retired-kinds'];
    if (!Array.isArray(retiredKinds))
    {
        failureReasons.push('security.challenge-retired-kinds must be an array');
    }
    else if (retiredKinds.length > 0 && !isSortedUniqueStrings(retiredKinds))
    {
        failureReasons.push('security.challenge-retired-kinds must be a sorted unique string set when non-empty');
    }
    if (Array.isArray(activeKinds) && Array.isArray(retiredKinds))
    {
        const retiredInActive = retiredKinds.filter((kind) => activeKinds.includes(kind));
        if (retiredInActive.length > 0)
        {
            failureReasons.push(`retired challenge kinds must not be listed active: ${retiredInActive.join(',')}`);
        }
    }
    validateChallengeVerificationWindow(facts['security.challenge-verification-window'], activeKinds, failureReasons);

    // rate limits
    const ratePolicies = facts['security.rate-limit-policies'];
    if (ratePolicies == null || typeof ratePolicies !== 'object' || Array.isArray(ratePolicies))
    {
        failureReasons.push('security.rate-limit-policies must be a map');
    }
    else
    {
        for (const required of ['fixed_ip', 'public_read', 'read_proof', 'notification_stream', 'security_challenge_verify'])
        {
            if (!Object.hasOwn(ratePolicies, required))
            {
                failureReasons.push(`security.rate-limit-policies missing ${required}`);
            }
        }
        for (const [policyId, policy] of Object.entries(ratePolicies))
        {
            if (policy?.window && !isBoundary(policy.window))
            {
                failureReasons.push(`security.rate-limit-policies.${policyId}.window must include unit and inclusive/exclusive bounds`);
            }
            if (policy?.codeDefaultPermitLimit && !isBoundary(policy.codeDefaultPermitLimit))
            {
                failureReasons.push(`security.rate-limit-policies.${policyId}.codeDefaultPermitLimit must be typed boundary`);
            }
            if (policy?.failMode !== 'fail-closed' && policy?.failMode !== 'fail-open')
            {
                failureReasons.push(`security.rate-limit-policies.${policyId}.failMode must be fail-closed or fail-open semantic id`);
            }
        }
    }

    // cache
    const cacheClasses = facts['security.cache-policy-classes'];
    if (cacheClasses == null || typeof cacheClasses !== 'object' || Array.isArray(cacheClasses) || Object.keys(cacheClasses).length === 0)
    {
        failureReasons.push('security.cache-policy-classes must be a non-empty map');
    }

    // fail modes
    const failModes = facts['security.fail-open-closed-modes'];
    if (failModes == null || typeof failModes !== 'object' || Array.isArray(failModes))
    {
        failureReasons.push('security.fail-open-closed-modes must be a map of semantic IDs');
    }
    else
    {
        for (const [modeId, mode] of Object.entries(failModes))
        {
            if (mode !== 'fail-closed' && mode !== 'fail-open')
            {
                failureReasons.push(`security.fail-open-closed-modes.${modeId} must be fail-closed or fail-open`);
            }
        }
    }

    // numeric boundaries
    const numeric = facts['security.numeric-boundaries'];
    if (numeric == null || typeof numeric !== 'object' || Array.isArray(numeric) || Object.keys(numeric).length === 0)
    {
        failureReasons.push('security.numeric-boundaries must be a non-empty map');
    }
    else
    {
        for (const [id, boundary] of Object.entries(numeric))
        {
            if (boundary && typeof boundary === 'object' && Object.hasOwn(boundary, 'min'))
            {
                if (!isRangeBoundary(boundary))
                {
                    failureReasons.push(`security.numeric-boundaries.${id} must include unit and inclusive/exclusive range bounds`);
                }
            }
            else if (boundary && typeof boundary === 'object' && Object.hasOwn(boundary, 'default'))
            {
                for (const part of ['default', 'minimum', 'maximum'])
                {
                    if (boundary[part] != null && !isBoundary(boundary[part]))
                    {
                        failureReasons.push(`security.numeric-boundaries.${id}.${part} must be typed boundary with unit`);
                    }
                }
            }
            else if (!isBoundary(boundary))
            {
                failureReasons.push(`security.numeric-boundaries.${id} must be typed boundary with unit and inclusive/exclusive semantics`);
            }
        }
    }

    // Secret leakage scan across full observation (connection strings / credentials).
    const serialized = JSON.stringify(observation);
    for (const banned of [
        'Host=',
        'Username=',
        'Password=',
        'Connection String',
        'BEGIN PRIVATE KEY',
        'postgres://',
        'redis://'
    ])
    {
        if (serialized.includes(banned))
        {
            failureReasons.push(`observation receipt must not contain secret material marker: ${banned}`);
        }
    }
    if (/Server=.*Database=/iu.test(serialized) || /AccountKey=/iu.test(serialized))
    {
        failureReasons.push('observation receipt must not contain connection-string style material');
    }

    // Frontend projection exactness (consumer only; no handwritten alignment object).
    const frontendProjection = {
        'error-codes': { status: 'skipped', missing: [], extra: [], clientLocal: [] },
        'challenge-kinds': { status: 'skipped', missing: [], extra: [] }
    };

    const appErrorSource = readOptional(context.repositoryRoot, 'src/frontend/src/utils/appError.ts');
    if (appErrorSource && Array.isArray(publicCodes))
    {
        const frontendCodes = parseTsConstObjectKeys(appErrorSource, 'AppErrorCode');
        if (!frontendCodes || frontendCodes.length === 0)
        {
            failureReasons.push('frontend AppErrorCode catalog unreadable for projection exactness');
        }
        else
        {
            const frontendSet = new Set(frontendCodes);
            const authoritySet = new Set(publicCodes);
            const missing = publicCodes.filter((code) => !frontendSet.has(code));
            // Client-local codes are those present only on the frontend surface; they are not
            // "extra authority items". Extra means frontend claiming a public wire code identity
            // that is not in authority — impossible by name equality, so we only fail on missing.
            // Bidirectional exact match for the public wire projection: every authority code is
            // present, and the projected public subset equals authority.
            const projectedPublic = frontendCodes.filter((code) => authoritySet.has(code)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            const clientLocal = frontendCodes.filter((code) => !authoritySet.has(code)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            const authoritySorted = [...publicCodes];
            const exact = missing.length === 0
        && projectedPublic.length === authoritySorted.length
        && projectedPublic.every((code, index) => code === authoritySorted[index]);
            frontendProjection['error-codes'] = {
                status: exact ? 'exact' : 'mismatch',
                missing,
                extra: [],
                clientLocal,
                projectedPublic
            };
            if (!exact)
            {
                failureReasons.push(
                    `frontend error-code projection is not exact vs authority (missing=${missing.join(',') || 'none'})`
                );
            }
        }
    }
    else if (Array.isArray(publicCodes) && publicCodes.length > 0)
    {
    // When running against a fixture root without frontend sources, projection is not available.
        frontendProjection['error-codes'] = {
            status: 'unavailable',
            missing: [...publicCodes],
            extra: [],
            clientLocal: []
        };
    }

    const binaryApiSource = readOptional(context.repositoryRoot, 'src/frontend/src/contracts/binaryApi.ts');
    if (binaryApiSource && Array.isArray(activeKinds))
    {
    // Frontend enum is numeric; wire-name projection lives in challenge-kind-wire.ts.
        const wireSource = readOptional(context.repositoryRoot, 'src/frontend/src/security/challenge-kind-wire.ts');
        const registrySource = readOptional(context.repositoryRoot, 'src/frontend/src/security/challenge-capability-registry.ts');
        if (!wireSource || !registrySource)
        {
            failureReasons.push('frontend challenge wire/registry sources unreadable for projection exactness');
        }
        else
        {
            // Derive wire names by matching return string literals in wire helper cases that map production kinds.
            const wireNames = [...wireSource.matchAll(/return\s+'([^']+)'/gu)].map((match) => match[1]);
            const uniqueWire = [...new Set(wireNames)].filter((name) => name !== 'unknown').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            const authority = [...activeKinds];
            const missing = authority.filter((kind) => !uniqueWire.includes(kind));
            const extra = uniqueWire.filter((kind) => !authority.includes(kind) && !(Array.isArray(retiredKinds) && retiredKinds.includes(kind)));
            // Retired must not appear as active projection either.
            const retiredProjectedActive = Array.isArray(retiredKinds)
                ? retiredKinds.filter((kind) => uniqueWire.includes(kind) && authority.includes(kind))
                : [];
            const exact = missing.length === 0 && extra.length === 0 && retiredProjectedActive.length === 0
        && uniqueWire.length === authority.length
        && uniqueWire.every((kind, index) => kind === authority[index]);
            frontendProjection['challenge-kinds'] = {
                status: exact ? 'exact' : 'mismatch',
                missing,
                extra,
                projected: uniqueWire
            };
            if (!exact)
            {
                failureReasons.push(
                    `frontend challenge-kind projection is not exact vs authority (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`
                );
            }
        }
    }

    if (failureReasons.length > 0)
    {
        return failResult(failureReasons);
    }

    const observationFacts = {
        'configuration.keys': facts['configuration.keys'],
        'configuration.defaults': facts['configuration.defaults'],
        'configuration.allowed-values': facts['configuration.allowed-values'],
        'configuration.required-production-values': facts['configuration.required-production-values'],
        'error-codes.public': facts['error-codes.public'],
        'error-codes.status-mapping-keys': facts['error-codes.status-mapping-keys'],
        'error-codes.transport-mapping': facts['error-codes.transport-mapping'],
        'error-codes.domain': facts['error-codes.domain'],
        'security.challenge-kinds': facts['security.challenge-kinds'],
        'security.challenge-retired-kinds': facts['security.challenge-retired-kinds'],
        'security.challenge-verification-window': facts['security.challenge-verification-window'],
        'security.rate-limit-policies': facts['security.rate-limit-policies'],
        'security.cache-policy-classes': facts['security.cache-policy-classes'],
        'security.fail-open-closed-modes': facts['security.fail-open-closed-modes'],
        'security.numeric-boundaries': facts['security.numeric-boundaries'],
        securityPolicyClaims: {
            windowCacheRelation: facts['security.challenge-verification-window']['window-relation'],
            challengeVerifyFailMode: facts['security.fail-open-closed-modes']['security-challenge-verify'],
            rateLimiterFailMode: facts['security.fail-open-closed-modes']['rate-limiter-rejection']
        },
        'frontend.projection': frontendProjection
    };
    const observations = {
        facts: toReceiptObservationValue(observationFacts),
        observationDigest: String(observation.observationDigest),
        artifactDigest,
        source: String(observation.source ?? 'compiled-production-constants')
    };

    return {
        status: 'ok',
        failureReasons: [],
        observations
    };
}
