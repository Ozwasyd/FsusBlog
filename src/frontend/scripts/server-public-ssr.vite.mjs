#!/usr/bin/env node

import { createServer, normalizePath } from 'vite';

import { installSsrDomGlobals, logWorkerError, runPublicSsrWorker } from './server-public-ssr.worker-core.mjs';

async function createRuntime()
{
    installSsrDomGlobals();

    const server = await createServer({
        root: process.cwd(),
        server: {
            middlewareMode: true,
            hmr: false,
            ws: false,
            watch: null
        },
        appType: 'custom',
        configFile: normalizePath(`${process.cwd()}/vite.config.ts`)
    });

    const payloadModule = await server.ssrLoadModule(normalizePath('/src/bootstrap/publicAotBinaryPayload.ts'));
    const rendererModule = await server.ssrLoadModule(normalizePath('/src/public-renderers/renderPublicPage.ts'));

    return {
        server,
        decode: payloadModule.decodePublicAotPayload,
        encode: payloadModule.encodePublicAotPayload,
        buildEntry: rendererModule.buildPublicEntry,
        rendererVersion: rendererModule.PUBLIC_RENDERER_VERSION,
        dispose: async () =>
        {
            await server.close();
        }
    };
}

runPublicSsrWorker(createRuntime).catch((error) =>
{
    logWorkerError(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
