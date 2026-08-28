#!/usr/bin/env node

import { validateRuntimeStateDomainCatalog } from '../test-matrix/runtime-state-domain-catalog.mjs';

const errors = validateRuntimeStateDomainCatalog();
if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[runtime-state-domain] ${error}`);
    }
    process.exitCode = 1;
}
else
{
    console.log('[runtime-state-domain] ok');
    await import('../check-test-matrix.mjs');
}
