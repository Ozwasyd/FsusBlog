import fs from 'node:fs';
import path from 'node:path';

const {verifyBoundRuntimeListeners} = await import(new URL('../../test-matrix/production-fresh-port-lease.mjs', import.meta.url));

const allowedRuntimeEnvironmentKeys = new Set([
    'FSUSBLOG_TEST_NAMESPACE',
    'FSUSBLOG_POSTGRES_PORT',
    'FSUSBLOG_REDIS_PORT',
    'FSUSBLOG_DEBUG_BACKEND_PORT',
    'FSUSBLOG_DEBUG_FRONTEND_PORT',
    'FSUSBLOG_RELEASE_PREVIEW_PORT',
    'FSUSBLOG_DEBUG_FRONTEND_URL',
    'FSUSBLOG_DEBUG_BACKEND_URL',
    'FSUSBLOG_RELEASE_PREVIEW_URL',
    'FSUSBLOG_POSTGRES_CONTAINER_NAME',
    'FSUSBLOG_REDIS_CONTAINER_NAME',
    // Bootstrap writes host port-lease bookkeeping into the namespace env file
    // so a later bootstrap resume can reattach to the same reservation daemon.
    'FSUSBLOG_PORT_LEASED_ROLES',
    'FSUSBLOG_PORT_LEASE_DAEMON_PID',
    'FSUSBLOG_PORT_LEASE_MANIFEST_FILE',
    'FSUSBLOG_NOTIFICATION_DRILL_SECRET',
    'FSUSBLOG_DATA_ROOT',
    'FSUSBLOG_RELEASE_DERIVED_ROOT',
    'FSUSBLOG_RELEASE_ID',
    'FSUSBLOG_PUBLIC_ID_PROJECTION_FILE',
    'FSUSBLOG_FIXTURE_SERVICE_GENERATION',
    'FSUSBLOG_RUNTIME_CONFIGURATION',
    'FSUSBLOG_RUNTIME_NO_BUILD',
    // Bootstrap writes scheduler / multi-node / browser-contract identity into the
    // namespace env file. The runtime-browser loader must accept these keys so
    // post-bootstrap steps inherit the same run binding bootstrap sealed.
    'FSUSBLOG_TEST_RUN_ID',
    'FSUSBLOG_PHYSICAL_BUNDLE_ID',
    'FSUSBLOG_STEP_ID',
    'FSUSBLOG_TEST_RUNTIME_MODE',
    'FSUSBLOG_TEST_NODE_COUNT',
    'FSUSBLOG_TEST_ARTIFACT_STORAGE',
    'FSUSBLOG_TEST_COORDINATION_STORE',
    'FSUSBLOG_TEST_CLUSTER_SCENARIO',
    'FSUSBLOG_TEST_CLUSTER_BOOTSTRAP',
    'FSUSBLOG_TEST_CLUSTER_FIXTURES',
    'FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME',
    'FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID',
    'ConnectionStrings__DefaultConnection',
    'ConnectionStrings__Redis',
    'RedisOptions__Configuration',
    'RedisOptions__InstanceName',
    'NotificationStream__DrillSecret',
    'Jwt__KeyVersion',
    'Jwt__SecretKey',
    'Jwt__Issuer',
    'Jwt__Audience',
    'Jwt__AccessTokenExpiresMinutes',
    'Jwt__RotationWindowDays',
    'Jwt__LegacyNoKidAcceptUntilUtc',
    'Security__Pow__SigningKey',
    'Security__Pow__BaseDifficulty',
    'Security__Pow__MaxDifficulty',
    'Security__PerceptionSealedToken__CurrentKeyVersion',
    'Security__PerceptionSealedToken__Keys__dev',
    'Security__RecoveryKeyPepper',
    'MfaChallenge__TicketSigningKey',
    'HumanReadProof__SigningKey',
    'HumanReadProof__Dedup__CurrentKey',
    'ReadAnalyticsPrivacy__NoiseKey',
    'VisitLog__IpPseudonymization__CurrentEpoch',
    'VisitLog__IpPseudonymization__CurrentKey',
    'Moderation__Pepper',
    'Moderation__RegionPolicy__IpHashKey',
    'Subscription__EmailHashPepper',
    'AnonymousCredentialIssuer__IssuerPublicKeyId',
    'AnonymousCredentialIssuer__SubjectHashPepper',
    'AnonymousCredentialRoot__AttestationKey',
    'AnonymousCredentialRoot__AttestationKeyId',
    'AnonymousIdentity__NullifierPepper',
    'FSUSBLOG_ANONYMOUS_IDENTITY_MODE',
    'Security__RiskControl__PublicReadChallenge__Enabled',
    'RateLimiting__PublicReadPermitLimit',
    'RateLimiting__PublicReadQueueLimit',
    'NotificationStream__MaxConnectionsPerAccount',
    'PublicAot__BackfillConcurrency',
    'PublicAot__SsrWorkerCount',
    'PublicAot__SsrClientRoot',
    'PublicAot__SsrWorkerScript',
    'ActiveReleaseFence__AllowSyntheticLocalFence',
    'RuntimeTuning__ThreadPool__Enabled',
    'RuntimeTuning__ThreadPool__MinThreadsPerCpu',
    'ASPNETCORE_URLS',
    'ASPNETCORE_ENVIRONMENT',
    'Testing__EnforceProductionCsp',
    'CORS_ALLOWED_HOSTS',
    'AuthCookies__AllowInsecureTransportCookies'
]);

