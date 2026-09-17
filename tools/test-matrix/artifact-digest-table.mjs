import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const artifactDigestTableSchema = 'fsusblog.production-artifact-digest-table.v1';

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function normalize(value)
{
    return String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
}

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
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function tableContentDigest(table)
{
    const { contentDigest: _ignored, ...content } = table;
    return `sha256:${sha256(JSON.stringify(canonicalize(content)))}`;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function sleepSync(milliseconds)
{
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, milliseconds);
}

function processAlive(pid)
{
    if (!Number.isInteger(pid) || pid <= 0)
    {
        return false;
    }
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return error.code === 'EPERM';
    }
}

function acquireLock(lockDirectory, timeoutMs = 30_000)
{
    const deadline = Date.now() + timeoutMs;
    while (true)
    {
        try
        {
            fs.mkdirSync(lockDirectory);
            fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString()
            })}\n`);
            return () => fs.rmSync(lockDirectory, { recursive: true, force: true });
        }
        catch (error)
        {
            if (error.code !== 'EEXIST')
            {
                throw error;
            }
            let stale = false;
            try
            {
                const owner = JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8'));
                stale = !processAlive(Number(owner.pid));
            }
            catch
            {
                try
                {
                    stale = Date.now() - fs.statSync(lockDirectory).mtimeMs > 30_000;
                }
                catch (error)
                {
                    if (error.code === 'ENOENT')
                    {
                        continue;
                    }
                    throw error;
                }
            }
            if (stale)
            {
                fs.rmSync(lockDirectory, { recursive: true, force: true });
                continue;
            }
            if (Date.now() >= deadline)
            {
                throw new Error(`artifact digest table lock timed out: ${lockDirectory}`);
            }
            sleepSync(20);
        }
    }
}

function safeRelativePath(root, value, label = 'artifact')
{
    const declaration = normalize(value);
    if (!declaration || path.isAbsolute(declaration) || declaration === '..' || declaration.startsWith('../'))
    {
        throw new Error(`${label} path is invalid: ${declaration || '<empty>'}`);
    }
    const absolute = path.resolve(root, declaration);
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} is outside the repository: ${declaration}`);
    }
    return { declaration, absolute };
}

function assertSafeTableFile(root, file)
{
    const resolved = path.resolve(file);
    if (!resolved.startsWith(`${root}${path.sep}`))
    {
        throw new Error('artifact digest table is outside the repository');
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const realParent = fs.realpathSync(path.dirname(resolved));
    if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`))
    {
        throw new Error('artifact digest table parent resolves outside the repository');
    }
    try
    {
        if (fs.lstatSync(resolved).isSymbolicLink())
        {
            throw new Error('artifact digest table cannot be a symlink');
        }
    }
    catch (error)
    {
        if (error.code !== 'ENOENT')
        {
            throw error;
        }
    }
    return resolved;
}

function assertRealPathInside(root, absolute, label)
{
    const real = fs.realpathSync(absolute);
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} resolves outside the repository: ${absolute}`);
    }
    return real;
}

function identityFor(root, absolute, metrics)
{
    metrics.statCalls += 1;
    const stat = fs.lstatSync(absolute, { bigint: true });
    const symbolicLink = stat.isSymbolicLink();
    const realPath = assertRealPathInside(root, absolute, 'artifact');
    return {
        realPath: normalize(path.relative(root, realPath)),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: Number(stat.mode),
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        type: symbolicLink ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        ...(symbolicLink ? { linkTarget: fs.readlinkSync(absolute) } : {})
    };
}

