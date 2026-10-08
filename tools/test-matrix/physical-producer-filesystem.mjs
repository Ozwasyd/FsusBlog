import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { canonicalFilesystemIdentity, productionDiskDemandDigest } from './production-disk-demand.mjs';

export const physicalProducerFilesystemCatalogSchema = 'fsusblog.physical-producer-filesystem-catalog.v1';
export const physicalProducerFilesystemPlanSchema = 'fsusblog.physical-producer-filesystem-plan.v1';
const requestSchema = 'fsusblog.physical-producer-filesystem-request.v1';
const ownerKinds = new Set(['executable', 'summary', 'projection', 'receipt-only-finalizer']);
const accessModes = new Set(['read', 'create', 'write', 'replace', 'delete']);
const rootRoles = new Set(['repository', 'current', 'resume', 'active', 'resident', 'retained']);

function record(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !keys.includes(key)))
    {
        throw new Error(`${label} has an unknown or invalid shape`);
    }
}

function text(value, label)
{
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.includes('\0'))
    {
        throw new Error(`${label} must be non-empty canonical text`);
    }
    return value;
}

function identifier(value, label)
{
    text(value, label);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value))
    {
        throw new Error(`${label} must be a safe identifier`);
    }
    return value;
}

function array(value, label)
{
    if (!Array.isArray(value) || value.length === 0)
    {
        throw new Error(`${label} must be a non-empty array`);
    }
}

