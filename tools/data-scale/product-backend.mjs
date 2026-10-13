/**
 * Start/stop the product FsusBlog.Server process against a dedicated data-scale
 * postgres/redis pair so HTTP/AEDS, Search API, and HotRead proofs can run.
 * Catalog classifies backend as run-owned-process; the identity sleep container
 * from mode=full remains ownership-only and is not the HTTP authority.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { monotonicNow } = await import(new URL('../test/temporal-context.mjs', import.meta.url));

export const DATA_SCALE_PRODUCT_BACKEND_PORT = 18888;

function shellQuote(value)
{
    return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

export function resolveDedicatedHostPorts({
    postgresContainerName,
    redisContainerName,
    dockerRunner = (args) => spawnSync('docker', args, { encoding: 'utf8' })
})
{
    const postgres = dockerRunner([
        'inspect', postgresContainerName,
        '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}'
    ]);
    const redis = dockerRunner([
        'inspect', redisContainerName,
        '--format', '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}'
    ]);
    const postgresHostPort = String(postgres.stdout || '').trim();
    const redisHostPort = String(redis.stdout || '').trim();
    if (postgres.status !== 0 || !/^\d+$/u.test(postgresHostPort))
    {
        throw new Error(`dedicated postgres host port unavailable for ${postgresContainerName}`);
    }
    if (redis.status !== 0 || !/^\d+$/u.test(redisHostPort))
    {
        throw new Error(`dedicated redis host port unavailable for ${redisContainerName}`);
    }
    return { postgresHostPort, redisHostPort };
}

export function buildProductBackendEnvironment({
    repositoryRoot,
    postgresHostPort,
    redisHostPort,
    runRoot,
    baseUrl = `http://127.0.0.1:${DATA_SCALE_PRODUCT_BACKEND_PORT}`,
    namespace = 'data-scale'
} = {})
{
    if (!postgresHostPort || !redisHostPort)
    {
        throw new Error('product backend requires dedicated postgres/redis host ports');
    }
    if (!runRoot)
    {
        throw new Error('product backend requires dedicated runRoot (WebRoot parent of search/)');
    }
    const absoluteRunRoot = path.resolve(repositoryRoot, runRoot);
    fs.mkdirSync(path.join(absoluteRunRoot, 'search'), { recursive: true });
    fs.mkdirSync(path.join(absoluteRunRoot, 'aot-cache'), { recursive: true });

    const nsSlug = String(namespace).replace(/[^a-zA-Z0-9_]/gu, '_');
    const redisConnection = `127.0.0.1:${redisHostPort},abortConnect=false,connectTimeout=10000`;
    const postgresConnection =
        `Host=127.0.0.1;Port=${postgresHostPort};Database=fsusblog;`
        + 'Username=fsusblog;Password=fsusblog_dev;Search Path=public';

    const queryBindingPath = path.join(absoluteRunRoot, 'query-capture-binding.json');
    const queryCapture = fs.existsSync(queryBindingPath) ? {
        fsus__queryPlanCaptureDirectory: path.join(absoluteRunRoot, 'query-captures'),
        fsus__queryPlanCaptureBindingPath: queryBindingPath,
        FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET: fs.readFileSync(path.join(absoluteRunRoot, 'query-observation.secret'), 'utf8').trim()
    } : {};
    return {
        ASPNETCORE_ENVIRONMENT: 'Development',
        ...queryCapture,
        ASPNETCORE_URLS: baseUrl,
        ASPNETCORE_CONTENTROOT: path.resolve(repositoryRoot, 'src/backend'),
        ASPNETCORE_WEBROOT: absoluteRunRoot,
        ConnectionStrings__DefaultConnection: postgresConnection,
        ConnectionStrings__Redis: redisConnection,
        RedisOptions__Configuration: redisConnection,
        RedisOptions__InstanceName: `FsusBlog_DataScale_${nsSlug}_`,
        Jwt__KeyVersion: 'dev-v1',
        Jwt__SecretKey: 'local-development-jwt-secret-change-before-shared-use-2026',
        Jwt__Issuer: 'FsusBlogServer',
        Jwt__Audience: 'FsusBlogClient',
        Jwt__AccessTokenExpiresMinutes: '1440',
        Jwt__RotationWindowDays: '30',
        Security__Pow__SigningKey: 'local-development-pow-signing-key-change-before-shared-use-2026',
        Security__Pow__BaseDifficulty: '8',
        Security__Pow__MaxDifficulty: '8',
        Security__PerceptionSealedToken__CurrentKeyVersion: 'dev',
        Security__PerceptionSealedToken__Keys__dev:
            '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
        Security__RecoveryKeyPepper: 'local-development-recovery-key-pepper-change-before-shared-use-2026',
        MfaChallenge__TicketSigningKey: 'local-development-mfa-ticket-signing-key-change-before-shared-use-2026',
        VisitLog__IpPseudonymization__CurrentEpoch: '1',
        VisitLog__IpPseudonymization__CurrentKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        Moderation__Pepper: 'local-development-moderation-pepper-change-before-shared-use-2026',
        Moderation__RegionPolicy__IpHashKey:
            'local-development-moderation-region-ip-hash-key-change-before-shared-use-2026',
        Subscription__EmailHashPepper:
            'local-development-subscription-email-hash-pepper-change-before-shared-use-2026',
        AnonymousCredentialIssuer__IssuerPublicKeyId: 'local-dev-issuer',
        AnonymousCredentialIssuer__SubjectHashPepper:
            'local-development-anonymous-subject-hash-pepper-change-before-shared-use-2026',
        AnonymousCredentialRoot__AttestationKey:
            'local-development-anonymous-root-attestation-key-change-before-shared-use-2026',
        AnonymousCredentialRoot__AttestationKeyId: 'local-dev-root-attestation',
        AnonymousIdentity__NullifierPepper:
            'local-development-anonymous-nullifier-pepper-change-before-shared-use-2026',
        FSUSBLOG_ANONYMOUS_IDENTITY_MODE: '1',
        ActiveReleaseFence__AllowSyntheticLocalFence: 'true',
        fsus__allowLocalAuthFixture: 'false',
        Security__RiskControl__PublicReadChallenge__Enabled: 'false',
        RateLimiting__PublicReadPermitLimit: '10000',
        RateLimiting__PublicReadQueueLimit: '10000',
        HumanReadProof__SigningKey: 'local-development-human-read-proof-signing-key-change-before-shared-use-2026',
        HumanReadProof__Dedup__CurrentKey: 'local-development-human-read-proof-dedup-key-change-before-shared-use-2026',
        ReadAnalyticsPrivacy__NoiseKey: 'local-development-read-analytics-noise-key-change-before-shared-use-2026',
        AuthCookies__AllowInsecureTransportCookies: 'true',
        CORS_ALLOWED_HOSTS: 'http://127.0.0.1:3000,http://localhost:3000',
        Seo__BaseUrl: 'http://127.0.0.1:3000',
        Fido2__ServerDomain: 'localhost',
        Fido2__Origins__0: 'http://localhost:3000',
        Fido2__Origins__1: 'http://127.0.0.1:3000',
        FSUSBLOG_BASE_URL: baseUrl,
        FSUSBLOG_DEBUG_BACKEND_URL: baseUrl,
        FSUSBLOG_SEARCH_DIR: path.join(absoluteRunRoot, 'search'),
        FSUSBLOG_SEARCH_INDEX_DIR: path.join(absoluteRunRoot, 'search'),
        FSUSBLOG_AOT_CACHE_DIR: path.join(absoluteRunRoot, 'aot'),
        FSUSBLOG_PUBLIC_AOT_CACHE_DIR: path.join(absoluteRunRoot, 'aot'),
        FSUSBLOG_HOTREAD_ROOT: path.join(absoluteRunRoot, 'hotread')
    };
}

export function writeProductBackendEnvironmentFile(filePath, environment)
{
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const body = Object.entries(environment)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join('\n');
    fs.writeFileSync(absolute, `${body}\n`, { mode: 0o600 });
    fs.chmodSync(absolute, 0o600);
    return absolute;
}

export async function waitForBackendLive(baseUrl, {
    timeoutMs = 120_000,
    intervalMs = 1_000,
    fetchImpl = fetch
} = {})
{
    const deadline = monotonicNow() + timeoutMs;
    let lastError = null;
    while (monotonicNow() < deadline)
    {
        try
        {
            const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}/health/live`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(3_000)
            });
            if (response.ok)
            {
                const document = await response.json().catch(() => null);
                if (document?.status === 'live' || response.status === 200)
                {
                    return { status: 'live', httpStatus: response.status };
                }
            }
            lastError = `http ${response.status}`;
        }
        catch (error)
        {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await delay(intervalMs);
    }
    throw new Error(`product backend did not become live within ${timeoutMs}ms: ${lastError}`);
}

export function startProductBackendProcess({
    repositoryRoot,
    environment,
    logFile,
    pidFile,
    serverDll = path.join(repositoryRoot, 'src/backend/bin/Release/net10.0/FsusBlog.Server.dll')
})
{
    const absoluteDll = path.resolve(serverDll);
    if (!fs.existsSync(absoluteDll))
    {
        throw new Error(
            `product backend requires ${path.relative(repositoryRoot, absoluteDll)}; `
            + 'fallback to shared runtime is prohibited'
        );
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn('dotnet', [absoluteDll], {
        cwd: repositoryRoot,
        env: { ...process.env, ...environment },
        detached: true,
        stdio: ['ignore', out, out]
    });
    child.unref();
    fs.writeFileSync(pidFile, `${child.pid}\n`);
    return {
        pid: child.pid,
        pidFile,
        logFile,
        baseUrl: environment.FSUSBLOG_BASE_URL || environment.ASPNETCORE_URLS
    };
}

export function stopProductBackendProcess({ pidFile, pid = null })
{
    let resolvedPid = pid;
    if (!resolvedPid && pidFile && fs.existsSync(pidFile))
    {
        resolvedPid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    }
    if (!resolvedPid || !Number.isFinite(resolvedPid))
    {
        return { status: 'missing' };
    }
    try
    {
        process.kill(resolvedPid, 'SIGTERM');
    }
    catch (error)
    {
        if (error?.code === 'ESRCH')
        {
            return { status: 'stopped', pid: resolvedPid };
        }
        throw error;
    }
    const deadline = monotonicNow() + 30_000;
    while (monotonicNow() < deadline)
    {
        try
        {
            process.kill(resolvedPid, 0);
            spawnSync('sleep', ['0.2']);
        }
        catch
        {
            if (pidFile && fs.existsSync(pidFile))
            {
                fs.unlinkSync(pidFile);
            }
            return { status: 'stopped', pid: resolvedPid };
        }
    }
    try
    {
        process.kill(resolvedPid, 'SIGKILL');
    }
    catch
    {
        // The owned process may already have exited.
    }
    if (pidFile && fs.existsSync(pidFile))
    {
        fs.unlinkSync(pidFile);
    }
    return { status: 'killed', pid: resolvedPid };
}

export function resolveRunRootFromPlanRoots(roots)
{
    // searchRoot is .tmp/scale/<runId>/search → run root is its parent
    const searchRoot = roots?.searchRoot;
    if (!searchRoot)
    {
        throw new Error('runtime plan roots.searchRoot is required to resolve product WebRoot');
    }
    return path.dirname(searchRoot);
}


async function main(argv = process.argv.slice(2))
{
    const command = argv[0];
    if (command === 'start-live')
    {
        const repositoryRoot = argv[1] || process.cwd();
        const envFile = argv[2];
        const logFile = argv[3];
        const pidFile = argv[4];
        const planPath = process.env.FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH;
        if (!planPath)
        {
            throw new Error('FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH required to start product backend');
        }
        const plan = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, planPath), 'utf8'));
        const ports = resolveDedicatedHostPorts({
            postgresContainerName: process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME,
            redisContainerName: process.env.FSUSBLOG_REDIS_CONTAINER_NAME
        });
        const runRoot = resolveRunRootFromPlanRoots(plan.roots);
        // Dedicated runtime must not inherit shared/dev BASE_URL (e.g. :7568).
        const baseUrl = `http://127.0.0.1:${DATA_SCALE_PRODUCT_BACKEND_PORT}`;
        const environment = buildProductBackendEnvironment({
            repositoryRoot,
            postgresHostPort: ports.postgresHostPort,
            redisHostPort: ports.redisHostPort,
            runRoot,
            baseUrl,
            namespace: process.env.FSUSBLOG_TEST_NAMESPACE || 'data-scale'
        });
        writeProductBackendEnvironmentFile(envFile, environment);
        const started = startProductBackendProcess({
            repositoryRoot,
            environment,
            logFile,
            pidFile
        });
        await waitForBackendLive(started.baseUrl, { timeoutMs: 180_000 });
        process.stdout.write(`${JSON.stringify({
            status: 'live',
            pid: started.pid,
            baseUrl: started.baseUrl,
            runRoot,
            postgresHostPort: ports.postgresHostPort,
            redisHostPort: ports.redisHostPort
        })}\n`);
        return;
    }
    if (command === 'stop')
    {
        const pidFile = argv[1];
        const result = stopProductBackendProcess({ pidFile });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    throw new Error(`unknown product-backend command: ${command || '<empty>'}`);
}

const isDirectCli = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectCli)
{
    main().catch((error) =>
    {
        process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
