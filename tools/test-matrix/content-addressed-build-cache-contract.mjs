import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { collectProductionToolchain } = await import(new URL("../ci/production-build-artifacts.mjs", import.meta.url));

export const buildCacheConfigSchema = 'fsusblog.content-addressed-build-cache-config.v1';
export const buildCacheReceiptSchema = 'fsusblog.content-addressed-build-cache-receipt.v1';
export const buildCacheDomainEvidenceSchema = 'fsusblog.content-addressed-build-cache-domain-evidence.v1';
export const buildCacheSummarySchema = 'fsusblog.content-addressed-build-cache-summary.v1';

export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const semanticIdPattern = /^[a-z][a-z0-9-]*$/u;
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const attemptIdPattern = /^attempt-\d{4}$/u;
export function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function serialize(value)
{
    return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function contentDigest(value)
{
    const copy = { ...value };
    delete copy.contentDigest;
    return sha256(JSON.stringify(canonicalize(copy)));
}

export function atomicJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, serialize(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
}

export function readJson(file, label = file)
{
    try
    {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            throw new Error('not a regular file');
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is unreadable: ${error.message}`, { cause: error });
    }
}

export function safeRelative(value, label)
{
    const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        throw new Error(`${label} path is unsafe: ${normalized || '<empty>'}`);
    }
    return normalized;
}

export function safeInside(root, relative, label)
{
    const normalized = safeRelative(relative, label);
    const absolute = path.resolve(root, normalized);
    if (absolute === root || !absolute.startsWith(`${path.resolve(root)}${path.sep}`))
    {
        throw new Error(`${label} escapes root: ${relative}`);
    }
    return absolute;
}

function requiredRunId(value)
{
    const runId = String(value ?? '').trim();
    if (!runIdPattern.test(runId) || runId === '.' || runId === '..')
    {
        throw new Error(`build cache run id is unsafe: ${runId || '<empty>'}`);
    }
    return runId;
}

function requiredEnvironmentPath(env, name)
{
    const value = String(env?.[name] ?? '').trim();
    if (!value)
    {
        throw new Error(`${name} is required for Production Fresh build cache evidence`);
    }
    return path.resolve(value);
}

function assertExactPath(actual, expected, label)
{
    if (path.resolve(actual) !== path.resolve(expected))
    {
        throw new Error(`${label} does not exact-match its run-bound owner`);
    }
}

function assertAbsoluteInside(root, candidate, label)
{
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    {
        throw new Error(`${label} escapes its owner root: ${candidate}`);
    }
    return resolved;
}

function assertNoSymlinkComponentsForWrite(root, candidate, label)
{
    const resolvedRoot = path.resolve(root);
    let current = path.resolve(candidate);
    assertAbsoluteInside(resolvedRoot, current, label);
    while (current !== resolvedRoot)
    {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error(`${label} contains a symlink: ${current}`);
        }
        current = path.dirname(current);
    }
}

function productionFreshRequested(env)
{
    return Boolean(
        String(env?.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim()
    || String(env?.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '').trim()
    );
}

export function resolveBuildCacheEvidenceLayout({
    root = defaultRoot,
    runRoot = null,
    runId,
    config,
    env = process.env
})
{
    const repositoryRoot = path.resolve(root);
    const normalizedRunId = requiredRunId(runId);
    if (!productionFreshRequested(env))
    {
        return {
            mode: 'legacy',
            runId: normalizedRunId,
            coordinationRoot: null,
            dependencyRoot: runRoot ? path.join(path.resolve(runRoot), 'generated/build-cache') : null,
            domainRoot: path.join(repositoryRoot, config.evidenceRoot, normalizedRunId),
            summary: path.resolve(repositoryRoot, config.summaryFile),
            summaryLock: path.resolve(repositoryRoot, `${config.summaryFile}.lock`),
            finalDomainRoot: null,
            finalSummary: null,
            attemptId: null,
            sourceState: null
        };
    }

    const fresh = config.productionFresh;
    if (!fresh)
    {
        throw new Error('Production Fresh build cache evidence routing is missing from configuration');
    }
    const buildRoot = requiredEnvironmentPath(env, 'FSUSBLOG_PRODUCTION_BUILD_ROOT');
    if (!runRoot)
    {
        throw new Error('runRoot is required for Production Fresh build cache evidence');
    }
    assertExactPath(buildRoot, path.resolve(runRoot), 'Production Fresh build root');
    assertExactPath(
        buildRoot,
        path.join(repositoryRoot, '.tmp', 'build', normalizedRunId),
        'Production Fresh canonical build root'
    );
    assertNoSymlinkComponentsForWrite(repositoryRoot, buildRoot, 'Production Fresh canonical build root');
    if (String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim() !== normalizedRunId)
    {
        throw new Error('Production Fresh build cache run identity does not exact-match the build layout');
    }

    const generatedRoot = requiredEnvironmentPath(env, 'FSUSBLOG_GENERATED_OUTPUT_ROOT');
    assertExactPath(generatedRoot, path.join(buildRoot, 'generated'), 'Production Fresh generated root');
    const outputRoot = requiredEnvironmentPath(env, 'FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT');
    const attemptId = String(env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '').trim();
    if (!attemptIdPattern.test(attemptId))
    {
        throw new Error('Production Fresh attempt identity is unsafe');
    }
    assertExactPath(
        outputRoot,
        path.join(
            repositoryRoot,
            '.tmp',
            'test-runs',
            normalizedRunId,
            'outputs',
            'attempts',
            attemptId
        ),
        'Production Fresh canonical output root'
    );
    assertNoSymlinkComponentsForWrite(repositoryRoot, outputRoot, 'Production Fresh canonical output root');
    if (path.basename(outputRoot) !== attemptId)
    {
        throw new Error('Production Fresh attempt identity does not exact-match the output root');
    }
    const releaseEvidenceRoot = requiredEnvironmentPath(env, 'FSUSBLOG_RELEASE_EVIDENCE_DIR');
    assertExactPath(
        releaseEvidenceRoot,
        path.join(outputRoot, 'release-evidence'),
        'Production Fresh release evidence root'
    );
    const sourceState = {
        commit: String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim(),
        worktreeFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
    };
    if (!sourceState.commit || !sourceState.worktreeFingerprint)
    {
        throw new Error('Production Fresh build cache evidence requires complete source identity');
    }

    const coordinationRoot = safeInside(buildRoot, fresh.coordinationRoot, 'Production Fresh cache coordination');
    assertAbsoluteInside(generatedRoot, coordinationRoot, 'Production Fresh cache coordination');
    assertNoSymlinkComponentsForWrite(buildRoot, coordinationRoot, 'Production Fresh cache coordination');
    const domainRoot = path.join(coordinationRoot, 'domains');
    const finalDomainRoot = safeInside(
        releaseEvidenceRoot,
        fresh.evidenceRoot,
        'Production Fresh cache final evidence'
    );
    const finalSummary = safeInside(
        releaseEvidenceRoot,
        fresh.summaryFile,
        'Production Fresh cache final summary'
    );
    assertNoSymlinkComponentsForWrite(
        outputRoot,
        finalDomainRoot,
        'Production Fresh cache final evidence'
    );
    assertNoSymlinkComponentsForWrite(
        outputRoot,
        finalSummary,
        'Production Fresh cache final summary'
    );
    return {
        mode: 'production-fresh',
        runId: normalizedRunId,
        coordinationRoot,
        dependencyRoot: domainRoot,
        domainRoot,
        summary: path.join(coordinationRoot, 'summary.json'),
        summaryLock: path.join(coordinationRoot, 'summary.lock'),
        finalDomainRoot,
        finalSummary,
        outputRoot,
        releaseEvidenceRoot,
        attemptId,
        sourceState
    };
}

function assertNoSymlink(root, absolute, label)
{
    const resolvedRoot = path.resolve(root);
    let current = path.resolve(absolute);
    while (current !== resolvedRoot)
    {
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error(`${label} contains symlink: ${absolute}`);
        }
        current = path.dirname(current);
    }
}

function validateSemanticId(value, label)
{
    const id = String(value ?? '').trim();
    if (!semanticIdPattern.test(id) || /(?:^|-)issue-?\d+/iu.test(id) || /(?:^|-)pr-?\d+/iu.test(id))
    {
        throw new Error(`${label} must be a semantic lower-kebab identifier`);
    }
    return id;
}

export function loadBuildCacheConfiguration(root = defaultRoot)
{
    const file = path.join(path.resolve(root), 'config/testing/content-addressed-build-cache.json');
    const config = readJson(file, 'content-addressed build cache configuration');
    if (config.schema !== buildCacheConfigSchema)
    {
        throw new Error(`unexpected build cache config schema: ${config.schema}`);
    }
    if (config.productionFresh !== undefined)
    {
        const fresh = config.productionFresh;
        if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh))
        {
            throw new Error('productionFresh build cache routing must be an object');
        }
        const coordinationRoot = safeRelative(fresh.coordinationRoot, 'Production Fresh cache coordination');
        if (coordinationRoot !== 'generated/coordination/production-build-cache')
        {
            throw new Error('Production Fresh cache coordination must use the run-bound generated/coordination owner');
        }
        const evidenceRoot = safeRelative(fresh.evidenceRoot, 'Production Fresh cache evidence');
        const summaryFile = safeRelative(fresh.summaryFile, 'Production Fresh cache summary');
        if (evidenceRoot !== 'production-build-cache/domains'
      || summaryFile !== 'production-build-cache.json')
        {
            throw new Error('Production Fresh cache final evidence must use the canonical release-evidence paths');
        }
    }
    const domains = config.domains ?? {};
    if (Object.keys(domains).length === 0)
    {
        throw new Error('build cache configuration contains no domains');
    }
    for (const [id, domain] of Object.entries(domains))
    {
        validateSemanticId(id, 'build cache domain');
        if (!['restore', 'build'].includes(domain.phase))
        {
            throw new Error(`${id}: invalid phase`);
        }
        if (!Array.isArray(domain.inputPaths) || domain.inputPaths.length === 0)
        {
            throw new Error(`${id}: inputPaths are required`);
        }
        if (!Array.isArray(domain.outputPaths) || domain.outputPaths.length === 0)
        {
            throw new Error(`${id}: outputPaths are required`);
        }
        for (const output of domain.outputPaths)
        {
            const normalized = safeRelative(output, `${id} output`);
            if ((config.forbiddenOutputPrefixes ?? []).some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`)))
            {
                throw new Error(`${id}: dynamic output cannot be cached: ${normalized}`);
            }
        }
        const normalizedOutputs = domain.outputPaths.map(output => safeRelative(output, `${id} output`)).sort();
        for (let index = 1; index < normalizedOutputs.length; index += 1)
        {
            const previous = normalizedOutputs[index - 1];
            const current = normalizedOutputs[index];
            if (current === previous || current.startsWith(`${previous}/`))
            {
                throw new Error(`${id}: output paths overlap: ${previous} and ${current}`);
            }
        }
        for (const receiptPath of domain.outputReceipts ?? [])
        {
            const normalizedReceipt = safeRelative(receiptPath, `${id} output receipt`);
            if (!normalizedOutputs.some(output => normalizedReceipt === output || normalizedReceipt.startsWith(`${output}/`)))
            {
                throw new Error(`${id}: output receipt is outside declared outputs: ${normalizedReceipt}`);
            }
        }
        for (const dependency of domain.dependencies ?? [])
        {
            if (!domains[dependency])
            {
                throw new Error(`${id}: unknown dependency ${dependency}`);
            }
        }
        for (const action of domain.postMaterialization ?? [])
        {
            if (!['rewrite-frontend-build-stage-receipt', 'reseal-wasm-build-receipt'].includes(action?.kind))
            {
                throw new Error(`${id}: unsupported post-materialization action ${action?.kind ?? '<missing>'}`);
            }
            const actionPath = safeRelative(action.path, `${id} post-materialization path`);
            const ownsActionPath = domain.outputPaths.some(output =>
            {
                const normalizedOutput = safeRelative(output, `${id} output`);
                return actionPath === normalizedOutput || actionPath.startsWith(`${normalizedOutput}/`);
            });
            if (!ownsActionPath)
            {
                throw new Error(`${id}: post-materialization path is outside declared outputs: ${actionPath}`);
            }
            if (action.checksumPath)
            {
                safeRelative(action.checksumPath, `${id} post-materialization checksum path`);
            }
            if (action.artifactDir)
            {
                safeRelative(action.artifactDir, `${id} post-materialization artifact directory`);
            }
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const visitDomain = (id, chain = []) =>
    {
        if (visiting.has(id))
        {
            throw new Error(`build cache dependency cycle: ${[...chain, id].join(' -> ')}`);
        }
        if (visited.has(id))
        {
            return;
        }
        visiting.add(id);
        for (const dependency of domains[id].dependencies ?? [])
        {
            visitDomain(dependency, [...chain, id]);
        }
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of Object.keys(domains))
    {
        visitDomain(id);
    }
    return { ...config, file };
}

