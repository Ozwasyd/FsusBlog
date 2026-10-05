// fixture-catalog: consumer browser-contract-prepare acceptance-representative
import { existsSync } from 'node:fs';
import path from 'node:path';

import { serializeBrowserContractError } from './contract.mjs';
import {
    cleanupBrowserContractFixture,
    prepareBrowserContractFixture
} from './fixture-lifecycle.mjs';

export {
    createBrowserContractFixtureApi,
    resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs';

export async function prepareSingleBrowserContractFixture(options = {})
{
    return await prepareBrowserContractFixture(options);
}

export async function cleanupSingleBrowserContractFixture(prepared, options = {})
{
    const { retainRejection = false, ...cleanupOptions } = options;
    try
    {
        return await cleanupBrowserContractFixture(prepared, cleanupOptions);
    }
    catch (error)
    {
        if (!retainRejection)
        {
            throw error;
        }
        // Preserve the owner's refusal and recovery state; this is failed
        // cleanup evidence for finalization, not a successful cleanup or retry.
        const observed = structuredClone(prepared?.lifecycle?.cleanup ?? {});
        const retained = typeof prepared?.root === 'string' && existsSync(prepared.root);
        return {
            ...observed,
            status: 'failure',
            reason: cleanupOptions.reason ?? 'completed',
            attempts: observed.attempts ?? 0,
            finishedAt: new Date().toISOString(),
            error: serializeBrowserContractError(error),
            resources: {
                ...observed.resources,
                files: {
                    status: retained ? 'retained' : 'not-observed',
                    evidence: {
                        root: prepared?.root && prepared?.repoRoot
                            ? path.relative(prepared.repoRoot, prepared.root).replaceAll(path.sep, '/') : null,
                        retainedForRetry: retained
                    }
                }
            }
        };
    }
}