function inside(root, candidate)
{
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function absolute(value, label)
{
    text(value, label);
    if (!path.isAbsolute(value) || value.split(/[\\/]/u).includes('..'))
    {
        throw new Error(`${label} must be absolute without path traversal`);
    }
    return path.normalize(value);
}

function mountPath(value)
{
    return value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function nativeMountId(canonicalPath)
{
    const descriptor = fs.openSync(canonicalPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try
    {
        const identity = fs.readFileSync(`/proc/self/fdinfo/${descriptor}`, 'utf8').match(/^mnt_id:\s+([1-9][0-9]*)$/mu)?.[1];
        if (!identity)
        {
            throw new Error('native filesystem mount identity is unknown');
        }
        return identity;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

/**
 * Resolve Linux mount roots rather than equating different bind-mount spellings
 * with independent storage. Unsupported platforms require a native mount observer;
 * a device number alone cannot establish a volume-relative overlap coordinate.
 */
export function observePhysicalProducerMount(canonicalPath, {
    platform = process.platform,
    mountInfo = platform === 'linux' ? fs.readFileSync('/proc/self/mountinfo', 'utf8') : null,
    namespace = platform === 'linux' ? fs.readlinkSync('/proc/self/ns/mnt') : null,
    mountId = platform === 'linux' ? nativeMountId(canonicalPath) : null
} = {})
{
    if (platform !== 'linux' || typeof mountInfo !== 'string' || !mountInfo.trim())
    {
        throw new Error('native filesystem mount/volume identity is unknown');
    }
    text(namespace, 'mount namespace');
    const mounts = mountInfo.trim().split('\n').map((line) =>
    {
        const [left, right, extra] = line.split(' - ');
        const fields = left.split(' ');
        const filesystemFields = right?.split(' ');
        if (extra !== undefined || fields.length < 6 || !filesystemFields || filesystemFields.length < 3
            || !/^[1-9][0-9]*$/u.test(fields[0]) || !/^[0-9]+:[0-9]+$/u.test(fields[2]))
        {
            throw new Error('invalid filesystem mount identity');
        }
        return {
            mountId: fields[0],
            device: fields[2],
            mountRoot: mountPath(fields[3]),
            mountPoint: absolute(mountPath(fields[4]), 'mount point')
        };
    }).filter((mount) => mount.mountId === mountId && inside(mount.mountPoint, canonicalPath));
    if (mounts.length !== 1)
    {
        throw new Error('missing or ambiguous filesystem mount identity');
    }
    const mount = mounts[0];
    mount.mountRoot = absolute(mount.mountRoot, 'mount root');
    const metadata = fs.statSync(canonicalPath, { bigint: true });
    const major = ((metadata.dev >> 8n) & 0xfffn) | ((metadata.dev >> 32n) & 0xfffff000n);
    const minor = (metadata.dev & 0xffn) | ((metadata.dev >> 12n) & 0xffffff00n);
    if (`${major}:${minor}` !== mount.device)
    {
        throw new Error('filesystem mount device identity mismatch');
    }
    return {
        mountIdentity: `${namespace}:${mount.mountId}:${mount.device}:${mount.mountRoot}`,
        filesystemPath: path.resolve(mount.mountRoot, path.relative(mount.mountPoint, canonicalPath))
    };
}

function resolveRoot(root, context, resolveFilesystem, observeMount)
{
    record(root, ['rootId', 'path', 'boundaryPath', 'role', 'runId'], 'filesystem root');
    identifier(root.rootId, 'rootId');
    if (!rootRoles.has(root.role))
    {
        throw new Error(`unknown filesystem root role: ${root.role}`);
    }
    if (root.role === 'repository')
    {
        if (root.runId !== undefined)
        {
            throw new Error('repository root cannot declare a run identity');
        }
    }
    else
    {
        identifier(root.runId, 'root runId');
        if ((root.role === 'current' && root.runId !== context.runId)
            || (root.role === 'resume' && root.runId !== context.resumeRunId))
        {
            throw new Error(`${root.role} root run identity mismatch`);
        }
    }
    const candidate = absolute(root.path, 'root path');
    const boundary = fs.realpathSync.native(absolute(root.boundaryPath, 'root boundary'));
    if (!inside(path.normalize(root.boundaryPath), candidate))
    {
        throw new Error(`filesystem root escapes declared boundary: ${root.rootId}`);
    }
    let ancestor = candidate;
    const missing = [];
    while (true)
    {
        try
        {
            fs.lstatSync(ancestor);
            break;
        }
        catch (error)
        {
            if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor)
            {
                throw error;
            }
            missing.unshift(path.basename(ancestor));
            ancestor = path.dirname(ancestor);
        }
    }
    const canonicalAncestor = fs.realpathSync.native(ancestor);
    if (!fs.statSync(canonicalAncestor).isDirectory() || !inside(boundary, canonicalAncestor))
    {
        throw new Error(`filesystem root realpath escapes boundary or is not a directory: ${root.rootId}`);
    }
    const resolution = resolveFilesystem(canonicalAncestor, { stat: (file) => fs.statSync(file, { bigint: true }) });
    const mount = observeMount(canonicalAncestor);
    if (typeof resolution?.filesystemIdentity !== 'string' || !resolution.filesystemIdentity
        || resolution.canonicalPath !== canonicalAncestor
        || typeof mount?.mountIdentity !== 'string' || !mount.mountIdentity || !path.isAbsolute(mount.filesystemPath ?? ''))
    {
        throw new Error(`filesystem/mount identity is unknown for ${root.rootId}`);
    }
    const metadata = fs.statSync(canonicalAncestor, { bigint: true });
    return {
        rootId: root.rootId,
        role: root.role,
        ...(root.runId === undefined ? {} : { runId: root.runId }),
        declaredPath: candidate,
        boundaryPath: boundary,
        resolvedRoot: path.join(canonicalAncestor, ...missing),
        existingAncestor: canonicalAncestor,
        ancestorIdentity: `${metadata.dev}:${metadata.ino}`,
        unresolvedSegments: missing,
        filesystemIdentity: resolution.filesystemIdentity,
        mountIdentity: mount.mountIdentity,
        filesystemPath: path.join(absolute(mount.filesystemPath, 'volume-relative filesystem path'), ...missing)
    };
}

function boundContext(context)
{
    record(context, ['runId', 'attemptId', 'resumeRunId', 'sourceState'], 'context');
    identifier(context.runId, 'context.runId');
    identifier(context.attemptId, 'context.attemptId');
    if (context.resumeRunId !== undefined)
    {
        identifier(context.resumeRunId, 'context.resumeRunId');
    }
    record(context.sourceState, ['commit', 'worktreeFingerprint'], 'sourceState');
    if (!/^[0-9a-f]{40}$/u.test(context.sourceState.commit ?? '')
        || !/^sha256:[0-9a-f]{64}$/u.test(context.sourceState.worktreeFingerprint ?? ''))
    {
        throw new Error('source/worktree identity is missing or invalid');
    }
    return structuredClone(context);
}

/**
 * Compile only explicit access facts. physicalOwners must come from the caller's
 * canonical execution declarations, never from names, commands or disk estimates.
 * This read-only plan grants no execution, GC permission or receipt authority.
 */
export function compilePhysicalProducerFilesystemPlan({
    catalog,
    physicalOwners,
    roots,
    context,
    expectedCatalogDigest = null,
    resolveFilesystem = canonicalFilesystemIdentity,
    observeMount = observePhysicalProducerMount
})
{
    const binding = boundContext(context);
    record(catalog, ['schema', 'domains', 'producers'], 'filesystem catalog');
    if (catalog.schema !== physicalProducerFilesystemCatalogSchema)
    {
        throw new Error('unknown physical producer filesystem catalog schema');
    }
    array(catalog.producers, 'catalog producers');
    array(catalog.domains, 'catalog domains');
    array(physicalOwners, 'physical owners');
    array(roots, 'filesystem roots');
    const owners = new Map();
    for (const owner of physicalOwners)
    {
        record(owner, ['producerId', 'ownerKind', 'spawnEligibility'], 'physical owner');
        identifier(owner.producerId, 'producerId');
        if (owners.has(owner.producerId) || !ownerKinds.has(owner.ownerKind)
            || owner.spawnEligibility !== (owner.ownerKind === 'executable'))
        {
            throw new Error(`duplicate or invalid physical owner: ${owner.producerId}`);
        }
        owners.set(owner.producerId, owner);
    }
    const resolved = new Map();
    for (const root of roots)
    {
        if (resolved.has(root.rootId))
        {
            throw new Error(`duplicate filesystem root: ${root.rootId}`);
        }
        const observation = resolveRoot(root, binding, resolveFilesystem, observeMount);
        for (const previous of resolved.values())
        {
            if (previous.filesystemIdentity === observation.filesystemIdentity
                && (previous.filesystemPath === observation.filesystemPath
                    || (previous.ancestorIdentity === observation.ancestorIdentity
                        && previous.unresolvedSegments.join('/') === observation.unresolvedSegments.join('/'))))
            {
                throw new Error(`filesystem root alias collision: ${previous.rootId}, ${root.rootId}`);
            }
        }
        resolved.set(root.rootId, observation);
    }
    const domains = new Map();
    for (const domain of catalog.domains)
    {
        record(domain, ['domainId', 'rootIds', 'sourceOfDeclaration'], 'filesystem domain');
        identifier(domain.domainId, 'domainId');
        text(domain.sourceOfDeclaration, 'domain sourceOfDeclaration');
        array(domain.rootIds, 'domain rootIds');
        if (domains.has(domain.domainId) || new Set(domain.rootIds).size !== domain.rootIds.length
            || domain.rootIds.some((rootId) => !resolved.has(rootId)))
        {
            throw new Error(`duplicate or unknown filesystem domain roots: ${domain.domainId}`);
        }
        domains.set(domain.domainId, new Set(domain.rootIds));
    }
    const producers = new Map();
    for (const producer of catalog.producers)
    {
        record(producer, ['producerId', 'ownerKind', 'sourceOfDeclaration', 'accesses'], 'producer declaration');
        const owner = owners.get(producer.producerId);
        if (!owner || owner.ownerKind !== 'executable' || producer.ownerKind !== owner.ownerKind)
        {
            throw new Error(`non-executable or unknown filesystem producer: ${producer.producerId}`);
        }
        if (producers.has(producer.producerId))
        {
            throw new Error(`duplicate filesystem producer: ${producer.producerId}`);
        }
        text(producer.sourceOfDeclaration, 'sourceOfDeclaration');
        array(producer.accesses, 'producer accesses');
        const seen = new Set();
        const accesses = producer.accesses.map((access) =>
        {
            record(access, ['rootId', 'domainId', 'accessMode'], 'filesystem access');
            identifier(access.domainId, 'domainId');
            const root = resolved.get(access.rootId);
            if (!root || !accessModes.has(access.accessMode))
            {
                throw new Error(`unknown filesystem root/access mode: ${access.rootId}/${access.accessMode}`);
            }
            if (!domains.get(access.domainId)?.has(access.rootId))
            {
                throw new Error(`unknown filesystem domain/root binding: ${access.domainId}/${access.rootId}`);
            }
            const key = `${access.rootId}:${access.domainId}:${access.accessMode}`;
            if (seen.has(key))
            {
                throw new Error(`duplicate filesystem access: ${key}`);
            }
            seen.add(key);
            return { ...structuredClone(access), ...structuredClone(root) };
        }).sort((left, right) => left.rootId.localeCompare(right.rootId)
            || left.domainId.localeCompare(right.domainId) || left.accessMode.localeCompare(right.accessMode));
        producers.set(producer.producerId, {
            producerId: producer.producerId,
            ownerKind: owner.ownerKind,
            sourceOfDeclaration: producer.sourceOfDeclaration,
            resolvedRoots: accesses
        });
    }
    for (const owner of owners.values())
    {
        if (owner.spawnEligibility && !producers.has(owner.producerId))
        {
            throw new Error(`missing filesystem declaration for executable producer: ${owner.producerId}`);
        }
    }
    const catalogDigest = productionDiskDemandDigest(catalog);
    if (expectedCatalogDigest !== null && expectedCatalogDigest !== catalogDigest)
    {
        throw new Error('physical filesystem catalog identity drift');
    }
    const plan = {
        schema: physicalProducerFilesystemPlanSchema,
        qualificationEligible: false,
        context: binding,
        catalogDigest,
        ownershipDigest: productionDiskDemandDigest([...owners.values()].sort((left, right) => left.producerId.localeCompare(right.producerId))),
        rootsDigest: productionDiskDemandDigest([...resolved.values()].sort((left, right) => left.rootId.localeCompare(right.rootId))),
        producers: [...producers.values()].sort((left, right) => left.producerId.localeCompare(right.producerId))
    };
    return { ...plan, planDigest: productionDiskDemandDigest(plan) };
}

/** Reobserve roots and bindings before consuming a saved local/CI/resume plan. */
export function verifyPhysicalProducerFilesystemPlan(plan, input)
{
    const current = compilePhysicalProducerFilesystemPlan(input);
    if (plan?.schema !== physicalProducerFilesystemPlanSchema || plan.planDigest !== current.planDigest
        || productionDiskDemandDigest(plan) !== productionDiskDemandDigest(current))
    {
        throw new Error('physical filesystem plan/source/run/root identity drift');
    }
    return current;
}

function main(args)
{
    if (args.length !== 3 || args[0] !== '--plan-only' || args[1] !== '--input' || !args[2])
    {
        throw new Error('usage: physical-producer-filesystem.mjs --plan-only --input <request.json>');
    }
    const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    record(request, ['schema', 'catalog', 'physicalOwners', 'roots', 'context', 'expectedCatalogDigest'], 'filesystem request');
    if (request.schema !== requestSchema)
    {
        throw new Error('unknown physical filesystem request schema');
    }
    const { schema, ...input } = request;
    void schema;
    process.stdout.write(`${JSON.stringify(compilePhysicalProducerFilesystemPlan(input), null, 4)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
