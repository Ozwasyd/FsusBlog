#!/usr/bin/env node

import { access } from 'node:fs/promises';

import { installSsrDomGlobals, logWorkerError, runPublicSsrWorker } from './server-public-ssr.worker-core.mjs';

async function firstExistingBundleUrl()
{
    const candidates = [
        new URL('./public-ssr.mjs', import.meta.url),
        new URL('../dist/server/public-ssr.mjs', import.meta.url)
    ];

    for (const candidate of candidates)
    {
        try
        {
            await access(candidate);
            return candidate;
        }
        catch
        {
        }
    }

    throw new Error('public_aot_ssr_bundle_missing');
}

async function createRuntime()
{
    installSsrDomGlobals();
    const bundleUrl = await firstExistingBundleUrl();
    const rendererModule = await import(bundleUrl.href);

    return {
        decode: rendererModule.decodePublicAotPayload,
        encode: rendererModule.encodePublicAotPayload,
        buildEntry: rendererModule.buildPublicEntry,
        rendererVersion: rendererModule.PUBLIC_RENDERER_VERSION
    };
}

runPublicSsrWorker(createRuntime).catch((error) =>
{
    logWorkerError(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
