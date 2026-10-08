import fs from 'node:fs';
import path from 'node:path';

const { digestJson } = await import(new URL('../perf/app-config-catalog.mjs', import.meta.url));

export { digestJson };

export const identityKeys = Object.freeze([
    'machineId', 'physicalPlanDigest', 'producerMembershipDigest',
    'capacityDigest', 'metricSchemaDigest', 'testMembershipDigest'
]);

/** Domain data checks never confer scheduler, correctness or performance authority. */
export function reject(code, evidenceRef, detail = '')
{
    const error = new Error(`${code}: ${evidenceRef}${detail ? `: ${detail}` : ''}`);
    Object.assign(error, { code, evidenceRef, detail });
    throw error;
}

export function requireCondition(condition, code, evidenceRef, detail)
{
    if (!condition)
    {
        reject(code, evidenceRef, detail);
    }
}

export function finite(value, name, minimum = 0)
{
    requireCondition(typeof value === 'number' && Number.isFinite(value) && value >= minimum,
        'invalid-number', name);
    return value;
}

export function validateIdentity(identity)
{
    requireCondition(identity && Object.keys(identity).sort().join() === [...identityKeys].sort().join(),
        'invalid-identity', 'identity');
    requireCondition(typeof identity.machineId === 'string' && identity.machineId.length > 0,
        'invalid-machine', 'identity.machineId');
    for (const key of identityKeys.filter((item) => item !== 'machineId'))
    {
        requireCondition(/^sha256:[a-f0-9]{64}$/u.test(identity[key]), 'invalid-digest', `identity.${key}`);
    }
    return structuredClone(identity);
}

export function sameIdentity(actual, expected, ref)
{
    validateIdentity(actual);
    validateIdentity(expected);
    for (const key of identityKeys)
    {
        requireCondition(actual[key] === expected[key], 'identity-drift', ref, key);
    }
}

export function exactIds(ids, ref)
{
    requireCondition(Array.isArray(ids) && ids.length > 0
        && ids.every((id) => typeof id === 'string' && id.length > 0)
        && new Set(ids).size === ids.length, 'invalid-membership', ref);
    return [...ids].sort();
}

/** Only an explicit canonical regular file below the held evidence root is read. */
export function readEvidence(root, locator)
{
    const ref = locator?.ref;
    requireCondition(typeof ref === 'string' && ref.length > 0 && !path.isAbsolute(ref)
        && ref.split(/[\\/]/u).every((part) => part && !['.', '..', 'latest'].includes(part)),
    'invalid-locator', ref ?? '<missing>');
    const canonicalRoot = fs.realpathSync(root);
    const file = path.resolve(canonicalRoot, ref);
    try
    {
        requireCondition(fs.lstatSync(file).isFile() && fs.realpathSync(file) === file,
            'invalid-evidence-file', ref);
        const document = JSON.parse(fs.readFileSync(file, 'utf8'));
        requireCondition(digestJson(document) === locator.digest, 'evidence-tamper', ref);
        return document;
    }
    catch (error)
    {
        if (error.code && error.evidenceRef)
        {
            throw error;
        }
        reject('evidence-unreadable', ref, error.code ?? error.name);
    }
}

export function seal(document)
{
    return { ...document, digest: digestJson(document) };
}

export function verifySeal(document, schema)
{
    requireCondition(document?.schema === schema && document.authority === 'DATA_ONLY',
        'invalid-schema', schema);
    const { digest, ...payload } = document;
    requireCondition(digest === digestJson(payload), 'document-tamper', schema);
    return document;
}

export function quantile(values, probability)
{
    requireCondition(values.length > 0 && probability >= 0 && probability <= 1,
        'invalid-quantile', 'history');
    const sorted = values.map((value) => finite(value, 'history')).sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

export function clamp(value, previous, fraction)
{
    return Math.min(previous * (1 + fraction), Math.max(previous * (1 - fraction), value));
}

/** Bounded confidence combines sample sufficiency with robust relative dispersion. */
export function confidence(values, minimumSamples)
{
    const median = quantile(values, 0.5);
    const deviation = quantile(values.map((value) => Math.abs(value - median)), 0.5);
    return Math.min(1, values.length / minimumSamples) / (1 + deviation / Math.max(median, 0.001));
}

/** Exclusive per-directory writers refuse stale locks rather than stealing ownership. */
export function withWriterLock(directory, operation)
{
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, '.writer-lock');
    try
    {
        fs.mkdirSync(lock);
    }
    catch (error)
    {
        reject('writer-busy', lock, error.code);
    }
    try
    {
        return operation();
    }
    finally
    {
        fs.rmdirSync(lock);
    }
}

/** Link publication never replaces an existing immutable record. */
export function writeImmutable(file, document)
{
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 4)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

export function syncDirectory(directory)
{
    const descriptor = fs.openSync(directory, 'r');
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

/** Production enrollment waits for the independently held #1944 verification bridge. */
export function requireProductionAuthority()
{
    reject('upstream-verification-unavailable', '#1944',
        'No independently verified terminal-verdict/resource binding is installed; caller flags are not authority');
}