function sameIdentity(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

function nodeIdentityKey(identity)
{
    return JSON.stringify([
        identity.type,
        identity.dev,
        identity.ino,
        identity.mode,
        identity.size,
        identity.mtimeNs,
        identity.ctimeNs,
        identity.linkTarget ?? null
    ]);
}

function hasWildcard(value)
{
    return value.includes('*') || value.includes('?');
}

function wildcardPattern(value)
{
    const normalized = normalize(value);
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`, 'u');
}

function wildcardSearchRoot(root, declaration)
{
    const wildcardIndex = declaration.search(/[?*]/u);
    const prefix = wildcardIndex < 0 ? declaration : declaration.slice(0, wildcardIndex);
    const directoryPrefix = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix);
    const absolute = path.resolve(root, directoryPrefix === '.' ? '' : directoryPrefix);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`declared artifact is outside the repository: ${declaration}`);
    }
    return absolute;
}

export function resolveDigestArtifactDeclaration(rootValue, declarationValue, env = process.env)
{
    const root = path.resolve(rootValue);
    const declaration = normalize(declarationValue);
    const mappings = [
        ['src/frontend/dist', env.FSUSBLOG_FRONTEND_DIST_ROOT],
        ['src/frontend/public/wasm', env.FSUSBLOG_FRONTEND_WASM_ROOT],
        ['src/backend/wwwroot', env.FSUSBLOG_BACKEND_WEBROOT]
    ];
    for (const [canonicalRoot, targetValue] of mappings)
    {
        if (declaration !== canonicalRoot && !declaration.startsWith(`${canonicalRoot}/`))
        {
            continue;
        }
        if (!String(targetValue ?? '').trim())
        {
            break;
        }
        const target = path.resolve(String(targetValue));
        if (target === root || !target.startsWith(`${root}${path.sep}`))
        {
            break;
        }
        const suffix = declaration.slice(canonicalRoot.length).replace(/^\//u, '');
        return normalize(path.relative(root, suffix ? path.join(target, suffix) : target));
    }
    return declaration;
}

function emptyMetrics()
{
    return {
        cacheHits: 0,
        cacheMisses: 0,
        fileReadBytes: 0,
        directoryWalks: 0,
        shaCalls: 0,
        statCalls: 0,
        cpuTimeMicros: 0,
        wallClockMs: 0
    };
}

function emptyTable({ runId, sourceState })
{
    return {
        schema: artifactDigestTableSchema,
        status: 'active',
        runId,
        sourceState,
        artifacts: {},
        nodes: {},
        identityNodes: {},
        walkIndexes: {},
        metrics: emptyMetrics(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        contentDigest: null
    };
}

function validateIdentity(table, { runId, sourceState })
{
    if (table.schema !== artifactDigestTableSchema)
    {
        throw new Error('artifact digest table schema mismatch');
    }
    if (table.runId !== runId)
    {
        throw new Error(`artifact digest table run ID mismatch: ${table.runId}/${runId}`);
    }
    if (table.sourceState?.commit !== sourceState.commit
    || table.sourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint)
    {
        throw new Error('artifact digest table source fingerprint mismatch');
    }
    if (table.contentDigest && table.contentDigest !== tableContentDigest(table))
    {
        throw new Error('artifact digest table content digest mismatch');
    }
}

function addMetrics(target, delta)
{
    for (const key of Object.keys(emptyMetrics()))
    {
        target[key] = Number(target[key] ?? 0) + Number(delta[key] ?? 0);
    }
}

function producerKey(producer)
{
    const bundle = String(producer?.bundle ?? 'unknown');
    const step = String(producer?.step ?? 'unknown');
    return `${bundle}/${step}`;
}

class DigestSession
{
    constructor({ root, table, metrics })
    {
        this.root = root;
        this.table = table;
        this.metrics = metrics;
        this.runtimeIndexes = new Map();
    }

    validatePersistedIndex(index)
    {
        try
        {
            for (const [relativePath, expected] of Object.entries(index.identities ?? {}))
            {
                const absolute = path.join(this.root, relativePath);
                if (!fs.existsSync(absolute))
                {
                    return false;
                }
                if (!sameIdentity(identityFor(this.root, absolute, this.metrics), expected))
                {
                    return false;
                }
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    buildIndex(searchRoot)
    {
        this.metrics.directoryWalks += 1;
        const entries = [];
        const identities = {};
        const visit = (absolute) =>
        {
            const relativePath = normalize(path.relative(this.root, absolute));
            const identity = identityFor(this.root, absolute, this.metrics);
            entries.push(relativePath);
            identities[relativePath] = identity;
            if (identity.type !== 'directory')
            {
                return;
            }
            for (const name of fs.readdirSync(absolute).sort())
            {
                visit(path.join(absolute, name));
            }
        };
        visit(searchRoot);
        const index = {
            root: normalize(path.relative(this.root, searchRoot)),
            entries,
            identities,
            identityDigest: `sha256:${sha256(JSON.stringify(canonicalize(identities)))}`
        };
        this.table.walkIndexes[index.root] = index;
        return index;
    }

    index(searchRoot, { fresh = false } = {})
    {
        const key = normalize(path.relative(this.root, searchRoot));
        if (fresh)
        {
            const index = this.buildIndex(searchRoot);
            this.runtimeIndexes.set(key, index);
            return index;
        }
        if (this.runtimeIndexes.has(key))
        {
            return this.runtimeIndexes.get(key);
        }
        const persisted = this.table.walkIndexes[key];
        const index = persisted && this.validatePersistedIndex(persisted)
            ? persisted
            : this.buildIndex(searchRoot);
        if (persisted && index === persisted)
        {
            this.metrics.cacheHits += 1;
        }
        this.runtimeIndexes.set(key, index);
        return index;
    }

    stableFileFingerprint(relativePath, identity)
    {
        const absolute = path.join(this.root, relativePath);
        const existing = this.table.nodes[relativePath];
        if (existing && sameIdentity(existing.identity, identity))
        {
            this.metrics.cacheHits += 1;
            return existing.fingerprint;
        }
        const shared = this.table.identityNodes?.[nodeIdentityKey(identity)];
        if (shared)
        {
            this.metrics.cacheHits += 1;
            this.table.nodes[relativePath] = { identity, fingerprint: shared.fingerprint };
            return shared.fingerprint;
        }
        this.metrics.cacheMisses += 1;
        let fingerprint;
        if (identity.type === 'symlink')
        {
            this.metrics.shaCalls += 1;
            fingerprint = `symlink:${sha256(identity.linkTarget)}`;
        }
        else if (identity.type === 'file')
        {
            let stable = false;
            for (let attempt = 0; attempt < 2 && !stable; attempt += 1)
            {
                const before = identityFor(this.root, absolute, this.metrics);
                const bytes = fs.readFileSync(absolute);
                this.metrics.fileReadBytes += bytes.byteLength;
                this.metrics.shaCalls += 1;
                const contentDigest = sha256(bytes);
                const after = identityFor(this.root, absolute, this.metrics);
                stable = sameIdentity(before, after);
                if (stable)
                {
                    identity = after;
                    fingerprint = `file:${after.mode}:${after.size}:${contentDigest}`;
                }
            }
            if (!stable)
            {
                throw new Error(`artifact changed while hashing: ${relativePath}`);
            }
        }
        else if (identity.type === 'other')
        {
            fingerprint = `other:${identity.mode}:${identity.size}`;
        }
        else
        {
            throw new Error(`directory fingerprint requires an index: ${relativePath}`);
        }
        this.table.nodes[relativePath] = { identity, fingerprint };
        this.table.identityNodes ??= {};
        this.table.identityNodes[nodeIdentityKey(identity)] = { fingerprint };
        return fingerprint;
    }

    directoryFingerprint(relativePath, index)
    {
        const prefix = relativePath ? `${relativePath}/` : '';
        const directChildren = index.entries
            .filter((candidate) => candidate.startsWith(prefix) && candidate !== relativePath)
            .filter((candidate) => !candidate.slice(prefix.length).includes('/'))
            .sort();
        const entries = directChildren.map((childPath) =>
        {
            const identity = index.identities[childPath];
            const name = path.posix.basename(childPath);
            const fingerprint = identity.type === 'directory'
                ? this.directoryFingerprint(childPath, index)
                : this.stableFileFingerprint(childPath, identity);
            return [name, fingerprint];
        });
        this.metrics.shaCalls += 1;
        return `directory:${sha256(JSON.stringify(entries))}`;
    }

    pathFingerprint(relativePath, index = null)
    {
        const absolute = path.join(this.root, relativePath);
        const identity = index?.identities?.[relativePath] ?? identityFor(this.root, absolute, this.metrics);
        if (identity.type !== 'directory')
        {
            return this.stableFileFingerprint(relativePath, identity);
        }
        const directoryIndex = index ?? this.index(absolute);
        return this.directoryFingerprint(relativePath, directoryIndex);
    }

    declaration(declarationValue, env, producer)
    {
        const declaration = normalize(declarationValue);
        safeRelativePath(this.root, declaration, 'declared artifact');
        const resolved = resolveDigestArtifactDeclaration(this.root, declaration, env);
        const absolute = path.resolve(this.root, resolved);
        if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`))
        {
            throw new Error(`declared artifact is outside the repository: ${declaration}`);
        }
        let digest;
        let type;
        let size = 0;
        let count = 0;
        let members = [];
        if (!hasWildcard(resolved))
        {
            if (!fs.existsSync(absolute))
            {
                throw new Error(`declared artifact is missing: ${declaration}`);
            }
            const identity = identityFor(this.root, absolute, this.metrics);
            const index = identity.type === 'directory' ? this.index(absolute) : null;
            const fingerprint = this.pathFingerprint(resolved, index);
            this.metrics.shaCalls += 1;
            digest = `sha256:${sha256(fingerprint)}`;
            type = identity.type;
            size = identity.type === 'directory'
                ? index.entries.reduce((total, entry) => total + Number(index.identities[entry]?.type === 'file' ? index.identities[entry].size : 0), 0)
                : identity.size;
            count = identity.type === 'directory' ? index.entries.length : 1;
            members = identity.type === 'directory' ? [...index.entries] : [resolved];
        }
        else
        {
            const matcher = wildcardPattern(resolved);
            const searchRoot = wildcardSearchRoot(this.root, resolved);
            if (!fs.existsSync(searchRoot))
            {
                throw new Error(`declared artifact is missing: ${declaration}`);
            }
            const index = this.index(searchRoot);
            const matches = index.entries.filter((relativePath) => matcher.test(relativePath)).sort();
            if (matches.length === 0)
            {
                throw new Error(`declared artifact is missing: ${declaration}`);
            }
            const fingerprints = matches.map((relativePath) => [relativePath, this.pathFingerprint(relativePath, index)]);
            this.metrics.shaCalls += 1;
            digest = `sha256:${sha256(JSON.stringify(fingerprints))}`;
            type = 'wildcard';
            count = matches.length;
            size = matches.reduce((total, entry) => total + Number(index.identities[entry]?.type === 'file' ? index.identities[entry].size : 0), 0);
            members = matches;
        }
        const artifactId = `artifact:${sha256(`path:${resolved}`)}`;
        const existing = this.table.artifacts[artifactId];
        const producers = [...new Set([...(existing?.producers ?? []), producerKey(producer)])].sort();
        const canonicalPaths = [...new Set([...(existing?.canonicalPaths ?? []), declaration])].sort();
        this.table.artifacts[artifactId] = {
            artifactId,
            path: resolved,
            canonicalPaths,
            pathType: type,
            size,
            count,
            digest,
            members,
            producers,
            sourceRunId: this.table.runId,
            sourceFingerprint: this.table.sourceState.worktreeFingerprint
        };
        return { declaration, artifactId, digest };
    }
}

