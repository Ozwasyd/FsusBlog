/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs';

import { normalizeRuntimeIdentity } from './contract.mjs';
import { RuntimeExecutionSession } from './runtime-execution-session.mjs';

function writeExclusive(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function run(command, args, { cwd, env, signal, logFile })
{
    return new Promise((resolve, reject) =>
    {
        const output = fs.createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
        const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(output, { end: false });
        child.stderr.pipe(output, { end: false });
        const abort = () =>
        {
            if (child.exitCode == null)
            {
                process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');
            }
        };
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', (error) =>
        {
            signal?.removeEventListener('abort', abort);
            output.end();
            reject(error);
        });
        child.once('close', (code, childSignal) =>
        {
            signal?.removeEventListener('abort', abort);
            output.end(() =>
            {
                if (code === 0 && !childSignal)
                {
                    resolve();
                }
                else
                {
                    reject(new Error(`production runtime bundle failed code=${code ?? 'null'} signal=${childSignal ?? 'none'} log=${logFile}`));
                }
            });
        });
    });
}

function assertBinding(binding)
{
    for (const operation of [
        'immutableIdentity',
        'createSessionAdapters',
        'createProductionSnapshotContext',
        'verifyProductionResetPostconditions',
        'verifyProductionCoordination'
    ])
    {
        if (operation === 'immutableIdentity')
        {
            if (!binding[operation] || typeof binding[operation] !== 'object')
            {
                throw new Error('runtime-order binding lacks immutableIdentity');
            }
        }
        else if (typeof binding[operation] !== 'function')
        {
            throw new Error(`runtime-order binding lacks ${operation}()`);
        }
    }
    const maxConcurrency = Number(binding.maxConcurrency ?? os.availableParallelism?.() ?? os.cpus().length);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 2)
    {
        throw new Error('runtime-order binding maxConcurrency must prove cap > 1');
    }
    return maxConcurrency;
}

