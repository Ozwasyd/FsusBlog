import fs from 'node:fs';

import { normalizeReleaseId } from './release-assets.mjs';

export const RELEASE_COMPATIBILITY_SCHEMA = 'fsusblog.release-compatibility.v1';
export const COMPATIBILITY_MATRIX_SCHEMA = 'fsusblog.release-compatibility-matrix.v1';

export function createReleaseCompatibilityMetadata({
    releaseId,
    frontendBuildId = releaseId,
    backendProtocol = { current: 2, min: 1, max: 2 },
    aeds = { emitVersion: 2, minDecoderVersion: 2, maxDecoderVersion: 2 },
    notification = { current: 2, minClientVersion: 2, maxClientVersion: 2 },
    serviceWorkerNamespace = `fsus-static-v4:${releaseId}`,
    wasmAbi = { current: 2, minConsumerVersion: 2, maxConsumerVersion: 2 },
    assetManifestSha256 = null
})
{
    const metadata = {
        schema: RELEASE_COMPATIBILITY_SCHEMA,
        releaseId: normalizeReleaseId(releaseId),
        frontendBuildId: normalizeReleaseId(frontendBuildId),
        backendProtocol: normalizeVersionRange(backendProtocol, 'backendProtocol'),
        aeds: normalizeEmitRange(aeds, 'aeds', 'emitVersion', 'minDecoderVersion', 'maxDecoderVersion'),
        notification: normalizeEmitRange(notification, 'notification', 'current', 'minClientVersion', 'maxClientVersion'),
        serviceWorkerNamespace: normalizeNamespace(serviceWorkerNamespace),
        wasmAbi: normalizeEmitRange(wasmAbi, 'wasmAbi', 'current', 'minConsumerVersion', 'maxConsumerVersion'),
        assetManifestSha256
    };
    const errors = validateReleaseCompatibilityMetadata(metadata);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return metadata;
}