const runtimeUrlBindings = [
    ['FSUSBLOG_DEBUG_BACKEND_URL', 'FSUSBLOG_DEBUG_BACKEND_PORT'],
    ['FSUSBLOG_DEBUG_FRONTEND_URL', 'FSUSBLOG_DEBUG_FRONTEND_PORT'],
    ['FSUSBLOG_RELEASE_PREVIEW_URL', 'FSUSBLOG_RELEASE_PREVIEW_PORT']
];

function validateRuntimeUrl(environment, urlKey, portKey)
{
    const rawUrl = environment[urlKey];
    const rawPort = environment[portKey];
    if (!rawUrl || !rawPort)
    {
        throw new Error(`runtime environment is missing ${urlKey} or ${portKey}`);
    }
    const port = Number.parseInt(rawPort, 10);
    if (!/^\d+$/u.test(rawPort) || port < 1 || port > 65535)
    {
        throw new Error(`runtime environment has an invalid ${portKey}`);
    }
    let parsed;
    try
    {
        parsed = new URL(rawUrl);
    }
    catch
    {
        throw new Error(`runtime environment has an invalid ${urlKey}`);
    }
    if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== String(port)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash)
    {
        throw new Error(`runtime environment ${urlKey} is not bound to loopback ${portKey}`);
    }
}

export function parseRuntimeEnvironment(contents, expectedNamespace)
{
    const namespace = String(expectedNamespace ?? '').trim();
    if (!namespace || !/^[a-z0-9][a-z0-9_.-]*$/u.test(namespace))
    {
        throw new Error('runtime environment expected namespace is invalid');
    }
    const environment = {};
    for (const [lineIndex, line] of String(contents).split(/\r?\n/u).entries())
    {
        if (!line)
        {
            continue;
        }
        const separator = line.indexOf('=');
        if (separator < 1)
        {
            throw new Error(`runtime environment line ${lineIndex + 1} is malformed`);
        }
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !allowedRuntimeEnvironmentKeys.has(key))
        {
            throw new Error(`runtime environment key is not allowed: ${key}`);
        }
        if (Object.hasOwn(environment, key))
        {
            throw new Error(`runtime environment key is duplicated: ${key}`);
        }
        if (value.includes('\0'))
        {
            throw new Error(`runtime environment value contains NUL: ${key}`);
        }
        environment[key] = value;
    }
    if (environment.FSUSBLOG_TEST_NAMESPACE !== namespace)
    {
        throw new Error(`runtime environment namespace does not match current run: ${environment.FSUSBLOG_TEST_NAMESPACE ?? '<missing>'}`);
    }
    for (const [urlKey, portKey] of runtimeUrlBindings)
    {
        validateRuntimeUrl(environment, urlKey, portKey);
    }
    return environment;
}

export function readRuntimeEnvironment(root, expectedNamespace)
{
    const namespace = String(expectedNamespace ?? '').trim();
    const resolvedRoot = path.resolve(root);
    const configuredEnvironmentRoot = String(process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT ?? '').trim();
    const environmentRoot = configuredEnvironmentRoot
        ? path.resolve(configuredEnvironmentRoot)
        : path.join(resolvedRoot, '.tmp', 'env');
    const environmentFile = path.join(environmentRoot, `${namespace}.env`);
    const resolvedFile = path.resolve(environmentFile);
    if ((environmentRoot !== resolvedRoot && !environmentRoot.startsWith(`${resolvedRoot}${path.sep}`))
        || path.dirname(resolvedFile) !== environmentRoot)
    {
        throw new Error('runtime environment path escapes the repository namespace directory');
    }
    if (!fs.existsSync(resolvedFile))
    {
        throw new Error(`runtime environment file is missing: ${path.relative(resolvedRoot, resolvedFile)}`);
    }
    const stat = fs.lstatSync(resolvedFile);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`runtime environment file must be a regular non-symlink file: .tmp/env/${namespace}.env`);
    }
    return parseRuntimeEnvironment(fs.readFileSync(resolvedFile, 'utf8'), namespace);
}

export async function assertProductionFreshReadiness({environment, runId, namespace})
{
    const file = environment.FSUSBLOG_PORT_LEASE_MANIFEST_FILE;
    if (!file || !path.isAbsolute(file))
    {
        throw new Error('Production Fresh consumer requires its explicit current-run port lease manifest');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let manifest;
    try
    {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
            (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024)
        {
            throw new Error('Production Fresh consumer manifest must be a bounded task-private regular file');
        }
        manifest = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    return verifyBoundRuntimeListeners({manifest, runId, namespace, requireReadiness: true});
}
