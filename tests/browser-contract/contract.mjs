import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const browserContractReceiptSchema = 'fsusblog.browser-contract-receipt.v2';

export const browserContractScenarios = Object.freeze([
    Object.freeze({
        id: 'public-hydration-history-reload',
        role: 'anonymous',
        capability: 'public-hydration',
        serviceWorkers: 'allow'
    }),
    Object.freeze({
        id: 'account-deep-link-bootstrap',
        role: 'user',
        capability: 'account-session',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'admin-deep-link-expired-session',
        role: 'admin',
        capability: 'admin-session',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'article-publish-persistence',
        role: 'admin',
        capability: 'critical-write',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'webauthn-virtual-authenticator',
        role: 'user',
        capability: 'webauthn',
        serviceWorkers: 'block'
    }),
    Object.freeze({
        id: 'service-worker-offline-reload',
        role: 'anonymous',
        capability: 'service-worker',
        serviceWorkers: 'allow'
    })
]);

export function selectBrowserContractScenarios(capabilities = {})
{
    const selected = browserContractScenarios.filter((scenario) => (
        scenario.capability !== 'webauthn' || capabilities.webAuthnRegistration === true
    ));
    contractAssert(selected.length >= 4 && selected.length <= 6, 'browser contract selected scenario count must stay between four and six');
    return Object.freeze(selected);
}

export class BrowserContractFailure extends Error
{
    constructor(message, failureClass = 'contract', details = null)
    {
        super(message);
        this.name = 'BrowserContractFailure';
        this.failureClass = failureClass;
        this.details = details;
    }
}

export function contractAssert(condition, message, details = null)
{
    if (!condition)
    {
        throw new BrowserContractFailure(message, 'contract', details);
    }
}

export function productAssert(condition, message, details = null)
{
    if (!condition)
    {
        throw new BrowserContractFailure(message, 'product', details);
    }
}

