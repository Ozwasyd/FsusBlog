/**
 * Atomic private receipt I/O: 0600, no-follow, content digest integrity (#1710).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const { buildProducerFixtureVariantPlan } = await import(new URL('../../testing/fixture-catalog.mjs', import.meta.url));

import { assertDigest, canonicalJson, sha256Bytes, sha256Text } from './canonical.mjs';

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function resolveTarget(file)
{
    if (!file || typeof file !== 'string')
    {
        throw new Error('receipt path is required');
    }
    return path.resolve(file);
}

/**
 * Read a private regular non-symlink file. Fails closed on symlink / non-file.
 */
export function readPrivateFile(file, { expectedModeMask = 0o077, label = 'receipt' } = {})
{
    const target = resolveTarget(file);
    let lstat;
    try
    {
        lstat = fs.lstatSync(target);
    }
    catch (error)
    {
        throw new Error(`${label} is unreadable: ${error.message}`, { cause: error });
    }
    if (lstat.isSymbolicLink())
    {
        throw new Error(`${label} must not be a symlink`);
    }
    if (!lstat.isFile())
    {
        throw new Error(`${label} must be a regular file`);
    }
    // Reject world/group readable when mode bits are present (unix).
    if (process.platform !== 'win32' && (lstat.mode & expectedModeMask) !== 0)
    {
        throw new Error(`${label} must be private (mode 0600); got ${ (lstat.mode & 0o777).toString(8) }`);
    }

    const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
    try
    {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
        {
            throw new Error(`${label} must be a regular file`);
        }
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length)
        {
            const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (read <= 0)
            {
                break;
            }
            offset += read;
        }
        return { bytes: bytes.subarray(0, offset), path: target, mode: stat.mode & 0o777 };
    }
    finally
    {
        fs.closeSync(fd);
    }
}

export function readPrivateJson(file, options = {})
{
    const { bytes, path: target, mode } = readPrivateFile(file, options);
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch (error)
    {
        throw new Error(`${options.label ?? 'receipt'} is not valid JSON: ${error.message}`, { cause: error });
    }
    return { document, bytes, path: target, mode, contentDigest: sha256Bytes(bytes) };
}

/**
 * Atomic write: temp file 0600 exclusive, rename, re-open no-follow, verify bytes digest.
 * Does not follow existing symlink at destination (rename overwrites path; pre-check fails if target is symlink).
 */
