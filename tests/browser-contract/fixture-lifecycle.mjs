import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserContractFailure } from './contract.mjs';

export const browserContractFixtureLifecycleSchema = 'fsusblog.browser-contract-fixture-lifecycle.v1';
export const browserContractFixtureManifestSchema = 'fsusblog.browser-contract-fixture.v2';
export const browserContractFixtureProviderRequestSchema = 'fsusblog.browser-contract-fixture-provider-request.v1';
export const browserContractFixtureProviderResponseSchema = 'fsusblog.browser-contract-fixture-provider-response.v1';
export const browserContractFixedFixtureTopology = Object.freeze({ sessions: 1, concurrency: 1 });

const cleanupPromises = new WeakMap();
const providerOutputLimitBytes = 1024 * 1024;

function compactIdentity(value, label)
{
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    if (!normalized || normalized === '.' || normalized === '..')
    {
        throw new BrowserContractFailure(`browser contract ${label} identity is missing`, 'contract');
    }
    return normalized;
}

function digest(value, length)
{
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function resolveConfiguredBase(configured, repoRoot)
{
    if (!configured)
    {
        return path.join(repoRoot, '.tmp', 'browser-contract', 'fixtures');
    }
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured);
}

function relativeInside(root, value, label)
{
    const resolvedRoot = path.resolve(root);
    const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(resolvedRoot, value);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    {
        throw new BrowserContractFailure(`${label} escapes the browser contract fixture root`, 'contract');
    }
    return resolved;
}

function serializeLifecycleError(error)
{
    if (!error)
    {
        return null;
    }
    return {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        failureClass: error instanceof BrowserContractFailure ? error.failureClass : 'contract'
    };
}

function resolveRequiredSourceState(env, sourceState)
{
    const hasExplicitSourceState = sourceState !== null && sourceState !== undefined;
    const commit = String(
    hasExplicitSourceState ? sourceState?.commit ?? '' : env.FSUSBLOG_TEST_SOURCE_COMMIT ?? ''
    ).trim();
    const worktreeFingerprint = String(
    hasExplicitSourceState
        ? sourceState?.worktreeFingerprint ?? ''
        : env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? ''
    ).trim();
    if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new BrowserContractFailure(
            'Browser Contract fixture preparation requires complete source commit and worktree fingerprint identity',
            'contract'
        );
    }
    return Object.freeze({ commit, worktreeFingerprint });
}