export function classifyBrowserContractFailure(error, options = {})
{
    if (error instanceof BrowserContractFailure)
    {
        return error.failureClass;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (options.browserDisconnected === true
    || /browser (?:has been )?closed|browser disconnected|browser process|browserType\.launch|crash|target (?:page, context or browser )?has been closed|Target closed/iu.test(message))
    {
        return 'infra';
    }
    return 'product';
}

export function serializeBrowserContractError(error)
{
    if (!error)
    {
        return null;
    }
    return {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        failureClass: classifyBrowserContractFailure(error),
        details: error instanceof BrowserContractFailure ? error.details : null,
        stack: error instanceof Error ? error.stack ?? null : null
    };
}

function snapshot(value)
{
    return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function finalizationDecision({ primary, cleanup, cleanupAttempts = [], signal = null })
{
    contractAssert(primary?.status === 'success' || primary?.status === 'failure', 'browser contract primary outcome is invalid');
    if (primary.status === 'success')
    {
        contractAssert(primary.classification === 'clean' && primary.error === null, 'browser contract successful primary outcome must be clean');
    }
    else
    {
        contractAssert(['product', 'contract', 'infra'].includes(primary.classification), 'browser contract primary failure classification is invalid');
        contractAssert(primary.error && typeof primary.error === 'object', 'browser contract primary failure error is missing');
    }
    contractAssert(cleanup === null || ['success', 'failure'].includes(cleanup?.status), 'browser contract cleanup outcome is invalid');
    contractAssert(Array.isArray(cleanupAttempts), 'browser contract cleanup attempts must be an array');
    contractAssert(cleanupAttempts.every((attempt) => ['success', 'failure'].includes(attempt?.status)), 'browser contract cleanup attempt status is invalid');
    return snapshot({ primary, cleanup, cleanupAttempts, signal });
}

export function finalizeBrowserContractReceipt(receipt, {
    primary,
    cleanup = null,
    cleanupAttempts = cleanup ? [cleanup] : [],
    signal = null,
    finishedAt = new Date().toISOString(),
    wallClockMs = 0
})
{
    const decision = finalizationDecision({ primary, cleanup, cleanupAttempts, signal });
    const decisionIdentity = `sha256:${createHash('sha256').update(JSON.stringify(decision)).digest('hex')}`;
    if (receipt.finalization)
    {
        contractAssert(
            receipt.finalization.decisionIdentity === decisionIdentity,
            'browser contract receipt finalization conflicts with its authoritative terminal outcome'
        );
        return receipt;
    }

    const cleanupFailed = cleanup?.status === 'failure';
    const primaryFailed = primary.status === 'failure';
    const status = primaryFailed || cleanupFailed ? 'failure' : 'success';
    const classification = primaryFailed ? primary.classification : cleanupFailed ? 'contract' : 'clean';
    const error = primaryFailed
        ? snapshot(primary.error)
        : cleanupFailed
      ? {
          name: 'BrowserContractFailure',
          message: 'browser contract fixture cleanup failed',
          failureClass: 'contract',
          details: snapshot(cleanup.error),
          stack: null,
          activeScenario: null,
          signal
        }
      : null;

    receipt.fixture = {
        ...(receipt.fixture ?? {}),
        cleanup: snapshot(cleanup),
        cleanupAttempts: snapshot(cleanupAttempts)
    };
    receipt.status = status;
    receipt.classification = classification;
    receipt.error = error;
    receipt.finishedAt = finishedAt;
    receipt.wallClockMs = wallClockMs;
    receipt.finalization = {
        state: 'complete',
        decisionIdentity,
        primary: snapshot(primary),
        cleanup: cleanup === null
            ? { status: 'not-required', attemptCount: 0, error: null }
            : {
          status: cleanup.status,
          attemptCount: cleanupAttempts.length,
          error: cleanupFailed ? snapshot(cleanup.error) : null
        },
        signal,
        persistence: {
            attemptCount: 0,
            priorFailures: []
        }
    };
    return receipt;
}

const persistedTerminalReceipts = new WeakSet();

export async function persistFinalBrowserContractReceipt(receipt, writeReceipt, { maxAttempts = 2 } = {})
{
    contractAssert(receipt?.finalization?.state === 'complete', 'browser contract receipt must be finalized before persistence');
    contractAssert(typeof writeReceipt === 'function', 'browser contract receipt writer is missing');
    contractAssert(Number.isInteger(maxAttempts) && maxAttempts > 0, 'browser contract receipt persistence attempts are invalid');
    if (persistedTerminalReceipts.has(receipt))
    {
        return receipt;
    }

    const priorFailures = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1)
    {
        receipt.finalization.persistence = {
            attemptCount: attempt,
            priorFailures: snapshot(priorFailures)
        };
        try
        {
            await writeReceipt(receipt);
            persistedTerminalReceipts.add(receipt);
            return receipt;
        }
        catch (error)
        {
            priorFailures.push(serializeBrowserContractError(error));
        }
    }
    throw Object.assign(
        new BrowserContractFailure('browser contract final receipt persistence failed', 'contract', { attempts: priorFailures }),
        { receipt }
    );
}

export function createBrowserContractReceipt({
    sourceState = null,
    build = null,
    fixture = null,
    playwright = null,
    scenarios = browserContractScenarios,
    startedAt = new Date().toISOString()
} = {})
{
    return {
        schema: browserContractReceiptSchema,
        status: 'running',
        classification: null,
        runIdentity: fixture?.lifecycle?.identity ?? null,
        sourceState,
        build,
        fixture,
        playwright,
        topology: {
            runner: 'playwright-library',
            browserType: 'chromium',
            managedBrowser: true,
            workerPool: false,
            shard: null,
            retries: 0,
            browserLaunchCount: 0,
            maxConcurrentBrowserRoots: 0,
            contextCount: 0
        },
        scenarios: scenarios.map((scenario) => ({
            id: scenario.id,
            capability: scenario.capability,
            status: 'pending',
            classification: null,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            issues: [],
            artifacts: [],
            error: null
        })),
        startedAt,
        finishedAt: null,
        wallClockMs: null,
        error: null
    };
}

export async function writeBrowserContractReceipt(file, receipt)
{
    const target = path.resolve(file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700);
    const temporary = `${target}.next-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
}