export async function createRuntimeOrderProvider()
{
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const bindingPath = path.resolve(
        String(process.env.FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE ?? '').trim()
      || path.join(repositoryRoot, 'tools', 'test-runtime', 'production-current-run-binding.mjs')
    );
    if (!bindingPath.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error('runtime-order binding module must remain inside the repository');
    }
    const bindingStat = fs.lstatSync(bindingPath);
    if (!bindingStat.isFile() || bindingStat.isSymbolicLink())
    {
        throw new Error('runtime-order binding module must be a regular non-symlink file');
    }
    const binding = await import(`${pathToFileURL(bindingPath).href}?provider=${process.pid}`);
    const maxConcurrency = assertBinding(binding);
    const immutableIdentity = Object.freeze({ ...binding.immutableIdentity });
    const sessionRoot = path.resolve(
        String(process.env.FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT ?? '').trim()
      || path.join(repositoryRoot, '.tmp', 'runtime-order-sessions')
    );
    if (!sessionRoot.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error('runtime-order session root must remain inside the repository');
    }
    const sessions = new Map();

    return Object.freeze({
        immutableIdentity,
        maxConcurrency,
        async createSession({ plan, immutableIdentity: expected, signal })
        {
            const expectedTemplate = normalizeRuntimeIdentity({ ...immutableIdentity, sessionId: 'schedule-template' });
            if (digestCanonical(normalizeRuntimeIdentity(expected)) !== digestCanonical(expectedTemplate))
            {
                throw new Error(`${plan.planId} immutable runtime-order identity drifted`);
            }
            const created = await binding.createSessionAdapters({ plan, immutableIdentity, sessionRoot, signal });
            if (!created || !Array.isArray(created.domains) || !created.adapters)
            {
                throw new Error(`${plan.planId} production binding returned no exact session adapters`);
            }
            const session = await RuntimeExecutionSession.create({
                sessionRoot,
                runId: immutableIdentity.runId,
                attemptId: `${immutableIdentity.attemptId}-${plan.planId}`,
                immutableInputs: immutableIdentity,
                domains: created.domains,
                adapters: created.adapters,
                signal
            });
            const receipt = session.receipt();
            const evidenceRoot = path.join(session.ownedRoot, 'evidence');
            const receiptFile = path.join(evidenceRoot, 'session-receipt.json');
            writeExclusive(receiptFile, receipt);
            sessions.set(session.identity.sessionId, { session, receipt, receiptFile });
            return Object.freeze({ identity: session.identity, receipt, receiptFile, ownedRoot: session.ownedRoot });
        },
        async executePlan({ plan, session, signal })
        {
            const owned = sessions.get(session?.identity?.sessionId);
            if (!owned || digestCanonical(owned.session.identity) !== digestCanonical(session.identity))
            {
                throw new Error(`${plan.planId} references a stale or cross-session production runtime`);
            }
            const evidenceRoot = path.join(owned.session.ownedRoot, 'evidence');
            const planFile = path.join(evidenceRoot, 'schedule-plan.json');
            const resultFile = path.join(evidenceRoot, 'runtime-order-execution.json');
            const logFile = path.join(evidenceRoot, 'runtime-browser.log');
            const observerFingerprintKeyFile = path.join(evidenceRoot, 'observer-fingerprint.key');
            const observerAuthorityFile = path.join(evidenceRoot, 'production-observer-authority.json');
            const publicAotWarmReport = path.join(evidenceRoot, 'public-aot-warm-evidence.json');
            fs.writeFileSync(observerFingerprintKeyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
            writeExclusive(planFile, plan);
            const namespace = `order-${owned.session.identity.sessionId}`.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').slice(0, 48);
            let result = null;
            let primaryFailure = null;
            try
            {
                const runtimeEnvironment = typeof binding.productionRuntimeEnvironment === 'function'
                    ? await binding.productionRuntimeEnvironment({ identity: owned.session.identity, plan })
                    : null;
                if (!runtimeEnvironment || typeof runtimeEnvironment !== 'object')
                {
                    throw new Error(`${plan.planId} production binding returned no sealed replay environment`);
                }
                await run(path.join(repositoryRoot, 'tools/test/bundles/runtime-browser.sh'), [], {
                    cwd: repositoryRoot,
                    signal,
                    logFile,
                    env: {
                        ...process.env,
                        ...runtimeEnvironment,
                        FSUSBLOG_TEST_RUN_ID: immutableIdentity.runId,
                        FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID: owned.session.identity.attemptId,
                        FSUSBLOG_TEST_SOURCE_COMMIT: immutableIdentity.sourceCommit,
                        FSUSBLOG_TEST_SOURCE_FINGERPRINT: immutableIdentity.sourceFingerprint,
                        FSUSBLOG_TEST_NAMESPACE: namespace,
                        FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME: '1',
                        FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID: owned.session.identity.sessionId,
                        FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: path.join(
                            owned.session.ownedRoot,
                            'mutable',
                            'production-fresh',
                            immutableIdentity.runId,
                            'attempts',
                            owned.session.identity.attemptId
                        ),
                        FSUSBLOG_RUNTIME_SCHEDULE_PLAN: planFile,
                        FSUSBLOG_RUNTIME_SESSION_RECEIPT: owned.receiptFile,
                        FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE: bindingPath,
                        FSUSBLOG_RUNTIME_ORDER_RESULT_FILE: resultFile,
                        FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT: owned.session.ownedRoot,
                        FSUSBLOG_RUNTIME_ORDER_FINGERPRINT_KEY_FILE: observerFingerprintKeyFile,
                        FSUSBLOG_RUNTIME_ORDER_AUTHORITY_FILE: observerAuthorityFile,
                        FSUSBLOG_PUBLIC_AOT_WARM_REPORT: publicAotWarmReport,
                        FSUSBLOG_ACCEPTANCE_OUTPUT_ROOT: path.join(owned.session.ownedRoot, 'mutable', 'acceptance'),
                        FSUSBLOG_ACCEPTANCE_ENV_ROOT: path.join(owned.session.ownedRoot, 'mutable', 'env'),
                        FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT: path.join(owned.session.ownedRoot, 'mutable', 'fixtures'),
                        FSUSBLOG_DATA_ROOT: path.join(owned.session.ownedRoot, 'mutable', 'data')
                    }
                });
                if (!fs.existsSync(resultFile))
                {
                    throw new Error(`${plan.planId} production runtime emitted no execution result`);
                }
                result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
                if (result.planDigest !== plan.contentDigest || result.identity?.sessionId !== session.identity.sessionId)
                {
                    throw new Error(`${plan.planId} production runtime result identity drifted`);
                }
                await owned.session.postflight({ signal });
            }
            catch (error)
            {
                primaryFailure = error;
            }
            let cleanupReceipt;
            try
            {
                cleanupReceipt = await owned.session.cleanup({
                    reason: primaryFailure ? `schedule-failed:${plan.planId}` : `schedule-complete:${plan.planId}`,
                    signal
                });
            }
            catch (cleanupError)
            {
                if (primaryFailure)
                {
                    throw new AggregateError(
                        [primaryFailure, cleanupError],
                        `${plan.planId} execution and cleanup failed`,
                        { cause: cleanupError }
                    );
                }
                throw cleanupError;
            }
            finally
            {
                sessions.delete(session.identity.sessionId);
            }
            if (primaryFailure)
            {
                throw primaryFailure;
            }
            return Object.freeze({
                ...result,
                lifecycleRefs: [...(result.lifecycleRefs ?? []), owned.receiptFile, cleanupReceipt.receiptDigest]
            });
        }
    });
}

export default createRuntimeOrderProvider;
