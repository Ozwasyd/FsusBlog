import process from 'node:process';

import {
    failClosedProductionBuildLayout,
    finalizeProductionBuildLayout,
    prepareProductionBuildLayout
} from './production-build-layout.mjs';

export const productionBuildLifecycleAdapters = {
    failClosed: failClosedProductionBuildLayout,
    finalize: finalizeProductionBuildLayout,
    prepare: prepareProductionBuildLayout
};

function interruptedError(signal, exitCode)
{
    const error = new Error(`production build interrupted by ${signal}`);
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    error.exitCode = exitCode;
    error.signal = signal;
    return error;
}

function failureStatus(error)
{
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ? 'cancelled' : 'failure';
}

function schedulerFailure(result)
{
    if (!result || result.status === 'success')
    {
        return null;
    }
    const failure = result.failure ?? {};
    const error = new Error(failure.reason ?? 'production build scheduler failed');
    error.name = 'SchedulerFailure';
    error.exitCode = Number(failure.exitCode) || 1;
    error.signal = typeof failure.signal === 'string' ? failure.signal : null;
    error.tierId = typeof failure.tierId === 'string' ? failure.tierId : null;
    return error;
}

function attachSecondaryFailure(primary, property, secondary)
{
    if (!primary || !secondary)
    {
        return;
    }
    try
    {
        primary[property] = secondary;
    }
    catch
    {}
}

export async function runProductionBuildLifecycle(
    {
        prepareOptions,
        execute,
        adapters = productionBuildLifecycleAdapters,
        signalEmitter = process,
        logger = console
    } = {}
)
{
    if (typeof execute !== 'function')
    {
        throw new Error('production build lifecycle requires an execute callback');
    }
    const buildLayout = adapters.prepare(prepareOptions);
    let buildManifest = null;
    let finalization = null;
    let interrupted = null;
    let operationError = null;
    let operationResult;
    let primaryFailure = null;
    let sealFailure = null;
    let fallbackFailure = null;
    let sealed = false;
    const afterFinalizeCallbacks = [];
    const signalHandlers = new Map();

    const setFinalization = (options) =>
    {
        if (!options || !['success', 'failure', 'cancelled'].includes(options.status))
        {
            throw new Error('production build lifecycle requires an explicit final status');
        }
        finalization = { ...options };
        if (options.primaryFailure)
        {
            primaryFailure = options.primaryFailure;
        }
    };
    const recordSchedulerResult = (result) =>
    {
        const failure = schedulerFailure(result);
        if (failure)
        {
            primaryFailure = failure;
            finalization = { status: failure.signal ? 'cancelled' : 'failure', primaryFailure: failure };
        }
        return result;
    };
    const throwIfInterrupted = () =>
    {
        if (interrupted)
        {
            throw interrupted;
        }
    };
    const afterFinalize = (callback) =>
    {
        if (typeof callback !== 'function')
        {
            throw new Error('production build lifecycle afterFinalize callback must be a function');
        }
        afterFinalizeCallbacks.push(callback);
    };

    for (const [signal, exitCode] of [
        ['SIGINT', 130],
        ['SIGTERM', 143]
    ])
    {
        const handler = () =>
        {
            interrupted ??= interruptedError(signal, exitCode);
        };
        signalHandlers.set(signal, handler);
        signalEmitter.on(signal, handler);
    }

    try
    {
        try
        {
            try
            {
                operationResult = await execute({
                    afterFinalize,
                    buildLayout,
                    recordSchedulerResult,
                    setFinalization,
                    throwIfInterrupted
                });
                throwIfInterrupted();
                if (!finalization)
                {
                    throw new Error('production build lifecycle completed without declaring a final status');
                }
            }
            catch (error)
            {
                const observedError = interrupted ?? error;
                if (primaryFailure?.name === 'SchedulerFailure' && observedError !== primaryFailure)
                {
                    attachSecondaryFailure(primaryFailure, 'productionBuildPostRunError', observedError);
                    operationError = primaryFailure;
                }
                else
                {
                    operationError = observedError;
                    primaryFailure ??= operationError;
                }
                finalization = {
                    ...(finalization ?? {}),
                    status: interrupted ? 'cancelled' : failureStatus(operationError),
                    primaryFailure
                };
            }

        }
        finally
        {
            if (!finalization)
            {
                operationError ??= new Error('production build lifecycle lost its final status');
                primaryFailure ??= operationError;
                finalization = { status: failureStatus(operationError), primaryFailure };
            }
            const { primaryFailure: _primaryFailure, ...finalizeOptions } = finalization;
            try
            {
                buildManifest = adapters.finalize(buildLayout, finalizeOptions);
                sealed = true;
            }
            catch (error)
            {
                sealFailure = error;
                try
                {
                    buildManifest = adapters.failClosed(buildLayout, {
                        status: finalization.status === 'cancelled' ? 'cancelled' : 'failure',
                        primaryFailure,
                        sealFailure
                    });
                    sealed = true;
                }
                catch (fallbackError)
                {
                    fallbackFailure = fallbackError;
                }
            }

            if (sealFailure)
            {
                attachSecondaryFailure(primaryFailure, 'productionBuildFinalizeError', sealFailure);
                try
                {
                    logger.error(`[matrix:build-layout] secondary seal failure: ${sealFailure.message}`);
                }
                catch
                {}
            }
            if (fallbackFailure)
            {
                attachSecondaryFailure(primaryFailure, 'productionBuildFallbackError', fallbackFailure);
                try
                {
                    logger.error(
                        `[matrix:build-layout] fail-closed terminalization failed: ${fallbackFailure.message}`
                    );
                }
                catch
                {}
            }
        }

        if (sealed)
        {
            for (const callback of afterFinalizeCallbacks)
            {
                try
                {
                    await callback(buildManifest);
                }
                catch (error)
                {
                    if (!operationError && !primaryFailure)
                    {
                        operationError = error;
                    }
                    else
                    {
                        logger.error(`[matrix:build-layout] secondary post-seal failure: ${error.message}`);
                    }
                }
            }
        }
    }
    finally
    {
        for (const [signal, handler] of signalHandlers)
        {
            signalEmitter.off(signal, handler);
        }
        signalHandlers.clear();
    }

    if (operationError)
    {
        throw operationError;
    }
    if (fallbackFailure && !primaryFailure)
    {
        throw fallbackFailure;
    }
    if (sealFailure && !primaryFailure)
    {
        throw sealFailure;
    }
    return {
        buildLayout,
        buildManifest,
        operationResult,
        primaryFailure,
        sealFailure
    };
}