export function resolveBrowserContractRunIdentity({
    env = process.env,
    sourceState = null,
    repoRoot = process.cwd(),
    now = Date.now()
} = {})
{
    const sessionMode = String(env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE ?? '').trim();
    const configuredSessions = String(env.FSUSBLOG_BROWSER_CONTRACT_SESSIONS ?? '1').trim();
    const configuredConcurrency = String(env.FSUSBLOG_BROWSER_CONTRACT_CONCURRENCY ?? '1').trim();
    if (sessionMode !== 'browser-contract')
    {
        throw new BrowserContractFailure('Browser Contract fixture identity requires browser-contract session mode', 'contract');
    }
    if (configuredSessions !== '1' || configuredConcurrency !== '1')
    {
        throw new BrowserContractFailure('Browser Contract fixture topology is fixed at 1 session / 1 concurrency', 'contract');
    }
    const resolvedSourceState = resolveRequiredSourceState(env, sourceState);
    const commit = resolvedSourceState.commit;
    const runId = compactIdentity(
        env.FSUSBLOG_BROWSER_CONTRACT_RUN_ID
      ?? (env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local-${process.pid}-${now}`),
        'run'
    );
    const laneId = 'browser-contract';
    const namespace = `bc-${commit.slice(0, 8)}-${digest(runId, 10)}-${digest(laneId, 6)}`;
    const fixtureBase = resolveConfiguredBase(env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_ROOT, repoRoot);
    const fixtureRoot = path.join(fixtureBase, namespace);

    return Object.freeze({
        schema: browserContractFixtureLifecycleSchema,
        sessionMode,
        sessions: browserContractFixedFixtureTopology.sessions,
        concurrency: browserContractFixedFixtureTopology.concurrency,
        commit,
        runId,
        laneId,
        namespace,
        databaseSchema: 'public',
        databaseInstance: `fsusblog-test-postgres-${namespace}`,
        redisNamespace: `FsusBlog_${namespace}_`,
        redisInstance: `fsusblog-test-redis-${namespace}`,
        fixtureRoot
    });
}

function resolveProvider(env, repoRoot)
{
    const configured = String(env.FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER ?? '').trim();
    if (!configured)
    {
        throw new BrowserContractFailure(
            'FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER is required; isolated preparation cannot fall back to public data',
            'contract'
        );
    }
    const provider = path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured);
    if (!existsSync(provider))
    {
        throw new BrowserContractFailure(`browser contract fixture provider is missing: ${provider}`, 'contract');
    }
    const nodeModule = /\.(?:cjs|mjs|js)$/u.test(provider);
    return {
        command: nodeModule ? process.execPath : provider,
        args: nodeModule ? [provider] : [],
        file: provider
    };
}

function providerTimeoutMs(request, env)
{
    const configured = request.operation === 'resetContractNamespace' && request.phase === 'prepare'
        ? env.FSUSBLOG_BROWSER_CONTRACT_PREPARE_TIMEOUT_MS
        : request.operation === 'resetContractNamespace' && request.phase === 'cleanup'
      ? env.FSUSBLOG_BROWSER_CONTRACT_CLEANUP_TIMEOUT_MS
      : env.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_TIMEOUT_MS;
    const fallback = request.operation === 'resetContractNamespace' && request.phase === 'prepare'
        ? 300_000
        : 30_000;
    if (configured === undefined || String(configured).trim() === '')
    {
        return fallback;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > fallback)
    {
        throw new BrowserContractFailure(
            `browser contract fixture provider timeout for ${request.operation} must be 100..${fallback}ms`,
            'contract'
        );
    }
    return parsed;
}

function providerStderrDigest(stderr)
{
    return `sha256:${createHash('sha256').update(stderr).digest('hex')}`;
}

function decodeProcessEnvironment(raw)
{
    return Object.fromEntries(String(raw)
        .split('\0')
        .filter(Boolean)
        .map((entry) =>
        {
            const separator = entry.indexOf('=');
            return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
        }));
}

export function providerProcessGroupIsOwned(processGroupId, {
    invocationId,
    namespace,
    fixtureRoot,
    procRoot = '/proc'
} = {})
{
    if (!Number.isInteger(processGroupId) || processGroupId <= 1
    || !invocationId || !namespace || !fixtureRoot)
    {
        return false;
    }

    let ownedMemberCount = 0;
    let entries;
    try
    {
        entries = readdirSync(procRoot, { withFileTypes: true });
    }
    catch
    {
        return false;
    }
    for (const entry of entries)
    {
        if (!entry.isDirectory() || !/^\d+$/u.test(entry.name))
        {
            continue;
        }
        const processRoot = path.join(procRoot, entry.name);
        let tail;
        try
        {
            const stat = readFileSync(path.join(processRoot, 'stat'), 'utf8');
            tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        }
        catch (error)
        {
            if (error?.code === 'ENOENT')
            {
                continue;
            }
            return false;
        }
        if (Number.parseInt(tail[2] ?? '', 10) !== processGroupId)
        {
            continue;
        }
        if (tail[0] === 'Z')
        {
            continue;
        }

        let environment;
        try
        {
            environment = decodeProcessEnvironment(readFileSync(path.join(processRoot, 'environ'), 'utf8'));
        }
        catch (error)
        {
            if (error?.code === 'ENOENT')
            {
                continue;
            }
            return false;
        }
        if (environment.FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID !== invocationId
      || environment.FSUSBLOG_PLAYWRIGHT_SESSION_MODE !== 'browser-contract'
      || environment.FSUSBLOG_TEST_NAMESPACE !== namespace
      || path.resolve(String(environment.FSUSBLOG_FIXTURE_ROOT ?? '')) !== path.resolve(fixtureRoot))
        {
            return false;
        }
        ownedMemberCount += 1;
    }
    return ownedMemberCount > 0;
}

async function invokeProvider(provider, request, { env, repoRoot, signal })
{
    const timeoutMs = providerTimeoutMs(request, env);
    const invocationId = randomUUID();
    return await new Promise((resolve, reject) =>
    {
        const child = spawn(provider.command, provider.args, {
            cwd: repoRoot,
            env: {
                ...env,
                FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
                FSUSBLOG_TEST_SESSION_ISOLATION: '1',
                FSUSBLOG_TEST_SESSION: request.identity.namespace,
                FSUSBLOG_TEST_NAMESPACE: request.identity.namespace,
                FSUSBLOG_FIXTURE_ROOT: request.resources.fixtureRoot,
                FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID: invocationId
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let forcedKillTimer = null;

        const providerGroupIsOwned = () => process.platform !== 'win32'
      && providerProcessGroupIsOwned(child.pid, {
          invocationId,
          namespace: request.identity.namespace,
          fixtureRoot: request.resources.fixtureRoot
      });

        const terminate = (signalName = 'SIGTERM') =>
        {
            try
            {
                if (process.platform !== 'win32' && child.pid)
                {
                    const childIsActive = child.exitCode === null && child.signalCode === null;
                    if ((signalName === 'SIGTERM' && (childIsActive || providerGroupIsOwned()))
            || (signalName === 'SIGKILL' && providerGroupIsOwned()))
                    {
                        process.kill(-child.pid, signalName);
                    }
                }
                else if (signalName !== 'SIGKILL' || (child.exitCode === null && child.signalCode === null))
                {
                    child.kill(signalName);
                }
            }
            catch
            {}
            if (signalName === 'SIGTERM' && !forcedKillTimer)
            {
                forcedKillTimer = setTimeout(() =>
                {
                    forcedKillTimer = null;
                    terminate('SIGKILL');
                }, 750);
                forcedKillTimer.unref();
            }
        };

        const finish = (error, response = null) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (forcedKillTimer && !providerGroupIsOwned())
            {
                clearTimeout(forcedKillTimer);
                forcedKillTimer = null;
            }
            if (error)
            {
                reject(error);
            }
            else
            {
                resolve(response);
            }
        };
        const abort = () => terminate('SIGTERM');
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
        {
            abort();
        }
        const timer = setTimeout(() =>
        {
            timedOut = true;
            terminate('SIGTERM');
        }, timeoutMs);
        timer.unref();

        child.stdout.on('data', (chunk) =>
        {
            stdout += chunk;
            if (Buffer.byteLength(stdout) > providerOutputLimitBytes)
            {
                terminate('SIGTERM');
            }
        });
        child.stderr.on('data', (chunk) =>
        {
            stderr += chunk;
            if (Buffer.byteLength(stderr) > providerOutputLimitBytes)
            {
                terminate('SIGTERM');
            }
        });
        child.once('error', (error) => finish(new BrowserContractFailure(
            `browser contract fixture provider did not start: ${error.message}`,
            'contract'
        )));
        child.once('close', (code, childSignal) =>
        {
            if (signal?.aborted)
            {
                finish(new BrowserContractFailure('browser contract fixture preparation was cancelled', 'infra'));
                return;
            }
            if (timedOut)
            {
                finish(new BrowserContractFailure(`browser contract fixture provider timed out during ${request.operation}`, 'infra'));
                return;
            }
            if (code !== 0 || childSignal)
            {
                finish(new BrowserContractFailure(
                    `browser contract fixture provider failed during ${request.operation} (${childSignal || `exit ${code}`})`,
                    'contract',
                    {
                        operation: request.operation,
                        exitCode: code,
                        signal: childSignal,
                        stderrDigest: providerStderrDigest(stderr)
                    }
                ));
                return;
            }
            let response;
            try
            {
                response = JSON.parse(stdout);
            }
            catch (error)
            {
                finish(new BrowserContractFailure(
                    `browser contract fixture provider returned invalid JSON during ${request.operation}`,
                    'contract',
                    { message: error instanceof Error ? error.message : String(error) }
                ));
                return;
            }
            if (response?.schema !== browserContractFixtureProviderResponseSchema
        || response.operation !== request.operation
        || response.status !== 'ok')
            {
                finish(new BrowserContractFailure(
                    `browser contract fixture provider response is invalid during ${request.operation}`,
                    'contract'
                ));
                return;
            }
            finish(null, response);
        });
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
}

function providerRequest(operation, context)
{
    return {
        schema: browserContractFixtureProviderRequestSchema,
        operation,
        identity: {
            commit: context.identity.commit,
            runId: context.identity.runId,
            laneId: context.identity.laneId,
            namespace: context.identity.namespace
        },
        preparation: context.preparation,
        resources: {
            databaseSchema: context.identity.databaseSchema,
            databaseInstance: context.identity.databaseInstance,
            redisNamespace: context.identity.redisNamespace,
            redisInstance: context.identity.redisInstance,
            fixtureRoot: context.identity.fixtureRoot
        },
        sourceState: context.sourceState,
        build: context.build
    };
}

function requireEntity(response, operation)
{
    if (!response?.entity || typeof response.entity !== 'object' || Array.isArray(response.entity))
    {
        throw new BrowserContractFailure(`browser contract fixture provider omitted ${operation} entity`, 'contract');
    }
    return response.entity;
}

export function createBrowserContractFixtureApi({
    identity,
    env = process.env,
    repoRoot = process.cwd(),
    sourceState = null,
    build = null,
    preparation = null,
    signal = null
} = {})
{
    if (!identity || identity.sessionMode !== 'browser-contract')
    {
        throw new BrowserContractFailure('browser contract fixture API requires a browser-contract run identity', 'contract');
    }
    const provider = resolveProvider(env, repoRoot);
    const context = {
        identity,
        sourceState,
        build,
        preparation: preparation ?? {
            id: randomUUID(),
            startedAt: new Date().toISOString()
        }
    };
    const call = async (operation, options = {}) => await invokeProvider(
        provider,
        { ...providerRequest(operation, context), ...options },
        { env, repoRoot, signal }
    );

    return Object.freeze({
        async resetContractNamespace({ phase })
        {
            if (phase !== 'prepare' && phase !== 'cleanup')
            {
                throw new BrowserContractFailure('resetContractNamespace phase must be prepare or cleanup', 'contract');
            }
            return await call('resetContractNamespace', { phase });
        },
        async createPublishedArticle()
        {
            return requireEntity(await call('createPublishedArticle'), 'createPublishedArticle');
        },
        async createPendingComment()
        {
            return requireEntity(await call('createPendingComment'), 'createPendingComment');
        },
        async createUserSession()
        {
            return requireEntity(await call('createUserSession'), 'createUserSession');
        },
        async createAdminSession()
        {
            return requireEntity(await call('createAdminSession'), 'createAdminSession');
        }
    });
}

function requirePositiveId(value, label)
{
    const text = String(value ?? '').trim();
    if (!/^\d+$/u.test(text) || Number(text) <= 0)
    {
        throw new BrowserContractFailure(`${label} id is invalid`, 'contract');
    }
    return text;
}

function requireUrl(value, label)
{
    const text = String(value ?? '').trim();
    try
    {
        new URL(text);
    }
    catch
    {
        throw new BrowserContractFailure(`${label} URL is invalid`, 'contract');
    }
    return text;
}

async function writeJsonAtomic(file, value)
{
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
}

function portableStorageFile(root, value, label)
{
    const file = relativeInside(root, String(value ?? ''), label);
    if (!existsSync(file))
    {
        throw new BrowserContractFailure(`${label} is missing`, 'contract');
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file)
    {
        throw new BrowserContractFailure(`${label} must be a regular non-symlink file`, 'contract');
    }
    if ((stat.mode & 0o777) !== 0o600)
    {
        throw new BrowserContractFailure(`${label} permissions must be 0600`, 'contract');
    }
    return path.relative(root, file).replaceAll(path.sep, '/');
}

export async function prepareBrowserContractFixture({
    env = process.env,
    repoRoot = process.cwd(),
    sourceState = null,
    build = null,
    signal = null,
    now = Date.now()
} = {})
{
    if (env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE !== 'browser-contract')
    {
        throw new BrowserContractFailure('Browser Contract requires FSUSBLOG_PLAYWRIGHT_SESSION_MODE=browser-contract', 'contract');
    }
    const resolvedSourceState = resolveRequiredSourceState(env, sourceState);
    const identity = resolveBrowserContractRunIdentity({ env, sourceState: resolvedSourceState, repoRoot, now });
    const startedAt = new Date(now).toISOString();
    const preparation = {
        id: randomUUID(),
        startedAt
    };
    const lifecycle = {
        schema: browserContractFixtureLifecycleSchema,
        status: 'preparing',
        topology: { ...browserContractFixedFixtureTopology },
        identity: {
            commit: identity.commit,
            runId: identity.runId,
            laneId: identity.laneId,
            namespace: identity.namespace
        },
        preparation,
        resources: {
            databaseSchema: identity.databaseSchema,
            databaseInstance: identity.databaseInstance,
            redisNamespace: identity.redisNamespace,
            redisInstance: identity.redisInstance,
            fixtureRoot: path.relative(repoRoot, identity.fixtureRoot).replaceAll(path.sep, '/'),
            database: {
                status: 'pending',
                evidence: {
                    schema: identity.databaseSchema,
                    instance: identity.databaseInstance,
                    id: null
                }
            },
            redis: {
                status: 'pending',
                evidence: {
                    namespace: identity.redisNamespace,
                    instance: identity.redisInstance,
                    id: null
                }
            }
        },
        sourceState: resolvedSourceState,
        buildIdentity: build
            ? {
          receiptContentDigest: build.receiptContentDigest ?? null,
          profile: build.profile ?? null
        }
            : null,
        startedAt,
        preparedAt: null,
        cleanup: {
            status: 'pending',
            reason: null,
            attempts: 0,
            startedAt: null,
            finishedAt: null,
            error: null,
            resources: {
                database: {
                    status: 'pending',
                    evidence: { schema: identity.databaseSchema, instance: identity.databaseInstance, id: null }
                },
                redis: {
                    status: 'pending',
                    evidence: { namespace: identity.redisNamespace, instance: identity.redisInstance, id: null }
                },
                processes: {
                    status: 'pending',
                    evidence: { terminatedPids: [], skippedPids: [], retainedRuntimeState: false }
                },
                files: {
                    status: 'pending',
                    evidence: { root: path.relative(repoRoot, identity.fixtureRoot).replaceAll(path.sep, '/') }
                }
            }
        }
    };
    const prepared = {
        identity,
        root: identity.fixtureRoot,
        manifestFile: path.join(identity.fixtureRoot, 'contract-fixture.json'),
        manifest: null,
        lifecycle,
        env,
        repoRoot,
        sourceState: resolvedSourceState,
        build,
        preparation
    };

    await mkdir(identity.fixtureRoot, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(identity.fixtureRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(identity.fixtureRoot) !== identity.fixtureRoot)
    {
        throw new BrowserContractFailure('browser contract fixture root must be a regular non-symlink directory', 'contract');
    }
    chmodSync(identity.fixtureRoot, 0o700);
    try
    {
        const api = createBrowserContractFixtureApi({
            identity,
            env,
            repoRoot,
            sourceState: resolvedSourceState,
            build,
            preparation,
            signal
        });
        const reset = await api.resetContractNamespace({ phase: 'prepare' });
        if (reset.runtime?.testSessionHeader !== false)
        {
            throw new BrowserContractFailure(
                'Browser Contract fixture provider must explicitly disable the test-session header',
                'contract'
            );
        }
        if (reset.ownership?.containers)
        {
            lifecycle.resources.database.status = 'owned';
            lifecycle.resources.database.evidence.id = reset.ownership.containers.postgres?.id ?? null;
            lifecycle.resources.redis.status = 'owned';
            lifecycle.resources.redis.evidence.id = reset.ownership.containers.redis?.id ?? null;
        }
        if (signal?.aborted)
        {
            throw new BrowserContractFailure('browser contract fixture preparation was cancelled', 'infra');
        }
        const article = await api.createPublishedArticle();
        const pendingComment = await api.createPendingComment();
        const user = await api.createUserSession();
        const admin = await api.createAdminSession();

        const articleId = requirePositiveId(article.id, 'published article');
        const categoryId = requirePositiveId(article.category?.id, 'published article category');
        const pendingCommentId = requirePositiveId(pendingComment.id, 'pending comment');
        if (requirePositiveId(pendingComment.articleId, 'pending comment article') !== articleId)
        {
            throw new BrowserContractFailure('pending comment must belong to the contract article', 'contract');
        }
        const manifest = {
            schema: browserContractFixtureManifestSchema,
            sealed: true,
            generatedAt: new Date().toISOString(),
            identity: lifecycle.identity,
            preparation,
            resources: {
                databaseSchema: identity.databaseSchema,
                databaseInstance: identity.databaseInstance,
                redisNamespace: identity.redisNamespace,
                redisInstance: identity.redisInstance
            },
            sourceState: resolvedSourceState,
            buildIdentity: lifecycle.buildIdentity,
            topology: { ...browserContractFixedFixtureTopology },
            baseUrl: requireUrl(
                reset.runtime?.frontendUrl || env.PLAYWRIGHT_BASE_URL || env.FSUSBLOG_PUBLIC_BASE_URL || env.FSUSBLOG_DEBUG_FRONTEND_URL || 'http://127.0.0.1:3000',
                'frontend'
            ).replace(/\/+$/u, ''),
            backendUrl: requireUrl(
                reset.runtime?.backendUrl || env.FSUSBLOG_ACCEPTANCE_BACKEND_URL || env.FSUSBLOG_BASE_URL || env.FSUSBLOG_DEBUG_BACKEND_URL || 'http://127.0.0.1:7568',
                'backend'
            ).replace(/\/+$/u, ''),
            transport: { testSessionHeader: false },
            ownership: reset.ownership ?? null,
            entities: {
                publicArticle: {
                    id: articleId,
                    title: String(article.title ?? '').trim(),
                    url: requireUrl(article.url, 'published article')
                },
                category: {
                    id: categoryId,
                    name: String(article.category?.name ?? '').trim()
                },
                pendingComment: {
                    id: pendingCommentId,
                    articleId,
                    url: requireUrl(pendingComment.url, 'pending comment')
                },
                user: {
                    id: Number(requirePositiveId(user.id, 'user')),
                    storageStateFile: portableStorageFile(identity.fixtureRoot, user.storageStateFile, 'user storage state')
                },
                admin: {
                    id: Number(requirePositiveId(admin.id, 'admin')),
                    storageStateFile: portableStorageFile(identity.fixtureRoot, admin.storageStateFile, 'admin storage state')
                }
            },
            capabilities: {
                webAuthnRegistration: user.capabilities?.webAuthnRegistration === true
            }
        };
        if (!manifest.entities.publicArticle.title || !manifest.entities.category.name)
        {
            throw new BrowserContractFailure('browser contract fixture entity labels are incomplete', 'contract');
        }
        await writeJsonAtomic(prepared.manifestFile, manifest);
        prepared.manifest = manifest;
        lifecycle.status = 'prepared';
        lifecycle.preparedAt = new Date().toISOString();
        return prepared;
    }
    catch (error)
    {
        lifecycle.status = 'prepare-failure';
        lifecycle.error = serializeLifecycleError(error);
        const cleanupReason = signal?.aborted
            ? 'cancelled'
            : /timed out/iu.test(error instanceof Error ? error.message : String(error)) ? 'timeout' : 'prepare-failure';
        const cleanup = await cleanupBrowserContractFixture(prepared, { reason: cleanupReason });
        const failure = error instanceof Error ? error : new Error(String(error));
        Object.assign(failure, {
            fixtureLifecycle: lifecycle,
            preparedFixture: prepared,
            cleanup
        });
        throw failure;
    }
}

function cleanupResourceResult(resource, fallbackEvidence)
{
    const providerStatus = String(resource?.status ?? 'unknown');
    const status = providerStatus === 'success' || providerStatus === 'already-absent'
        ? 'success'
        : providerStatus === 'failure' ? 'failure' : 'unknown';
    return {
        status,
        evidence: {
            ...fallbackEvidence,
            providerStatus,
            instance: resource?.instance ?? fallbackEvidence.instance ?? null,
            id: resource?.id ?? fallbackEvidence.id ?? null
        }
    };
}

function cleanupProcessResult(resource)
{
    const providerStatus = String(resource?.status ?? 'unknown');
    return {
        status: providerStatus === 'success' ? 'success' : providerStatus === 'failure' ? 'failure' : 'unknown',
        evidence: {
            providerStatus,
            terminatedPids: Array.isArray(resource?.terminatedPids) ? resource.terminatedPids : [],
            skippedPids: Array.isArray(resource?.skippedPids) ? resource.skippedPids : [],
            skippedProcesses: Array.isArray(resource?.skippedProcesses) ? resource.skippedProcesses : [],
            retainedRuntimeState: resource?.retainedRuntimeState === true
        }
    };
}

function freshCleanupResources(prepared)
{
    return {
        database: {
            status: 'pending',
            evidence: {
                schema: prepared.identity.databaseSchema,
                instance: prepared.identity.databaseInstance,
                id: prepared.lifecycle.resources.database?.evidence?.id ?? null
            }
        },
        redis: {
            status: 'pending',
            evidence: {
                namespace: prepared.identity.redisNamespace,
                instance: prepared.identity.redisInstance,
                id: prepared.lifecycle.resources.redis?.evidence?.id ?? null
            }
        },
        processes: {
            status: 'pending',
            evidence: {
                providerStatus: 'pending',
                terminatedPids: [],
                skippedPids: [],
                skippedProcesses: [],
                retainedRuntimeState: false
            }
        },
        files: {
            status: 'pending',
            evidence: {
                root: path.relative(prepared.repoRoot, prepared.root).replaceAll(path.sep, '/')
            }
        }
    };
}

export async function cleanupBrowserContractFixture(prepared, { reason = 'completed', signal = null } = {})
{
    if (!prepared || typeof prepared !== 'object')
    {
        return {
            status: 'failure',
            reason,
            attempts: 0,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: { name: 'BrowserContractFailure', message: 'fixture lifecycle is unavailable', failureClass: 'contract' }
        };
    }
    if (cleanupPromises.has(prepared))
    {
        return await cleanupPromises.get(prepared);
    }
    const cleanupPromise = (async () =>
    {
        const cleanup = prepared.lifecycle.cleanup;
        cleanup.status = 'running';
        cleanup.reason = reason;
        cleanup.attempts += 1;
        cleanup.startedAt = new Date().toISOString();
        cleanup.finishedAt = null;
        cleanup.error = null;
        cleanup.resources = freshCleanupResources(prepared);
        try
        {
            const api = createBrowserContractFixtureApi({
                identity: prepared.identity,
                env: prepared.env,
                repoRoot: prepared.repoRoot,
                sourceState: prepared.sourceState,
                build: prepared.build,
                preparation: prepared.preparation,
                signal
            });
            const response = await api.resetContractNamespace({ phase: 'cleanup' });
            cleanup.resources.database = cleanupResourceResult(response.cleanup?.resources?.database, {
                schema: prepared.identity.databaseSchema,
                instance: prepared.identity.databaseInstance,
                id: prepared.lifecycle.resources.database?.evidence?.id ?? null
            });
            cleanup.resources.redis = cleanupResourceResult(response.cleanup?.resources?.redis, {
                namespace: prepared.identity.redisNamespace,
                instance: prepared.identity.redisInstance,
                id: prepared.lifecycle.resources.redis?.evidence?.id ?? null
            });
            cleanup.resources.processes = cleanupProcessResult(response.cleanup?.resources?.processes);
            cleanup.status = response.cleanup?.status === 'success'
        && cleanup.resources.database.status === 'success'
        && cleanup.resources.redis.status === 'success'
        && cleanup.resources.processes.status === 'success'
                ? 'success'
                : 'failure';
        }
        catch (error)
        {
            cleanup.status = 'failure';
            cleanup.error = serializeLifecycleError(error);
            cleanup.resources.database.status = 'failure';
            cleanup.resources.redis.status = 'failure';
            cleanup.resources.processes.status = 'failure';
        }
        finally
        {
            if (cleanup.status === 'success')
            {
                await rm(prepared.root, { recursive: true, force: true }).catch((error) =>
                {
                    cleanup.status = 'failure';
                    cleanup.error ??= serializeLifecycleError(error);
                    cleanup.resources.files.status = 'failure';
                });
                if (cleanup.resources.files.status !== 'failure')
                {
                    cleanup.resources.files.status = 'success';
                }
            }
            else
            {
                cleanup.resources.files = {
                    status: 'retained',
                    evidence: {
                        root: path.relative(prepared.repoRoot, prepared.root).replaceAll(path.sep, '/'),
                        retainedForRetry: true
                    }
                };
            }
            cleanup.finishedAt = new Date().toISOString();
            prepared.lifecycle.status = cleanup.status === 'success' ? 'cleaned' : 'cleanup-failure';
        }
        return cleanup;
    })();
    cleanupPromises.set(prepared, cleanupPromise);
    const result = await cleanupPromise;
    if (result.status === 'failure')
    {
        cleanupPromises.delete(prepared);
    }
    return result;
}

export async function readSealedBrowserContractFixture(file)
{
    let manifest;
    try
    {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== path.resolve(file) || (stat.mode & 0o777) !== 0o600)
        {
            throw new BrowserContractFailure('sealed browser contract fixture manifest is not a private regular file', 'contract');
        }
        manifest = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error)
    {
        throw new BrowserContractFailure('sealed browser contract fixture manifest is unreadable', 'contract', {
            message: error instanceof Error ? error.message : String(error)
        });
    }
    if (manifest?.schema !== browserContractFixtureManifestSchema || manifest.sealed !== true)
    {
        throw new BrowserContractFailure('sealed browser contract fixture manifest schema is invalid', 'contract');
    }
    return manifest;
}