function shouldIgnore(relative, ignoredSegments)
{
    const segments = relative.split('/');
    return segments.some(segment => ignoredSegments.has(segment));
}

function closureRecords(root, declarations, ignoredSegments)
{
    const records = [];
    for (const declarationValue of declarations)
    {
        const declaration = typeof declarationValue === 'string'
            ? { path: declarationValue, optional: false }
            : { path: declarationValue?.path, optional: declarationValue?.optional === true };
        const relative = safeRelative(declaration.path, 'input');
        const absolute = safeInside(root, relative, 'input');
        if (!fs.existsSync(absolute))
        {
            if (!declaration.optional)
            {
                throw new Error(`build cache input is missing: ${relative}`);
            }
            records.push({ path: relative, missing: true });
            continue;
        }
        assertNoSymlink(root, absolute, `input ${relative}`);
        const visit = current =>
        {
            const stat = fs.lstatSync(current);
            const currentRelative = path.relative(root, current).replaceAll(path.sep, '/');
            if (shouldIgnore(currentRelative, ignoredSegments))
            {
                return;
            }
            if (stat.isSymbolicLink())
            {
                throw new Error(`build cache input contains symlink: ${currentRelative}`);
            }
            if (stat.isDirectory())
            {
                for (const child of fs.readdirSync(current).sort())
                {
                    visit(path.join(current, child));
                }
            }
            else if (stat.isFile())
            {
                const bytes = fs.readFileSync(current);
                records.push({ path: currentRelative, size: bytes.byteLength, digest: sha256(bytes) });
            }
            else
            {
                throw new Error(`build cache input is not a regular file or directory: ${currentRelative}`);
            }
        };
        visit(absolute);
    }
    const sorted = records.sort((left, right) => left.path.localeCompare(right.path));
    const duplicates = sorted.filter((entry, index) => index > 0 && entry.path === sorted[index - 1].path);
    if (duplicates.length > 0)
    {
        throw new Error(`build cache input closure contains duplicate paths: ${duplicates[0].path}`);
    }
    return sorted;
}