export function writePrivateJson(file, document, {
    mode = 0o600,
    label = 'receipt',
    expectedContentDigest = null,
    signal = undefined
} = {})
{
    signal?.throwIfAborted();
    const target = resolveTarget(file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try
    {
        fs.chmodSync(path.dirname(target), 0o700);
    }
    catch
    { /* best-effort */ }

    if (fs.existsSync(target))
    {
        const existing = fs.lstatSync(target);
        if (existing.isSymbolicLink())
        {
            throw new Error(`${label} target must not be a symlink`);
        }
    }

    const payload = Buffer.from(`${typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`}`, 'utf8');
    const contentDigest = sha256Bytes(payload);
    if (expectedContentDigest != null)
    {
        assertDigest(expectedContentDigest, 'expectedContentDigest');
        if (expectedContentDigest !== contentDigest)
        {
            throw new Error(`${label} content digest mismatch before write`);
        }
    }

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try
    {
        fs.writeFileSync(temporary, payload, { flag: 'wx', mode });
        try
        {
            fs.chmodSync(temporary, mode);
        }
        catch
        { /* best-effort */ }
        // Refuse to rename onto a symlink race.
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
        {
            throw new Error(`${label} target became a symlink; refusing write`);
        }
        signal?.throwIfAborted();
        fs.renameSync(temporary, target);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }

    // Integrity: re-open no-follow and compare bytes.
    const verified = readPrivateFile(target, { label });
    if (sha256Bytes(verified.bytes) !== contentDigest)
    {
        throw new Error(`${label} integrity check failed after atomic write`);
    }
    signal?.throwIfAborted();
    return { path: target, contentDigest, mode: verified.mode };
}

// An invocation-local bounded outlet, not a receipt or a runtime qualification producer.
// Only explicitly selected credential-free fields can leave a port. Auth carriers are never read.
export function createFixtureArtifactOutlet(directory, { plan, consumerId, signal, protectedPaths = [] } = {})
{
    signal?.throwIfAborted();
    const execution = { runId: plan?.executionIdentity?.runId, namespace: plan?.executionIdentity?.namespace };
    const rawSource = plan?.executionIdentity?.sourceIdentity ?? plan?.executionIdentity?.source;
    const source = rawSource ? { commit: rawSource.commit, worktreeFingerprint: rawSource.worktreeFingerprint } : null;
    const serviceGeneration = plan?.executionIdentity?.handles?.serviceGeneration ?? plan?.executionIdentity?.serviceGeneration;
    const profileId = plan?.profileIdentity?.profileId;
    if (!execution?.runId || !execution.namespace || !/^[a-f0-9]{40}$/u.test(source?.commit ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(source?.worktreeFingerprint ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(serviceGeneration ?? '')
        || !plan?.profileIdentity?.profileId || !/^[a-zA-Z0-9._:-]+$/u.test(consumerId ?? ''))
    {
        throw new Error('fixture artifact outlet requires exact source/run/profile/service/consumer binding');
    }
    const target = resolveTarget(directory);
    for (let current = target; ; current = path.dirname(current))
    {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error('fixture artifact directory ancestors must not be symlinks');
        }
        if (current === path.dirname(current))
        {
            break;
        }
    }
    if (protectedPaths.some((file) =>
    {
        const reserved = path.resolve(file);
        return reserved === target || reserved.startsWith(`${target}${path.sep}`) || target.startsWith(`${reserved}${path.sep}`);
    }))
    {
        throw new Error('fixture artifact directory collides with protected output/source/carrier path');
    }
    if (fs.existsSync(target))
    {
        const stat = fs.lstatSync(target);
        if (!stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
            || fs.readdirSync(target).length !== 0)
        {
            throw new Error('fixture artifact directory must be private, owned and empty');
        }
    }
    else
    {
        fs.mkdirSync(target, { mode: 0o700 });
    }
    const directoryStat = fs.lstatSync(target);
    const records = [];
    const keys = new Set();
    const published = new Set();
    const producerIds = plan.order ?? plan.producers ?? plan.producerSpecs.map((item) => item.id);
    const slices = new Map(plan.variantPlan.byProducer.map((slice) => [slice.producerId, buildProducerFixtureVariantPlan({
        producerId: slice.producerId, variantIds: slice.variants.map((item) => item.id),
        fixtureVariantIds: plan.variantIds, fixtureVariantPlanDigest: plan.variantPlanDigest
    })]));
    const maxRecords = producerIds.length * 8;
    let totalBytes = 0;
    let exchangeFailure = null;
    const bindingFor = (context) =>
    {
        const slice = slices.get(context.producerId);
        if (!producerIds.includes(context.producerId) || !slice
            || context.runIdentity !== execution.runId || context.namespace !== execution.namespace
            || canonicalJson(context.sourceIdentity) !== canonicalJson(source)
            || context.profileIdentity?.profileId !== profileId
            || context.handles?.serviceGeneration !== serviceGeneration
            || context.handles?.fixtureArtifactConsumerId !== consumerId
            || context.variantPlan?.producerVariantPlanDigest !== slice.producerVariantPlanDigest
            || canonicalJson(context.variantPlan.variants.map((item) => item.id).sort())
                !== canonicalJson(slice.variants.map((item) => item.id).sort()))
        {
            throw new Error('fixture artifact context binding drift');
        }
        return { runId: execution.runId, namespace: execution.namespace, source,
            profileId, serviceGeneration,
            producerId: context.producerId, consumerId, variantIds: slice.variants.map((item) => item.id).sort(),
            producerVariantPlanDigest: slice.producerVariantPlanDigest };
    };
    const append = (context, phase, kind, document) =>
    {
        signal?.throwIfAborted();
        const binding = bindingFor(context);
        const key = `${phase}:${context.producerId}:${kind}`;
        if (published.has(phase) || keys.has(key))
        {
            throw new Error('fixture artifact duplicate exchange/result or closed publication');
        }
        const forbiddenValues = Object.entries(context.handles ?? {}).filter(([name, value]) =>
            /secret|token|cookie|ciphertext/iu.test(name) && typeof value === 'string' && value.length > 0).map(([, value]) => value);
        const inspect = (value, depth = 0) =>
        {
            if (depth > 64)
            {
                throw new Error('fixture artifact exceeds bounded nesting');
            }
            if (typeof value === 'string' && (/Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(value)
                || forbiddenValues.some((secret) => value.includes(secret))))
            {
                throw new Error('fixture artifact contains credential material');
            }
            if (value && typeof value === 'object')
            {
                for (const [name, nested] of Object.entries(value))
                {
                    if (/^(?:authorization|headers|cookie|set-cookie|accessToken|refreshToken|token|ciphertext|secret|password|privateKey|opaqueCarrier|privateCarrier|privateCarrierReferences)$/iu.test(name))
                    {
                        throw new Error('fixture artifact contains credential field');
                    }
                    inspect(nested, depth + 1);
                }
            }
        };
        inspect(document);
        const bytes = JSON.stringify({ binding, phase, ...document });
        if (Buffer.byteLength(bytes) > 2 * 1024 * 1024 || totalBytes + Buffer.byteLength(bytes) > producerIds.length * 8 * 1024 * 1024
            || records.length >= maxRecords)
        {
            throw new Error('fixture artifact exceeds bounded invocation capacity');
        }
        totalBytes += Buffer.byteLength(bytes);
        keys.add(key);
        records.push({ phase, producerId: context.producerId, kind, document: JSON.parse(bytes) });
    };
    return Object.freeze({
        consumerId,
        recordRejectedPort(context, result)
        {
            try
            {
                const selected = {};
                for (const name of ['ok', 'producerId', 'structuralOnly', 'fallback', 'warningOnly', 'stale',
                    'observations', 'entityIdentities', 'readObservationDigest'])
                {
                    if (result?.[name] !== undefined)
                    {
                        selected[name] = result[name];
                    }
                }
                append(context, 'verify', 'rejected-result', { result: selected });
            }
            catch (error)
            {
                exchangeFailure ??= error;
            }
        },
        recordRpc(context, exchange)
        {
            // A successful prepare RPC already owns business state. Defer outlet rejection
            // until orchestration registers that success, so its original rollback owns cleanup.
            try
            {
                const phase = exchange.path === '/api/local/comment-fixture/prepare' || exchange.path === '/__local/temporal-observation'
                    ? 'prepare' : exchange.path === '/api/local/comment-fixture/verify' ? 'verify'
                    : exchange.path === '/api/local/comment-fixture/cleanup' ? 'cleanup' : null;
                if (context.producerId !== 'comment-moderation' || !phase
                || exchange.method !== (exchange.path === '/__local/temporal-observation' ? 'GET' : 'POST')
                || !Number.isInteger(exchange.status) || exchange.status < 100 || exchange.status > 599)
                {
                    throw new Error('fixture artifact unowned RPC exchange');
                }
                const prior = records.filter((item) => item.producerId === context.producerId && item.document.exchange)
                    .map((item) => item.document.exchange.path);
                const sequence = ['/api/local/comment-fixture/prepare', '/__local/temporal-observation',
                    '/api/local/comment-fixture/verify', '/api/local/comment-fixture/cleanup'];
                if (prior.length && sequence.indexOf(exchange.path) !== sequence.indexOf(prior.at(-1)) + 1)
                {
                    throw new Error('fixture artifact duplicate or out-of-order RPC exchanges');
                }
                if (exchange.status === 200)
                {
                    const responseFields = phase === 'verify'
                        ? ['schema', 'binding', 'threadEntities', 'moderation', 'cacheGeneration', 'crossDomainBefore', 'crossDomainAfter',
                        'authSourceReceiptDigest', 'publicSourceReceiptDigest']
                        : phase === 'cleanup' ? ['schema', 'binding', 'deletedCommentIds', 'stillPublicCommentIds', 'exact',
                        'crossDomainBefore', 'crossDomainAfter', 'moderationObservation']
                        : exchange.method === 'GET' ? ['businessEpochUtc', 'backendCulture', 'postgresTimezone',
                            'postgresBusinessEpochUtc', 'timezone', 'timeoutPolicyDigest', 'temporalContextDigest', 'businessClockBoundary',
                            'schema', 'runId', 'authorityClass', 'observationBoundary']
                            : ['producerId', 'strategy', 'planDigest', 'inventoryDigest', 'capabilityCatalogDigest', 'variantCatalogDigest',
                                'temporalContextDigest', 'producerPlanDigest', 'capabilityProofs', 'threadEntities', 'zkAuthorityEvidence',
                                'moderation', 'negativeResults', 'cacheGenerationBefore', 'cacheGenerationAfter', 'crossDomainBefore',
                                'crossDomainAfterPrepare', 'cleanupReceipt', 'runtimeLease', 'runtimeRestore'];
                    if (!exchange.response || Object.keys(exchange.response).some((key) => !responseFields.includes(key)))
                    {
                        throw new Error('fixture artifact RPC response has an unowned or credential field');
                    }
                }
                else if (exchange.response && Object.keys(exchange.response).some((key) => !['schema', 'status', 'originalError',
                    'cleanupError', 'recoveryReceipt', 'cleanupResult', 'message', 'detail', 'title', 'type', 'instance'].includes(key)))
                {
                    throw new Error('fixture artifact RPC failure has an unowned or credential field');
                }
                append(context, phase, exchange.path.split('/').at(-1), { exchange: {
                    method: exchange.method, path: exchange.path, status: exchange.status,
                    request: exchange.request, response: exchange.response
                } });
            }
            catch (error)
            {
                exchangeFailure ??= error;
            }
        },
        recordPort(context, phase, result, checkedPostconditions = [])
        {
            if (exchangeFailure && phase !== 'cleanup')
            {
                throw exchangeFailure;
            }
            if (!['prepare', 'verify', 'cleanup'].includes(phase))
            {
                throw new Error('fixture artifact phase is invalid');
            }
            if (result === undefined)
            {
                return;
            }
            if (phase === 'cleanup')
            {
                // Only this owner currently returns a schema-validated independent cleanup proof.
                if (context.producerId === 'comment-moderation' && result?.schema === 'fsusblog.comment-fixture-cleanup-result.v1')
                {
                    append(context, phase, 'port-result', { result });
                }
                return;
            }
            const selected = {};
            for (const name of ['ok', 'producerId', 'observations', 'entityIdentities', 'authSourceReceiptDigest',
                'publicSourceReceiptDigest', 'readObservationDigest'])
            {
                if (result?.[name] !== undefined)
                {
                    selected[name] = result[name];
                }
            }
            append(context, phase, 'port-result', { result: selected, checkedPostconditions });
        },
        publish(phase)
        {
            signal?.throwIfAborted();
            if (!['verify', 'cleanup', 'failure'].includes(phase))
            {
                throw new Error('fixture artifact publication phase is invalid');
            }
            if (exchangeFailure && phase !== 'failure')
            {
                throw exchangeFailure;
            }
            if (published.has(phase))
            {
                throw new Error('fixture artifact duplicate publication');
            }
            for (let ancestor = target; ; ancestor = path.dirname(ancestor))
            {
                if (fs.lstatSync(ancestor).isSymbolicLink())
                {
                    throw new Error('fixture artifact directory ancestors became symlinks');
                }
                if (ancestor === path.dirname(ancestor))
                {
                    break;
                }
            }
            const current = fs.lstatSync(target);
            if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== directoryStat.ino || current.dev !== directoryStat.dev
                || (process.platform !== 'win32' && (current.mode & 0o077) !== 0))
            {
                throw new Error('fixture artifact owned directory changed');
            }
            const selected = records.filter((item) => phase === 'failure' || item.phase === phase || phase === 'verify' && item.phase === 'prepare');
            if (phase === 'verify' && producerIds.includes('comment-moderation'))
            {
                const read = selected.find((item) => item.producerId === 'comment-moderation' && item.kind === 'verify')?.document.exchange;
                const port = selected.find((item) => item.producerId === 'comment-moderation' && item.phase === 'verify' && item.kind === 'port-result')?.document.result;
                if (!read || read.status !== 200 || read.request?.schema !== 'fsusblog.comment-fixture-verification-request.v1'
                    || read.response?.schema !== 'fsusblog.comment-fixture-verification-result.v1'
                    || port?.ok !== true || port.readObservationDigest !== sha256Text(canonicalJson(read.response)))
                {
                    throw new Error('fixture artifact requires original independently verified read, not prepare');
                }
            }
            if (phase === 'cleanup' && selected.some((item) => item.producerId === 'comment-moderation'))
            {
                const rpc = selected.find((item) => item.producerId === 'comment-moderation' && item.kind === 'cleanup')?.document.exchange;
                const proof = selected.find((item) => item.producerId === 'comment-moderation' && item.kind === 'port-result')?.document.result;
                if (rpc?.status !== 200 || proof?.exact !== true || canonicalJson(rpc.response) !== canonicalJson(proof))
                {
                    throw new Error('fixture artifact requires actual exact cleanup response and validated port result');
                }
            }
            const references = [];
            for (const record of selected)
            {
                signal?.throwIfAborted();
                const file = path.join(target, `${record.phase}-${record.producerId}-${record.kind}.json`);
                if (fs.existsSync(file))
                {
                    throw new Error('fixture artifact refuses overwrite of existing output');
                }
                const written = writePrivateJson(file, record.document, { signal, label: 'fixture-port-artifact' });
                references.push({ path: written.path, digest: written.contentDigest,
                    role: `fixture-${phase === 'failure' ? 'failure-' : ''}${record.phase}-${record.kind}` });
            }
            signal?.throwIfAborted();
            published.add(phase);
            return references;
        }
    });
}

export function fileContentDigest(file, options = {})
{
    const { bytes } = readPrivateFile(file, options);
    return sha256Bytes(bytes);
}

/** Pretty JSON digest of a value (for tests / non-file artifacts). */
export function jsonContentDigest(value)
{
    return sha256Text(`${JSON.stringify(value, null, 2)}\n`);
}

export function canonicalContentDigest(value)
{
    return sha256Text(canonicalJson(value));
}
