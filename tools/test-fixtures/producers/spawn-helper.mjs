import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveTemporalRolesForProducerIfBound } = await import(new URL('../../test/temporal-role-resolver.mjs', import.meta.url));
export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporalChildObserver = path.join(
    repositoryRoot,
    'tools/test-fixtures/producers/temporal-child-observer.mjs'
);

/**
 * Run a child process bound to AbortSignal. On abort, SIGTERM then SIGKILL,
 * retaining the original failure until the owned child actually closes.
 * Strategy/capability are not read from env — only resource handles may be forwarded.
 */
export function runProcess(command, args, {
    cwd = repositoryRoot,
    env = process.env,
    signal = undefined,
    timeoutMs = 600_000
} = {})
{
    return new Promise((resolve, reject) =>
    {
        if (signal?.aborted)
        {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            return;
        }
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let terminationError = null;
        let escalationTimer = null;
        const timer = timeoutMs > 0
            ? setTimeout(() => requestTermination(
                new Error(`producer process timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`)
            ), timeoutMs)
            : null;

        const onAbort = () =>
        {
            requestTermination(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (signal?.aborted)
        {
            onAbort();
        }

        child.stdout?.on('data', (chunk) =>
        {
            stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) =>
        {
            stderr += String(chunk);
        });
        child.on('error', (error) =>
        {
            if (!child.pid)
            {
                finish(error);
            }
            else
            {
                requestTermination(error);
            }
        });
        child.on('close', (code, deathSignal) =>
        {
            if (terminationError)
            {
                finish(terminationError);
            }
            else if (code === 0)
            {
                finish(null, { code, stdout, stderr });
            }
            else
            {
                finish(new Error(
                    `producer process failed (code=${code}${deathSignal ? ` signal=${deathSignal}` : ''}): ${command} ${args.join(' ')}\n${stderr || stdout}`
                ));
            }
        });

        function requestTermination(error)
        {
            if (settled || terminationError)
            {
                return;
            }
            terminationError = error;
            if (timer)
            {
                clearTimeout(timer);
            }
            if (child.exitCode !== null || child.signalCode !== null)
            {
                return;
            }
            killTree(child, 'SIGTERM');
            escalationTimer = setTimeout(() =>
            {
                escalationTimer = null;
                if (!settled && child.exitCode === null && child.signalCode === null)
                {
                    killTree(child, 'SIGKILL');
                }
            }, 750);
            escalationTimer.unref?.();
        }

        function finish(error, result)
        {
            if (settled)
            {
                return;
            }
            settled = true;
            if (timer)
            {
                clearTimeout(timer);
            }
            if (escalationTimer)
            {
                clearTimeout(escalationTimer);
            }
            signal?.removeEventListener?.('abort', onAbort);
            if (error)
            {
                reject(error);
            }
            else
            {
                resolve(result);
            }
        }
    });
}

export async function runTemporalProcess(command, args, options = {})
{
    const result = await runProcess(
        process.execPath,
        [temporalChildObserver, '--', command, ...args],
        options
    );
    const encoded = result.stdout.match(/^FSUSBLOG_TEMPORAL_ACTUAL_JSON=([A-Za-z0-9_-]+)$/mu)?.[1];
    if (!encoded)
    {
        throw new Error(`producer child did not return a temporal actual observation: ${command}`);
    }
    let temporalObservation;
    try
    {
        temporalObservation = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    catch
    {
        throw new Error(`producer child returned an invalid temporal actual observation: ${command}`);
    }
    return { ...result, temporalObservation };
}

function killTree(child, sig)
{
    if (!child?.pid)
    {
        return;
    }
    try
    {
        process.kill(-child.pid, sig);
    }
    catch
    {
        try
        {
            child.kill(sig);
        }
        catch
        { /* already dead */ }
    }
}

/**
 * Env for producer children: only resource handles + identity, never strategy overrides.
 */
export function buildProducerChildEnv(context, extra = {})
{
    const handles = context.handles ?? {};
    const env = {
        ...process.env,
        ...extra
    };
    // Strip free-profile / strategy smuggling.
    env.FSUSBLOG_FIXTURE_PROFILE = '';
    delete env.FSUSBLOG_FIXTURE_PRODUCER_STRATEGY;
    delete env.FSUSBLOG_PUBLIC_FIXTURE_STRATEGY;
    delete env.FSUSBLOG_FORCE_DIRECT_DB_SEED;

    if (handles.baseUrl)
    {
        env.FSUSBLOG_BASE_URL = String(handles.baseUrl);
    }
    if (handles.debugBackendUrl)
    {
        env.FSUSBLOG_DEBUG_BACKEND_URL = String(handles.debugBackendUrl);
    }
    if (handles.frontendUrl)
    {
        env.PLAYWRIGHT_BASE_URL = String(handles.frontendUrl);
        env.FSUSBLOG_DEBUG_FRONTEND_URL = String(handles.frontendUrl);
    }
    if (handles.pgContainer)
    {
        env.FSUSBLOG_PG_CONTAINER = String(handles.pgContainer);
    }
    if (handles.redisContainer)
    {
        env.FSUSBLOG_REDIS_CONTAINER = String(handles.redisContainer);
        env.FSUSBLOG_REDIS_CONTAINER_NAME = String(handles.redisContainer);
    }
    if (handles.pgUser)
    {
        env.FSUSBLOG_PG_USER = String(handles.pgUser);
    }
    if (handles.pgDb)
    {
        env.FSUSBLOG_PG_DB = String(handles.pgDb);
    }
    if (context.namespace)
    {
        env.FSUSBLOG_TEST_NAMESPACE = String(context.namespace);
    }
    if (context.runIdentity)
    {
        env.FSUSBLOG_TEST_RUN_ID = String(context.runIdentity);
    }
    if (context.variantPlan?.schema === 'fsusblog.fixture-producer-variant-plan.v1')
    {
        env.FSUSBLOG_FIXTURE_VARIANT_PLAN_JSON = JSON.stringify(context.variantPlan);
        env.FSUSBLOG_FIXTURE_VARIANT_PLAN_DIGEST = String(context.variantPlan.producerVariantPlanDigest);
    }
    else
    {
        throw new Error('producer child requires a sealed typed fixture variant plan');
    }
    if (context.temporalContext)
    {
        delete env.FSUSBLOG_TEMPORAL_CONTEXT_FILE;
        delete env.FSUSBLOG_TEMPORAL_CONTEXT_JSON;
        env.FSUSBLOG_TEMPORAL_CONTEXT_JSON = JSON.stringify(context.temporalContext);
        env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC = context.temporalContext.businessEpochUtc;
        env.FSUSBLOG_TEST_BACKEND_CULTURE = context.temporalContext.backendCulture;
        env.FSUSBLOG_TEST_POSTGRES_TIMEZONE = context.temporalContext.postgresTimezone;
        env.FSUSBLOG_TEST_NODE_TIMEZONE = context.temporalContext.nodeTimezone;
        env.FSUSBLOG_TEST_UI_LOCALE = context.temporalContext.uiLocale;
        env.FSUSBLOG_TEST_LOCALE = context.temporalContext.locale;
        env.FSUSBLOG_TEST_TIMEZONE = context.temporalContext.timezone;
        env.TZ = context.temporalContext.nodeTimezone;
        const temporalRoles = resolveTemporalRolesForProducerIfBound({
            temporalContext: context.temporalContext,
            namespace: String(context.namespace ?? 'default'),
            fixtureId: String(context.variantPlan.producerId ?? context.temporalContext.producerId)
        });
        if (temporalRoles)
        {
            env.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON = JSON.stringify(temporalRoles);
            env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST = temporalRoles.contentDigest;
        }
        else
        {
            delete env.FSUSBLOG_RESOLVED_TEMPORAL_ROLES_JSON;
            delete env.FSUSBLOG_TEMPORAL_ROLE_ARTIFACT_DIGEST;
        }
    }
    if (handles.jwt)
    {
        for (const [key, value] of Object.entries(handles.jwt))
        {
            if (value != null && value !== '')
            {
                env[key] = String(value);
            }
        }
    }
    return env;
}