export function outputTree(root, outputPaths)
{
    const files = [];
    const directories = [];
    for (const output of outputPaths)
    {
        const relative = safeRelative(output, 'output');
        const absolute = safeInside(root, relative, 'output');
        if (!fs.existsSync(absolute))
        {
            throw new Error(`build cache output is missing: ${relative}`);
        }
        assertNoSymlink(root, absolute, `output ${relative}`);
        const visit = current =>
        {
            const stat = fs.lstatSync(current);
            const currentRelative = path.relative(root, current).replaceAll(path.sep, '/');
            if (stat.isSymbolicLink())
            {
                throw new Error(`build cache output contains symlink: ${currentRelative}`);
            }
            if (stat.isDirectory())
            {
                directories.push(currentRelative);
                for (const child of fs.readdirSync(current).sort())
                {
                    visit(path.join(current, child));
                }
            }
            else if (stat.isFile())
            {
                const bytes = fs.readFileSync(current);
                files.push({ path: currentRelative, size: bytes.byteLength, digest: sha256(bytes) });
            }
            else
            {
                throw new Error(`build cache output is not a regular file or directory: ${currentRelative}`);
            }
        };
        visit(absolute);
    }
    const normalizedFiles = [...new Map(files.map(record => [record.path, record])).values()].sort((a, b) => a.path.localeCompare(b.path));
    const normalizedDirectories = [...new Set(directories)].sort();
    return {
        files: normalizedFiles,
        directories: normalizedDirectories,
        byteCount: normalizedFiles.reduce((sum, record) => sum + record.size, 0),
        digest: sha256(JSON.stringify(canonicalize({ files: normalizedFiles, directories: normalizedDirectories })))
    };
}