function validateRecordedArtifacts(root, table)
{
    const metrics = emptyMetrics();
    const session = new DigestSession({ root, table, metrics });
    for (const [relativePath, node] of Object.entries(table.nodes ?? {}))
    {
        const absolute = path.join(root, relativePath);
        if (!fs.existsSync(absolute)
      || !sameIdentity(identityFor(root, absolute, metrics), node.identity))
        {
            throw new Error(`artifact changed after its final digest: ${relativePath}`);
        }
    }
    for (const record of Object.values(table.artifacts ?? {}))
    {
        if (!['directory', 'wildcard'].includes(record.pathType))
        {
            continue;
        }
        const searchRoot = record.pathType === 'directory'
            ? path.resolve(root, record.path)
            : wildcardSearchRoot(root, record.path);
        // Directory metadata can retain the same timestamp on coarse or heavily
        // contended filesystems even when a member is added. Finalization is the
        // trust boundary, so rebuild the membership index instead of accepting a
        // metadata-only cache hit.
        const index = session.index(searchRoot, { fresh: true });
        const currentMembers = record.pathType === 'directory'
            ? index.entries
            : index.entries.filter((entry) => wildcardPattern(record.path).test(entry)).sort();
        if (JSON.stringify(currentMembers) !== JSON.stringify(record.members))
        {
            throw new Error(`artifact directory changed after its final digest: ${record.path}`);
        }
    }
    return metrics;
}