export function validateReleaseCompatibilityMetadata(metadata)
{
    const errors = [];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    {
        return ['compatibility metadata must be an object'];
    }
    if (metadata.schema !== RELEASE_COMPATIBILITY_SCHEMA)
    {
        errors.push(`schema must be ${RELEASE_COMPATIBILITY_SCHEMA}`);
    }
    try
    {
        normalizeReleaseId(metadata.releaseId);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    try
    {
        normalizeReleaseId(metadata.frontendBuildId);
    }
    catch
    {
        errors.push('frontendBuildId must be a safe immutable identifier');
    }
    validateRange(metadata.backendProtocol, 'backendProtocol', 'current', 'min', 'max', errors);
    validateRange(metadata.aeds, 'aeds', 'emitVersion', 'minDecoderVersion', 'maxDecoderVersion', errors);
    validateRange(metadata.notification, 'notification', 'current', 'minClientVersion', 'maxClientVersion', errors);
    validateRange(metadata.wasmAbi, 'wasmAbi', 'current', 'minConsumerVersion', 'maxConsumerVersion', errors);
    try
    {
        normalizeNamespace(metadata.serviceWorkerNamespace);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (metadata.assetManifestSha256 !== null
      && !/^sha256:[0-9a-f]{64}$/u.test(String(metadata.assetManifestSha256)))
    {
        errors.push('assetManifestSha256 must be null or sha256:<64 lowercase hex>');
    }
    return errors;
}

export function evaluateClientServerCompatibility(client, server)
{
    const errors = [
        ...validateReleaseCompatibilityMetadata(client).map(error => `client: ${error}`),
        ...validateReleaseCompatibilityMetadata(server).map(error => `server: ${error}`)
    ];
    if (errors.length > 0)
    {
        return { compatible: false, errors };
    }

    requireWithin(
        client.backendProtocol.current,
        server.backendProtocol.min,
        server.backendProtocol.max,
        'client backend protocol is outside server range',
        errors);
    requireWithin(
        server.backendProtocol.current,
        client.backendProtocol.min,
        client.backendProtocol.max,
        'server backend protocol is outside client range',
        errors);
    requireWithin(
        server.aeds.emitVersion,
        client.aeds.minDecoderVersion,
        client.aeds.maxDecoderVersion,
        'server AEDS frame cannot be decoded by client',
        errors);
    requireWithin(
        server.notification.current,
        client.notification.minClientVersion,
        client.notification.maxClientVersion,
        'server notification stream cannot be consumed by client',
        errors);
    requireWithin(
        server.wasmAbi.current,
        client.wasmAbi.minConsumerVersion,
        client.wasmAbi.maxConsumerVersion,
        'server-selected Wasm ABI cannot be consumed by client',
        errors);
    return { compatible: errors.length === 0, errors };
}

export function buildCompatibilityMatrix({ candidate, active, previous, retainedAssetReleaseIds = [] })
{
    const retained = new Set(retainedAssetReleaseIds.map(normalizeReleaseId));
    const scenarios = [
        pairScenario('N-to-N', candidate, candidate),
        pairScenario('N-1-client-to-N-server', active, candidate),
        pairScenario('previous-client-to-N-server', previous, candidate),
        assetScenario('old-service-worker-assets-retained', active, retained),
        decoderScenario('old-decoder-to-N-frame', previous, candidate)
    ];
    return {
        schema: COMPATIBILITY_MATRIX_SCHEMA,
        status: scenarios.every(scenario => scenario.status === 'pass') ? 'pass' : 'fail',
        candidateReleaseId: candidate.releaseId,
        scenarios,
        errors: scenarios.flatMap(scenario => scenario.errors.map(error => `${scenario.id}: ${error}`))
    };
}

export function readReleaseCompatibilityMetadata(file)
{
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validateReleaseCompatibilityMetadata(metadata);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return metadata;
}

function pairScenario(id, client, server)
{
    const result = evaluateClientServerCompatibility(client, server);
    return {
        id,
        clientReleaseId: client.releaseId,
        serverReleaseId: server.releaseId,
        status: result.compatible ? 'pass' : 'fail',
        errors: result.errors
    };
}

function assetScenario(id, serviceWorkerRelease, retained)
{
    const kept = retained.has(serviceWorkerRelease.releaseId);
    return {
        id,
        serviceWorkerReleaseId: serviceWorkerRelease.releaseId,
        serviceWorkerNamespace: serviceWorkerRelease.serviceWorkerNamespace,
        status: kept ? 'pass' : 'fail',
        errors: kept ? [] : ['old service worker release assets are not retained']
    };
}

function decoderScenario(id, decoder, server)
{
    const errors = [];
    requireWithin(
        server.aeds.emitVersion,
        decoder.aeds.minDecoderVersion,
        decoder.aeds.maxDecoderVersion,
        'old AEDS decoder cannot decode candidate frame version',
        errors);
    return {
        id,
        decoderReleaseId: decoder.releaseId,
        frameReleaseId: server.releaseId,
        status: errors.length === 0 ? 'pass' : 'fail',
        errors
    };
}

function normalizeVersionRange(value, label)
{
    return {
        current: normalizeVersion(value?.current, `${label}.current`),
        min: normalizeVersion(value?.min, `${label}.min`),
        max: normalizeVersion(value?.max, `${label}.max`)
    };
}

function normalizeEmitRange(value, label, currentKey, minKey, maxKey)
{
    return {
        [currentKey]: normalizeVersion(value?.[currentKey], `${label}.${currentKey}`),
        [minKey]: normalizeVersion(value?.[minKey], `${label}.${minKey}`),
        [maxKey]: normalizeVersion(value?.[maxKey], `${label}.${maxKey}`)
    };
}

function normalizeVersion(value, label)
{
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
    {
        throw new Error(`${label} must be an integer from 1 through 65535`);
    }
    return value;
}

function normalizeNamespace(value)
{
    const namespace = String(value ?? '');
    if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(namespace))
    {
        throw new Error('serviceWorkerNamespace must be a safe non-empty namespace');
    }
    return namespace;
}

function validateRange(value, label, currentKey, minKey, maxKey, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push(`${label} is required`);
        return;
    }
    for (const key of [currentKey, minKey, maxKey])
    {
        try
        {
            normalizeVersion(value[key], `${label}.${key}`);
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    if (Number.isSafeInteger(value[minKey]) && Number.isSafeInteger(value[maxKey]) && value[minKey] > value[maxKey])
    {
        errors.push(`${label}.${minKey} cannot exceed ${label}.${maxKey}`);
    }
    if (Number.isSafeInteger(value[currentKey])
      && Number.isSafeInteger(value[minKey])
      && Number.isSafeInteger(value[maxKey])
      && (value[currentKey] < value[minKey] || value[currentKey] > value[maxKey]))
    {
        errors.push(`${label}.${currentKey} must be within its supported range`);
    }
}

function requireWithin(value, minimum, maximum, message, errors)
{
    if (value < minimum || value > maximum)
    {
        errors.push(message);
    }
}