function platformIdentity(env)
{
    return {
        os: process.platform,
        arch: process.arch,
        nodeAbi: process.versions.modules ?? null,
        rid: String(env.FSUSBLOG_RUNTIME_IDENTIFIER ?? env.RuntimeIdentifier ?? 'portable'),
        libc: process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : process.platform === 'linux' ? 'unknown-linux-libc' : 'n/a'
    };
}

function environmentIdentity(config, env)
{
    return Object.fromEntries((config.environmentAllowlist ?? []).sort().map(name => [name, env[name] ?? null]));
}

export function dependencyEvidenceFile(runRoot, dependency, {
    root = defaultRoot,
    runId = path.basename(path.resolve(runRoot)),
    config = loadBuildCacheConfiguration(root),
    env = process.env
} = {})
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    return path.join(layout.dependencyRoot, `${dependency}.json`);
}

function dependencyIdentity(root, runRoot, runId, dependencies, config, env)
{
    return dependencies.map(domain =>
    {
        const file = dependencyEvidenceFile(runRoot, domain, { root, runId, config, env });
        if (!fs.existsSync(file))
        {
            throw new Error(`build cache dependency evidence is missing: ${domain}`);
        }
        const evidence = readJson(file, `build cache dependency ${domain}`);
        if (evidence.schema !== buildCacheDomainEvidenceSchema || evidence.status !== 'success' || evidence.domain !== domain
      || !digestPattern.test(String(evidence.key ?? '')) || !digestPattern.test(String(evidence.receiptContentDigest ?? ''))
      || evidence.contentDigest !== contentDigest(evidence))
        {
            throw new Error(`build cache dependency evidence is invalid: ${domain}`);
        }
        return { domain, key: evidence.key, receiptContentDigest: evidence.receiptContentDigest };
    });
}