export function createArtifactDigestTable({
    root: rootValue,
    file,
    runId,
    sourceState
})
{
    const root = path.resolve(rootValue);
    const tablePath = path.resolve(file);
    if (!tablePath.startsWith(`${root}${path.sep}`))
    {
        throw new Error('artifact digest table must be inside the repository');
    }
    if (!String(runId ?? '').trim() || !String(sourceState?.worktreeFingerprint ?? '').trim())
    {
        throw new Error('artifact digest table requires run ID and source fingerprint');
    }
    const identity = {
        runId: String(runId),
        sourceState: {
            commit: sourceState.commit === null || sourceState.commit === undefined
                ? null
                : String(sourceState.commit),
            worktreeFingerprint: String(sourceState.worktreeFingerprint)
        }
    };
    const lockDirectory = `${tablePath}.lock`;

    function update(callback)
    {
        assertSafeTableFile(root, tablePath);
        const release = acquireLock(lockDirectory);
        const started = Date.now();
        const cpu = process.cpuUsage();
        try
        {
            const table = fs.existsSync(tablePath)
                ? JSON.parse(fs.readFileSync(tablePath, 'utf8'))
                : emptyTable(identity);
            validateIdentity(table, identity);
            if (table.status === 'final')
            {
                throw new Error('artifact digest table is already finalized');
            }
            const metrics = emptyMetrics();
            const result = callback(table, metrics);
            const elapsedCpu = process.cpuUsage(cpu);
            metrics.cpuTimeMicros += elapsedCpu.user + elapsedCpu.system;
            metrics.wallClockMs += Date.now() - started;
            addMetrics(table.metrics, metrics);
            table.updatedAt = new Date().toISOString();
            table.contentDigest = null;
            table.contentDigest = tableContentDigest(table);
            writeJsonAtomic(tablePath, table);
            return { ...result, table: descriptor(tablePath, root, table) };
        }
        finally
        {
            release();
        }
    }

    return {
        file: tablePath,
        digestDeclarations(declarations, { env = process.env, producer = {} } = {})
        {
            return update((table, metrics) =>
            {
                const session = new DigestSession({ root, table, metrics });
                const digests = {};
                const refs = {};
                for (const declaration of [...new Set((declarations ?? []).map(normalize))].sort())
                {
                    const record = session.declaration(declaration, env, producer);
                    digests[record.declaration] = record.digest;
                    refs[record.declaration] = record.artifactId;
                }
                return { digests, refs };
            });
        },
        registerSubstitution(canonicalPath, actualDigests, actualRefs, { producer = {} } = {})
        {
            return update((table) =>
            {
                const canonical = normalize(canonicalPath);
                safeRelativePath(root, canonical, 'canonical artifact');
                const paths = Object.keys(actualDigests ?? {}).sort();
                const refPaths = Object.keys(actualRefs ?? {}).sort();
                if (paths.length === 0 || JSON.stringify(paths) !== JSON.stringify(refPaths))
                {
                    throw new Error(`artifact substitution requires physical refs: ${canonical}`);
                }
                for (const actualPath of paths)
                {
                    const normalizedActualPath = safeRelativePath(root, actualPath, 'substitution actual artifact').declaration;
                    const record = table.artifacts[actualRefs[actualPath]];
                    if (!record || record.digest !== actualDigests[actualPath])
                    {
                        throw new Error(`artifact substitution ref does not match digest: ${actualPath}`);
                    }
                    if ((!record.canonicalPaths?.includes(normalizedActualPath) && record.path !== normalizedActualPath)
            || normalizedActualPath !== actualPath)
                    {
                        throw new Error(`artifact substitution ref does not match path: ${actualPath}`);
                    }
                }
                const digest = `sha256:${sha256(JSON.stringify({
                    schema: 'fsusblog.local-artifact-substitution.v1',
                    canonicalPath: canonical,
                    actualDigests: Object.fromEntries(paths.map((entry) => [entry, actualDigests[entry]]))
                }))}`;
                const artifactId = `artifact:${sha256(`substitution:${canonical}:${paths.map((entry) => actualRefs[entry]).join('|')}`)}`;
                const existing = table.artifacts[artifactId];
                table.artifacts[artifactId] = {
                    artifactId,
                    path: canonical,
                    canonicalPaths: [canonical],
                    pathType: 'substitution',
                    size: paths.reduce((total, entry) => total + Number(table.artifacts[actualRefs[entry]].size), 0),
                    count: paths.length,
                    digest,
                    actualPaths: paths,
                    actualArtifactRefs: Object.fromEntries(paths.map((entry) => [entry, actualRefs[entry]])),
                    producers: [...new Set([...(existing?.producers ?? []), producerKey(producer)])].sort(),
                    sourceRunId: table.runId,
                    sourceFingerprint: table.sourceState.worktreeFingerprint
                };
                return { artifactId, digest };
            });
        },
        registerConsumers(bindings)
        {
            return update((table) =>
            {
                for (const [consumer, refs] of Object.entries(bindings ?? {}))
                {
                    for (const artifactId of [...new Set(Object.values(refs ?? {}))])
                    {
                        const record = table.artifacts[artifactId];
                        if (!record)
                        {
                            throw new Error(`artifact consumer references an unknown artifact ID: ${artifactId}`);
                        }
                        record.consumers = [...new Set([...(record.consumers ?? []), String(consumer)])].sort();
                    }
                }
                return { consumerCount: Object.keys(bindings ?? {}).length };
            });
        },
        finalize(snapshotFile = null)
        {
            assertSafeTableFile(root, tablePath);
            const release = acquireLock(lockDirectory);
            try
            {
                if (!fs.existsSync(tablePath))
                {
                    throw new Error('artifact digest table is missing');
                }
                const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
                validateIdentity(table, identity);
                const validationMetrics = validateRecordedArtifacts(root, table);
                addMetrics(table.metrics, validationMetrics);
                table.status = 'final';
                table.finalizedAt = new Date().toISOString();
                const physicalRecords = Object.values(table.artifacts ?? {})
                    .filter((record) => record.pathType !== 'substitution');
                const logicalReadCount = physicalRecords.reduce((total, record) =>
                {
                    return total + Math.max(1, record.consumers?.length ?? 0);
                }, 0);
                const uniquePhysicalCount = physicalRecords.length;
                const amplification = uniquePhysicalCount > 0 ? logicalReadCount / uniquePhysicalCount : 1;
                table.comparison = {
                    basis: 'logical-consumer-estimate-vs-measured-content-cache',
                    beforeEstimated: {
                        fileReadBytes: physicalRecords.reduce((total, record) =>
                        {
                            return total + Number(record.size ?? 0) * Math.max(1, record.consumers?.length ?? 0);
                        }, 0),
                        directoryWalks: physicalRecords.reduce((total, record) =>
                        {
                            return total + (['directory', 'wildcard'].includes(record.pathType)
                                ? Math.max(1, record.consumers?.length ?? 0)
                                : 0);
                        }, 0),
                        shaCalls: Math.ceil(Number(table.metrics.shaCalls ?? 0) * amplification),
                        cpuTimeMicros: Math.ceil(Number(table.metrics.cpuTimeMicros ?? 0) * amplification),
                        wallClockMs: Math.ceil(Number(table.metrics.wallClockMs ?? 0) * amplification)
                    },
                    afterMeasured: {
                        fileReadBytes: Number(table.metrics.fileReadBytes ?? 0),
                        directoryWalks: Number(table.metrics.directoryWalks ?? 0),
                        shaCalls: Number(table.metrics.shaCalls ?? 0),
                        cpuTimeMicros: Number(table.metrics.cpuTimeMicros ?? 0),
                        wallClockMs: Number(table.metrics.wallClockMs ?? 0)
                    },
                    uniquePhysicalCount,
                    logicalReadCount,
                    logicalReadAmplification: amplification
                };
                table.contentDigest = null;
                table.contentDigest = tableContentDigest(table);
                writeJsonAtomic(tablePath, table);
                if (snapshotFile)
                {
                    writeJsonAtomic(assertSafeTableFile(root, snapshotFile), table);
                }
                return descriptor(snapshotFile ? path.resolve(snapshotFile) : tablePath, root, table);
            }
            finally
            {
                release();
            }
        }
    };
}

