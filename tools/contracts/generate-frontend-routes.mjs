#!/usr/bin/env node
import fs from 'node:fs';

import {
    frontendRoutesPath,
    generateFrontendRoutes,
    loadOpenApi
} from './lib/openapi-contracts.mjs';

const check = process.argv.includes('--check');
const text = generateFrontendRoutes(loadOpenApi());

if (check)
{
    const current = fs.existsSync(frontendRoutesPath) ? fs.readFileSync(frontendRoutesPath, 'utf8') : '';
    if (current !== text)
    {
        console.error('[frontend-routes] generated route constants drifted');
        process.exit(1);
    }
    console.log('[frontend-routes] ok');
}
else
{
    fs.mkdirSync(new URL('../../src/frontend/src/generated/', import.meta.url), { recursive: true });
    fs.writeFileSync(frontendRoutesPath, text);
    console.log(`[frontend-routes] wrote ${frontendRoutesPath}`);
}