export function computeBuildCacheIdentity({ root = defaultRoot, runRoot, domainId, command, env = process.env, config = loadBuildCacheConfiguration(root) })
{
    const domain = config.domains[domainId];
    if (!domain)
    {
        throw new Error(`unknown build cache domain: ${domainId}`);
    }
    const ignored = new Set(config.ignoredInputSegments ?? []);
    const inputs = closureRecords(path.resolve(root), domain.inputPaths, ignored);
    const availableToolchain = collectProductionToolchain({ root, env });
    const toolchain = Object.fromEntries((domain.toolchainKeys ?? []).sort().map(key => [key, availableToolchain[key] ?? 'unavailable']));
    const normalizedRunRoot = path.resolve(runRoot);
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? path.basename(normalizedRunRoot)).trim();
    const dependencies = dependencyIdentity(
        path.resolve(root),
        normalizedRunRoot,
        runId,
        domain.dependencies ?? [],
        config,
        env
    );
    const identity = {
        schema: 'fsusblog.content-addressed-build-cache-identity.v1',
        domain: domainId,
        phase: domain.phase,
        declarationDigest: sha256(JSON.stringify(canonicalize(domain))),
        sourceClosure: {
            digest: sha256(JSON.stringify(canonicalize(inputs))),
            fileCount: inputs.filter(record => !record.missing).length,
            missingOptionalPaths: inputs.filter(record => record.missing).map(record => record.path),
            byteCount: inputs.reduce((sum, record) => sum + Number(record.size ?? 0), 0)
        },
        toolchain,
        platform: platformIdentity(env),
        environment: environmentIdentity(config, env),
        properties: domain.properties ?? {},
        dependencyGraph: domain.dependencyGraph ?? {},
        relocation: domain.relocation ?? null,
        postMaterialization: domain.postMaterialization ?? [],
        dependencies,
        command: command.map(String),
        outputPaths: domain.outputPaths.map(value => safeRelative(value, 'output')).sort(),
        outputReceiptPaths: (domain.outputReceipts ?? []).map(value => safeRelative(value, 'output receipt')).sort()
    };
    const key = sha256(JSON.stringify(canonicalize(identity)));
    return { identity, key, domain, config };
}

export function cachePaths(root, config, domainId, key)
{
    const keyName = key.slice('sha256:'.length);
    const cacheRoot = path.resolve(root, process.env.FSUSBLOG_BUILD_CACHE_ROOT || config.cacheRoot);
    const quarantineRoot = path.resolve(root, config.quarantineRoot);
    return {
        cacheRoot,
        objectRoot: path.join(cacheRoot, domainId, keyName),
        stagingRoot: path.join(cacheRoot, '.staging', `${domainId}-${keyName}-${process.pid}-${crypto.randomUUID()}`),
        lockRoot: path.join(cacheRoot, '.locks', domainId, `${keyName}.lock`),
        quarantineRoot: path.join(quarantineRoot, domainId)
    };
}

export function walkAll(root)
{
    if (!fs.existsSync(root))
    {
        return [];
    }
    const values = [];
    const visit = current =>
    {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
        {
            const absolute = path.join(current, entry.name);
            const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
            if (entry.isSymbolicLink())
            {
                throw new Error(`cache object contains symlink: ${relative}`);
            }
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.isFile())
            {
                values.push(relative);
            }
            else
            {
                throw new Error(`cache object contains unsupported entry: ${relative}`);
            }
        }
    };
    visit(root);
    return values;
}