function descriptor(file, root, table)
{
    return {
        schema: artifactDigestTableSchema,
        path: normalize(path.relative(root, file)),
        runId: table.runId,
        sourceState: { ...table.sourceState },
        artifactCount: Object.keys(table.artifacts ?? {}).length,
        contentDigest: table.contentDigest,
        metrics: { ...table.metrics },
        ...(table.comparison ? { comparison: table.comparison } : {})
    };
}

export function readAndValidateArtifactDigestTable(file, {
    root: rootValue,
    runId,
    sourceState,
    expectedContentDigest = null,
    requireFinal = true
})
{
    const root = path.resolve(rootValue);
    const tablePath = assertSafeTableFile(root, file);
    if (!fs.existsSync(tablePath))
    {
        throw new Error('artifact digest table is missing or outside the repository');
    }
    const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
    validateIdentity(table, { runId, sourceState });
    if (requireFinal && table.status !== 'final')
    {
        throw new Error('artifact digest table is not finalized');
    }
    if (expectedContentDigest && table.contentDigest !== expectedContentDigest)
    {
        throw new Error('artifact digest table expected content digest mismatch');
    }
    if (requireFinal)
    {
        validateRecordedArtifacts(root, table);
    }
    return table;
}

export function validateArtifactRefs(artifactDigests, artifactRefs, table)
{
    const digestPaths = Object.keys(artifactDigests ?? {}).sort();
    const refPaths = Object.keys(artifactRefs ?? {}).sort();
    if (JSON.stringify(digestPaths) !== JSON.stringify(refPaths))
    {
        throw new Error('artifact refs must exactly match artifact digest paths');
    }
    for (const artifactPath of digestPaths)
    {
        const artifactId = artifactRefs[artifactPath];
        const record = table.artifacts?.[artifactId];
        if (!record)
        {
            throw new Error(`artifact ref is missing from digest table: ${artifactPath}`);
        }
        if (record.digest !== artifactDigests[artifactPath])
        {
            throw new Error(`artifact ref digest mismatch: ${artifactPath}`);
        }
        if (!record.canonicalPaths?.includes(artifactPath) && record.path !== artifactPath)
        {
            throw new Error(`artifact ref path mismatch: ${artifactPath}`);
        }
        if (record.pathType !== 'substitution')
        {
            continue;
        };
        const actualPaths = [...(record.actualPaths ?? [])].sort();
        const actualRefPaths = Object.keys(record.actualArtifactRefs ?? {}).sort();
        if (actualPaths.length === 0 || JSON.stringify(actualPaths) !== JSON.stringify(actualRefPaths))
        {
            throw new Error(`artifact substitution refs are incomplete: ${artifactPath}`);
        }
        for (const actualPath of actualPaths)
        {
            if (artifactRefs[actualPath] !== record.actualArtifactRefs[actualPath])
            {
                throw new Error(`artifact substitution actual ref mismatch: ${artifactPath}/${actualPath}`);
            }
        }
    }
}