function validateEmbeddedReceipt(file, record)
{
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== record.fileDigest)
    {
        throw new Error(`embedded receipt digest mismatch: ${record.path}`);
    }
    const document = JSON.parse(bytes.toString('utf8'));
    if (record.schema !== (document.schema ?? null))
    {
        throw new Error(`embedded receipt schema mismatch: ${record.path}`);
    }
    if (record.contentDigest !== (document.contentDigest ?? null))
    {
        throw new Error(`embedded receipt content digest mismatch: ${record.path}`);
    }
}


function assertReadOnlyObjectTree(root)
{
    const visit = current =>
    {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink())
        {
            throw new Error(`build cache object contains symlink: ${current}`);
        }
        if ((stat.mode & 0o222) !== 0)
        {
            throw new Error(`build cache object is writable: ${current}`);
        }
        if (stat.isDirectory())
        {
            for (const child of fs.readdirSync(current).sort())
            {
                visit(path.join(current, child));
            }
        }
        else if (!stat.isFile())
        {
            throw new Error(`build cache object contains unsupported entry: ${current}`);
        }
    };
    visit(path.resolve(root));
}

export function verifyBuildCacheObject({ root = defaultRoot, runRoot, domainId, command, env = process.env, objectRoot = null, config = loadBuildCacheConfiguration(root) })
{
    const computed = computeBuildCacheIdentity({ root, runRoot, domainId, command, env, config });
    const paths = cachePaths(root, config, domainId, computed.key);
    const candidate = path.resolve(objectRoot ?? paths.objectRoot);
    if (!fs.existsSync(candidate))
    {
        return { hit: false, reason: 'object-missing', ...computed, paths };
    }
    const receiptCandidates = fs.readdirSync(candidate).filter(name => name === 'receipt.json' || name.endsWith('.build-cache-receipt.json'));
    if (receiptCandidates.length !== 1 || receiptCandidates[0] !== 'receipt.json')
    {
        throw new Error(`build cache receipt is ambiguous: ${receiptCandidates.join(', ') || '<missing>'}`);
    }
    const receipt = readJson(path.join(candidate, 'receipt.json'), 'build cache receipt');
    const errors = [];
    try
    {
        assertReadOnlyObjectTree(candidate);
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (receipt.schema !== buildCacheReceiptSchema)
    {
        errors.push('receipt schema');
    }
    if (receipt.status !== 'complete')
    {
        errors.push('receipt status');
    }
    if (receipt.domain !== domainId)
    {
        errors.push('receipt domain');
    }
    if (receipt.key !== computed.key)
    {
        errors.push('receipt key');
    }
    if (receipt.identityDigest !== sha256(JSON.stringify(canonicalize(computed.identity))))
    {
        errors.push('identity digest');
    }
    if (receipt.contentDigest !== contentDigest(receipt))
    {
        errors.push('receipt content digest');
    }
    const payloadRoot = path.join(candidate, 'payload');
    try
    {
        const actualTree = outputTree(payloadRoot, computed.domain.outputPaths);
        if (actualTree.digest !== receipt.artifactTree?.digest)
        {
            errors.push('artifact tree digest');
        }
        if (actualTree.byteCount !== Number(receipt.artifactTree?.byteCount))
        {
            errors.push('artifact byte count');
        }
        if (JSON.stringify(canonicalize(actualTree.files)) !== JSON.stringify(canonicalize(receipt.artifactTree?.files)))
        {
            errors.push('artifact file records');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    for (const embedded of receipt.embeddedReceipts ?? [])
    {
        try
        {
            validateEmbeddedReceipt(safeInside(payloadRoot, embedded.path, 'embedded receipt'), embedded);
        }
        catch (error)
        {
            errors.push(error.message);
        }
    }
    const expectedObjectFiles = new Set(['receipt.json', ...(receipt.artifactTree?.files ?? []).map(record => `payload/${record.path}`)]);
    try
    {
        const actualObjectFiles = walkAll(candidate);
        if (JSON.stringify(actualObjectFiles) !== JSON.stringify([...expectedObjectFiles].sort()))
        {
            errors.push('object contains unreceipted files');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (errors.length > 0)
    {
        const failure = new Error(`build cache object verification failed: ${errors.join('; ')}`);
        failure.cachePaths = paths;
        throw failure;
    }
    return { hit: true, reason: 'verified-hit', receipt, ...computed, paths };
}
